
import { Entity, type PrimaryKey } from "../entities/entity";
import { CallExpression, ConstantExpression, Expression, PropertyExpression, ParameterExpression, LambdaExpression } from "./linq/expressions";
import { Retriever } from "./linq/Retriever";
import { quotedFunction, type IQueryTranslator, Query } from "./query";
import { ArrayType, FunctionType, ClassType, RuntimeType, LiteralType } from "../entities/runtimeTypes";
import { OverloadingSimplifier } from "./linq/visitors/OverloadingSimplifier";
import { Connector } from "./connection/connector";
import { QueryBinder } from "./linq/visitors/QueryBinder";
import { AggregateRewriter } from "./linq/visitors/AggregateRewriter";
import { OrderByRewriter } from "./linq/visitors/OrderByRewriter";
import { QueryRebinder } from "./linq/visitors/QueryRebinder";
import { RedundantSubqueryRemover } from "./linq/visitors/RedundantSubqueryRemover";
import { UnusedColumnRemover } from "./linq/visitors/UnusedColumnRemover";
import { ConditionsRewriter } from "./linq/visitors/ConditionsRewriter";
import { ScalarSubqueryRewriter } from "./linq/visitors/ScalarSubqueryRewriter";
import { ChildProjectionFlattener } from "./linq/visitors/ChildProjectionFlattener";
import { DuplicateHistory } from "./linq/visitors/DuplicateHistory";
import { AsOfExpressionVisitor } from "./linq/visitors/AsOfExpressionVisitor";
import { CommandSimplifier } from "./linq/visitors/CommandSimplifier";
import { ProjectionExpression, CommandExpression, CommandAggregateExpression } from "./linq/expressions.sql";
import { buildTranslateResult } from "./linq/translatorBuilder";
import { QueryFormatter } from "./linq/queryFormatter";
import type { Schema } from "./schema/schema";



declare global {
    interface Promise<T> {
        get $v(): T;
    }
}

if (!Object.prototype.hasOwnProperty.call(Promise.prototype, "$v")) {
    Object.defineProperty(Promise.prototype, "$v", {
        configurable: true,
        enumerable: false,
        get(this: Promise<unknown>): unknown {
            throw new Error("Promise.$v is a query-compiler marker and should not be evaluated at runtime.");
        }
    });
}

export function table<T extends Entity>(entityType: { new(): T }): Query<T> {
    var arrayType = new ArrayType(new ClassType(entityType));
    var callExpression = new CallExpression(
        new ConstantExpression(table, new FunctionType(table, arrayType)),
        [new ConstantExpression(entityType, new FunctionType(entityType, new ClassType(entityType)))],
        arrayType
    );
    return new Query<T>(callExpression, MyQueryTranslator.instance);
}

// `view(MyView)` — a query over a raw database view (Signum's Database.View<T>()). Mirrors
// `table()`, but the binder resolves the source via `schema.view()` (ViewBuilder) rather
// than `schema.table()`; the extra `__isViewSource` marker selects that path.
export function view<T>(viewType: { new(): T }): Query<T> {
    const arrayType = new ArrayType(new ClassType(viewType as any));
    const callExpression = new CallExpression(
        new ConstantExpression(view, new FunctionType(view, arrayType)),
        [new ConstantExpression(viewType, new FunctionType(viewType as any, new ClassType(viewType as any)))],
        arrayType,
    );
    return new Query<T>(callExpression, MyQueryTranslator.instance);
}

// Start a top-level query whose source is a table-valued @sqlMethod marker (e.g. GetDatesInRange).
// Mirrors table()/view() but the root CallExpression targets the branded TVF function, so the
// QueryBinder lowers it via bindSqlMethod → bindTableValuedFunction (Signum's
// `new Query<DateValue>(provider, Expression.Call(GetDatesInRange, …))`). `viewType` is the row
// IView; `args` become the function's SQL arguments (parametrised).
export function sqlMethodQuery<T>(marker: Function, viewType: new () => T, args: unknown[]): Query<T> {
    const arrayType = new ArrayType(new ClassType(viewType as any));
    const call = new CallExpression(
        new ConstantExpression(marker, new FunctionType(marker, arrayType)),
        args.map(a => new ConstantExpression(a)),
        arrayType,
    );
    return new Query<T>(call, MyQueryTranslator.instance);
}

quotedFunction(table).__resultType = (_, entityTypeType) => new ArrayType(new ClassType((entityTypeType as FunctionType).func!));
quotedFunction(view).__resultType = (_, viewTypeType) => new ArrayType(new ClassType((viewTypeType as FunctionType).func!));

// Marks `table` as a query source so the QueryBinder recognises the
// `ConstantExpression(table)` at the root of a query CallExpression chain.
(table as unknown as { __isQuerySource?: boolean }).__isQuerySource = true;

