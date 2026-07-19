import { ObjectType } from "../../entities/runtimeTypes";
import {
    Expression, ParameterExpression, PropertyExpression, ConstantExpression, BinaryExpression,
    CallExpression, ObjectExpression, ConditionalExpression, UnaryExpression, CastExpression,
    LambdaExpression, evalBinaryOp, evalUnaryOp,
} from "../linq/expressions";
import { BuildExpressionContext, ExpressionBox } from "./tokens/queryToken";
import type { QueryToken } from "./tokens/queryToken";
import { Filter, Order, Column, OrderType, Pagination } from "./requests";
import { ResultColumn, ResultTable } from "./resultTable";

// Port of Signum's `DEnumerable<T>` / `DEnumerableCount<T>` (DynamicQuery/DQueryable.cs): the
// IN-MEMORY arm of the query pipeline. Where `DQueryable` composes a SQL query, `DEnumerable` holds
// already-materialised rows + the same BuildExpressionContext, so operations run in memory over the
// projected tuples. This is what an app uses to COMBINE sources (Southwind CustomersLogic:
// `(await persons).Concat(await companies).OrderBy(request.Orders).TryPaginate(request.Pagination)`).
//
// Signum compiles each token expression with Expression.Compile(); altea evaluates the (simple,
// post-select) tuple-accessor expressions with the small interpreter below — no codegen needed
// because after `select` every column token resolves to `tuple.cI`.
export class DEnumerable {
    constructor(
        public readonly collection: unknown[],
        public readonly context: BuildExpressionContext,
    ) { }

    where(filters: Filter[]): DEnumerable {
        if (filters.length === 0)
            return this;
        const predicate = (row: unknown) => filters.every(f => truthy(evalRow(f.getExpression(this.context), this.context.parameter, row)));
        return new DEnumerable(this.collection.filter(predicate), this.context);
    }

    orderBy(orders: Order[]): DEnumerable {
        if (orders.length === 0)
            return this;
        const keyed = this.collection.map(row => ({
            row,
            keys: orders.map(o => evalRow(o.token.buildExpression(this.context), this.context.parameter, row)),
        }));
        keyed.sort((a, b) => {
            for (let i = 0; i < orders.length; i++) {
                const c = compare(a.keys[i], b.keys[i]);
                if (c !== 0)
                    return orders[i].orderType === OrderType.Descending ? -c : c;
            }
            return 0;
        });
        return new DEnumerable(keyed.map(k => k.row), this.context);
    }

    // In-memory Select (Signum's SelectTupleConstructor): project each row into a { c0, c1, … } tuple
    // and return a context resolving each token to its slot.
    select(columns: (QueryToken | Column)[]): DEnumerable {
        const tokens = columns.map(c => c instanceof Column ? c.token : c);
        const rows = this.collection.map(row => {
            const t: Record<string, unknown> = {};
            tokens.forEach((tok, i) => { t["c" + i] = evalRow(tok.buildExpression(this.context), this.context.parameter, row); });
            return t;
        });
        const tupleParam = new ParameterExpression("_s", new ObjectType(Object.fromEntries(tokens.map((t, i) => ["c" + i, t.type]))));
        const replacements = new Map(tokens.map((t, i) => [t.fullKey(), new ExpressionBox(new PropertyExpression(tupleParam, "c" + i))]));
        return new DEnumerable(rows, new BuildExpressionContext(tupleParam.type, tupleParam, replacements));
    }

    // Signum's Concat: append another already-materialised result of the same shape.
    concat(other: DEnumerable): DEnumerable {
        return new DEnumerable([...this.collection, ...other.collection], this.context);
    }

    withCount(totalElements: number | undefined): DEnumerableCount {
        return new DEnumerableCount(this.collection, this.context, totalElements);
    }

    // Signum's DEnumerable.TryPaginate → a DEnumerableCount (page of rows + total).
    tryPaginate(pagination: Pagination): DEnumerableCount {
        if (pagination instanceof Pagination.Firsts)
            return new DEnumerableCount(this.collection.slice(0, pagination.topElements), this.context, undefined);
        if (pagination instanceof Pagination.Paginate) {
            const page = this.collection.slice(pagination.skip(), pagination.skip() + pagination.elementsPerPage);
            const total = (this.collection.length < pagination.elementsPerPage && pagination.currentPage === 1)
                ? this.collection.length : this.collection.length;
            return new DEnumerableCount(page, this.context, total);
        }
        return new DEnumerableCount(this.collection, this.context, this.collection.length); // All
    }