// `view` is also a query source; the extra `__isViewSource` flag tells the binder to
// resolve the ctor through `schema.view()` (a ViewBuilder-built view table) instead of
// `schema.table()`.
(view as unknown as { __isQuerySource?: boolean; __isViewSource?: boolean }).__isQuerySource = true;
(view as unknown as { __isViewSource?: boolean }).__isViewSource = true;

// Bind a source expression to a fully-optimised ProjectionExpression: the exact pipeline
// the runtime uses, factored out so tests (binder.test.ts) can observe the same
// post-optimiser shape the executor sees (not the raw pre-optimiser tree). Mirrors the
// relevant slice of Signum's DbQueryProvider.Optimize.
export function bindAndOptimize(expression: Expression, schema: Schema, isPostgres: boolean, alreadySimplified = false): ProjectionExpression {
    // `alreadySimplified` skips the OverloadingSimplifier for a hand-built expression (the
    // batch-retrieve query): it already uses only core operators (filter/contains), so there's
    // no sugar/methodExpander to lower.
    const simplified = alreadySimplified ? expression : OverloadingSimplifier.simplify(expression);
    const binder = new QueryBinder(schema, isPostgres);
    let projection: Expression = binder.bindQuery(simplified);
    // Hoist deferred group aggregates (g.elements.sum()…) into their GROUP BY select as
    // columns — Signum runs AggregateRewriter first in Optimize.
    projection = AggregateRewriter.rewrite(projection);
    projection = OrderByRewriter.rewrite(projection);
    // A versioned table under a per-row AsOfExpression (a dynamic AS OF whose instant is a column —
    // a time-series query) is rewritten to `FOR SYSTEM_TIME ALL WHERE period.contains(expr)` on
    // BOTH dialects (SQL Server's FOR SYSTEM_TIME AS OF can't take a column). Runs EARLY (Signum's
    // order: before the rebinder), so the AS OF's outer-column reference is exposed before the join
    // correlation is finalised — else a correlated flatMap renders as a plain (non-LATERAL) join.
    // DuplicateHistory (Postgres, below) later turns the ALL into the history UNION.
    projection = AsOfExpressionVisitor.rewrite(projection, binder.aliases);
    projection = QueryRebinder.rebind(projection);
    // Drop columns (and dead single-row joins) no enclosing scope references — Signum
    // runs UnusedColumnRemover here, right before collapsing redundant subqueries.
    projection = UnusedColumnRemover.remove(projection);
    projection = RedundantSubqueryRemover.remove(projection, isPostgres);
    if (!isPostgres)
        projection = ConditionsRewriter.rewrite(projection);
    // SQL Server can't aggregate over a scalar subquery — lift those to OUTER APPLYs
    // (no-op on Postgres, which allows scalar subqueries in aggregates).
    projection = ScalarSubqueryRewriter.rewrite(projection, isPostgres);
    if (!(projection instanceof ProjectionExpression))
        throw new Error("Optimiser pipeline did not preserve the ProjectionExpression");
    // Eager-load nested projections (e.g. map(l => …toArray())) as separate child
    // queries, then re-clean the selects the flattener introduced.
    const flattened = ChildProjectionFlattener.flatten(projection, binder.aliases);
    let result = RedundantSubqueryRemover.remove(flattened, isPostgres) as ProjectionExpression;
    // Postgres has no native FOR SYSTEM_TIME: rewrite each versioned table under a SystemTime
    // scope into a UNION ALL of the main + history tables with a period predicate (Signum's
    // DuplicateHistory, Postgres-only). Runs LAST, after the optimisers: a union spliced as a
    // SELECT's direct FROM doesn't survive UnusedColumnRemover's column pruning (it collapses to
    // undefined columns), so we rewrite once the column set is settled. The union over-projects
    // all physical columns, which is valid (just slightly wider SQL) since the enclosing SELECT
    // was already pruned. Present-only queries (no override) are untouched.
    if (isPostgres)
        result = DuplicateHistory.rewrite(result, binder.aliases) as ProjectionExpression;
    return result;
}

// Binds `table(ctor).filter(e => ids.contains(e.id))` — the shared shape behind both the
// Retriever's batch stub-completion and Database.retrieveList. The predicate is hand-built
// (no quoted lambda needed at runtime); the captured id array is a ConstantExpression the
// binder lowers to an `IN (…)`.
function retrieveByIdsProjection(ctor: new () => Entity, ids: PrimaryKey[]): ProjectionExpression {
    const connector = Connector.current();
    const q = table(ctor);
    const param = new ParameterExpression("e", q.elementType);
    const predicate = new LambdaExpression([param],
        new CallExpression(new PropertyExpression(new ConstantExpression(ids), "contains"),
            [new PropertyExpression(param, "id")], LiteralType.boolean));
    const filterExpr = new CallExpression(new PropertyExpression(q.expression, "filter"), [predicate], q.type);
    return bindAndOptimize(filterExpr, connector.schema, connector.isPostgres, /* alreadySimplified */ true);
}

// Signum's Database.RetrieveList, injected into the Retriever (which can't import the
// query pipeline). Batch-loads `ctor` rows whose id is in `ids` into the SAME retriever,
// so the id-only stubs it left behind get populated in place.
Retriever.retrieveListImpl = async (ctor: new () => Entity, ids: PrimaryKey[], retriever: Retriever): Promise<void> => {
    const connector = Connector.current();
    await buildTranslateResult(retrieveByIdsProjection(ctor, ids), connector.isPostgres).executeInto(retriever);
};

// Materialise the `ctor` rows whose id is in `ids` (a single `WHERE id IN (…)` query) as a
// fresh list. The DB half of Database.retrieveList — order/missing handling and chunking
// live there. Returns [] for an empty id list without touching the database.
export async function retrieveEntitiesByIds<T extends Entity>(ctor: new () => T, ids: PrimaryKey[]): Promise<T[]> {
    if (ids.length === 0)
        return [];
    const connector = Connector.current();
    return await buildTranslateResult(retrieveByIdsProjection(ctor, ids), connector.isPostgres).execute() as T[];
}

class MyQueryTranslator implements IQueryTranslator {

    static instance: IQueryTranslator = new MyQueryTranslator();

    // Pipeline: simplify (partial eval) → QueryBinder (source AST → DbExpression
    // tree, incl. navigation JOIN expansion) → OrderByRewriter (float ORDER BY up
    // to the outermost/TOP select, resolve Reverse) → QueryRebinder (rebind the
    // floated column refs through each select's exposed columns) →
    // RedundantSubqueryRemover (collapse/merge the pass-through selects) →
    // ConditionsRewriter (boolean condition/value normalisation; SQL Server only —
    // Postgres has a native boolean type so its variant is a near no-op). Mirrors
    // the relevant slice of Signum's DbQueryProvider.Optimize.
    bind(expression: Expression): ProjectionExpression {
        const connector = Connector.current();
        return bindAndOptimize(expression, connector.schema, connector.isPostgres);
    }

    execute(expression: Expression): Promise<unknown> {
        const projection = this.bind(expression);
        const tr = buildTranslateResult(projection, Connector.current().isPostgres);
        return tr.execute();
    }

    // Bulk-DML pipeline: bind to a CommandExpression, run the same optimiser tier as
    // queries (so the source SELECT is cleaned/condition-normalised), DELETE-simplify
    // for SQL Server, format, and execute returning the affected row count scalar.
    async executeCommand(expression: Expression): Promise<number> {
        const connector = Connector.current();
        const simplified = OverloadingSimplifier.simplify(expression);
        const binder = new QueryBinder(connector.schema, connector.isPostgres);
        const command = binder.bindCommand(simplified);

        // Each sub-command (owned-child deletes precede the parent) is optimised,
        // formatted, and executed as its OWN query: optimised separately so the
        // visitor passes start with fresh state per command — sub-commands can share a
        // source SELECT instance, and a shared OrderByRewriter pass would otherwise
        // accumulate its orderings across them. Executed separately because Postgres
        // rejects multiple parameterised statements in a single prepared query. Only
        // the row-count command (the last) yields the affected-row scalar.
        const commands = command instanceof CommandAggregateExpression ? command.commands : [command];
        let affected = 0;
        for (const cmd of commands) {
            let c: Expression = OrderByRewriter.rewrite(cmd);
            c = QueryRebinder.rebind(c);
            // Drop subquery columns no enclosing scope references (Signum runs
            // UnusedColumnRemover in Optimize for commands too) — so an update-part's
            // source SELECT projects only the correlation FK + the columns its SET values
            // read, not every column of the source entity.
            c = UnusedColumnRemover.remove(c);
            c = RedundantSubqueryRemover.remove(c, connector.isPostgres);
            if (!connector.isPostgres)
                c = ConditionsRewriter.rewrite(c);
            c = ScalarSubqueryRewriter.rewrite(c, connector.isPostgres);
            c = CommandSimplifier.simplify(c as CommandExpression, binder.aliases, connector.isPostgres);

            const { sql, parameters } = QueryFormatter.formatCommand(c as CommandExpression, connector.isPostgres);
            const rows = await connector.executeQuery(sql, parameters);
            const first = rows[0] as Record<string, unknown> | undefined;
            if (first != null)
                affected = Number(Object.values(first)[0] ?? affected);
        }
        return affected;
    }

    getQueryTextForDebug(query: Query<any>): string {
        const connector = Connector.current();
        const projection = this.bind(query.expression);
        const { sql, parameters } = QueryFormatter.format(projection.select, connector.isPostgres);
        return parameters.length ? `${sql}\n-- parameters: ${JSON.stringify(parameters)}` : sql;
    }
}

class TranslateResult {

    constructor(
        public query: string,
        public parameters: unknown[],
        public projector: (row: unknown) => unknown
    ) {

    }

    execute() {
        return Connector.current().executeQuery(this.query, this.parameters);
    }
}