    // Materialise a ResultTable: one ResultColumn per token, values evaluated per row.
    toResultTable(columns: (QueryToken | Column)[], pagination: Pagination = new Pagination.All(), totalElements?: number): ResultTable {
        const tokens = columns.map(c => c instanceof Column ? c.token : c);
        const resultColumns = tokens.map(tok => {
            const values = this.collection.map(row => evalRow(tok.buildExpression(this.context), this.context.parameter, row));
            return new ResultColumn(tok, values);
        });
        return new ResultTable(resultColumns, totalElements ?? this.collection.length, pagination);
    }
}

export class DEnumerableCount extends DEnumerable {
    constructor(collection: unknown[], context: BuildExpressionContext, public readonly totalElements: number | undefined) {
        super(collection, context);
    }
    override concat(other: DEnumerable): DEnumerableCount {
        const otherTotal = other instanceof DEnumerableCount ? other.totalElements : undefined;
        const total = this.totalElements != undefined && otherTotal != undefined ? this.totalElements + otherTotal : undefined;
        return new DEnumerableCount([...this.collection, ...other.collection], this.context, total);
    }
    override toResultTable(columns: (QueryToken | Column)[], pagination: Pagination = new Pagination.All()): ResultTable {
        return super.toResultTable(columns, pagination, this.totalElements);
    }
}

// ---- Minimal in-memory expression interpreter ----------------------------------------------
// Handles the expression shapes tokens produce: parameter, member access, constants, binary/unary
// ops, conditionals, casts, object literals, and method calls. A lambda argument (e.g. the predicate
// of `.some`/`.every`) becomes a real JS closure that EXTENDS the environment — so a quantifier's
// element parameter and the outer row are both in scope, letting a FilterGroup any/all correlate
// element conditions with outer conditions in memory (`a.songs.some(s => s.name=='X' && a.year==20)`).
type Env = Map<ParameterExpression, unknown>;

export function evalExpr(expr: Expression, env: Env): unknown {
    if (expr instanceof ParameterExpression)
        return env.get(expr);
    if (expr instanceof ConstantExpression)
        return expr.value;
    if (expr instanceof CastExpression)
        return evalExpr(expr.expression, env);
    if (expr instanceof PropertyExpression) {
        const obj = evalExpr(expr.object, env);
        return obj == null ? undefined : (obj as Record<string, unknown>)[expr.propertyName];
    }
    if (expr instanceof UnaryExpression)
        return evalUnaryOp(expr.kind, evalExpr(expr.expression, env));
    if (expr instanceof BinaryExpression) {
        const l = evalExpr(expr.left, env);
        if (expr.kind === "&&") return truthy(l) ? evalExpr(expr.right, env) : l;
        if (expr.kind === "||") return truthy(l) ? l : evalExpr(expr.right, env);
        if (expr.kind === "??") return l != null ? l : evalExpr(expr.right, env);
        return evalBinaryOp(expr.kind, l, evalExpr(expr.right, env));
    }
    if (expr instanceof ConditionalExpression)
        return truthy(evalExpr(expr.condition, env)) ? evalExpr(expr.whenTrue, env) : evalExpr(expr.whenFalse, env);
    if (expr instanceof ObjectExpression) {
        const o: Record<string, unknown> = {};
        for (const [k, e] of Object.entries(expr.properties))
            o[k] = evalExpr(e, env);
        return o;
    }
    if (expr instanceof LambdaExpression)
        return makeClosure(expr, env);
    if (expr instanceof CallExpression && expr.func instanceof PropertyExpression) {
        const target = evalExpr(expr.func.object, env);
        // A lambda argument (`.some(p => …)`) becomes a closure over the current env; other args
        // evaluate normally.
        const args = expr.args.map(a => a instanceof LambdaExpression ? makeClosure(a, env) : evalExpr(a, env));
        const fn = (target as Record<string, unknown>)?.[expr.func.propertyName];
        if (typeof fn === "function")
            return (fn as (...a: unknown[]) => unknown).apply(target, args);
        return undefined;
    }
    throw new Error(`evalExpr: unsupported expression ${expr.constructor.name}`);
}

// A lambda → a JS function that binds its parameters into a child environment and evaluates the body
// (so `array.some(closure)` / `.every(closure)` run natively with the element bound).
function makeClosure(lambda: LambdaExpression, env: Env): (...vals: unknown[]) => unknown {
    return (...vals: unknown[]) => {
        const child: Env = new Map(env);
        lambda.parameters.forEach((p, i) => child.set(p, vals[i]));
        return evalExpr(lambda.body, child);
    };
}

// Evaluate an expression against a single-row context (the common case).
function evalRow(expr: Expression, param: ParameterExpression, row: unknown): unknown {
    return evalExpr(expr, new Map([[param, row]]));
}

function truthy(v: unknown): boolean { return !!v; }

function compare(a: unknown, b: unknown): number {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (a < (b as any)) return -1;
    if (a > (b as any)) return 1;
    return 0;
}
