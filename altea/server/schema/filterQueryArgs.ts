import { Expression, CallExpression, ConstantExpression, LambdaExpression, ParameterExpression, PropertyExpression } from "../linq/expressions";
import { ExpressionVisitor } from "../linq/visitors/ExpressionVisitor";
import { LiteralType, ArrayType, ClassType } from "../runtimeTypes";
import type { Entity, Type } from "../../data/entity";
import type { Lite } from "../../data/lite";

// Port of Signum's `FilterQueryArgs` (Engine/Schema/EntityEvents.cs) — WHAT THE CALLER ASKED FOR, handed
// to a row-level filter so the filter can inspect it.
//
//     table(OperationLogEntity).filter(ol => ol.target.is(myInvoice))
//     |<----------------------------- fullQuery ------------------------------>|
//     |<--------- baseQuery -------->|
//                                    ^ this is where the security WHERE is spliced in
//
// Almost every row filter ignores it: "which rows may this role read" is a property of the role, not of
// the query. The exception is Signum's `RegisterWhenAlreadyFilteringBy`, whose whole premise is that the
// CALLER has already constrained the rows — "you may read an operation log if you are looking at the logs
// OF ONE ENTITY you are allowed to read" — which can only be answered by reading the caller's own filters.
// See @altea/altea-auth's QueryAuditorVisitor.

export class FilterQueryArgs {
    constructor(
        /** The whole query being translated (the binder's `root`). */
        readonly fullQuery: Expression,
        /** The `table(T)` node inside it that the filter is being spliced onto. */
        readonly baseQuery: Expression,
    ) { }

    /**
     * Signum's `FromQuery(similarQuery)` — args for a query that is NOT being translated, built so a
     * filter can be evaluated outside the binder (the in-memory / per-entity paths). The query is never
     * executed; only its SHAPE is read.
     */
    static fromQuery(fullQuery: Expression): FilterQueryArgs {
        return new FilterQueryArgs(fullQuery, findBaseQuery(fullQuery));
    }

    /** Signum's `FromFilter<T>(filter)` — `table(T).filter(<filter>)`. */
    static fromFilter<T extends Entity>(ctor: Type<T>, filter: LambdaExpression | undefined): FilterQueryArgs {
        const source = querySourceCall(ctor);
        const full = filter == null ? source
            : new CallExpression(new PropertyExpression(source, "filter"), [filter], source.type);
        return new FilterQueryArgs(full, source);
    }

    /** Signum's `FromLite(lite)` — `table(T).filter(e => e.is(lite))`. */
    static fromLite<T extends Entity>(lite: Lite<T>): FilterQueryArgs {
        const ctor = lite.entityType as unknown as Type<T>;
        return FilterQueryArgs.fromFilter(ctor, isFilterLambda(ctor, lite));
    }

    /** Signum's `FromEntity(entity)` — `table(T).filter(e => e.is(entity))`. */
    static fromEntity<T extends Entity>(entity: T): FilterQueryArgs {
        const ctor = entity.constructor as Type<T>;
        return FilterQueryArgs.fromFilter(ctor, isFilterLambda(ctor, entity));
    }
}

// `e => e.is(<constant>)` — the shape both FromLite and FromEntity build.
function isFilterLambda<T extends Entity>(ctor: Type<T>, value: Lite<T> | T): LambdaExpression {
    const param = new ParameterExpression("e", new ClassType(ctor));
    return new LambdaExpression([param],
        new CallExpression(new PropertyExpression(param, "is"), [new ConstantExpression(value)], LiteralType.boolean));
}

/**
 * The `table(T)` call node inside a query expression (Signum's `FindBaseQueryVisitor`), which is the node
 * a row filter is spliced onto. Throws when there is none, or more than one — as Signum does: a filter
 * whose meaning depends on the caller's query cannot be resolved against two sources at once.
 */
export function findBaseQuery(query: Expression): Expression {
    const found = findQuerySources(query);
    if (found.length === 0)
        throw new Error("FilterQueryArgs: no base query (no table(T) source) found in " + query.toString());
    if (found.length > 1)
        throw new Error("FilterQueryArgs: more than one base query found in " + query.toString());
    return found[0];
}

/** Every `table(T)` / `view(T)` source node in an expression, in visit order. */
export function findQuerySources(query: Expression): CallExpression[] {
    const finder = new QuerySourceFinder();
    finder.visit(query);
    return finder.found;
}

/** True for the `table(T)` / `view(T)` call node the QueryBinder treats as a query SOURCE. */
export function isQuerySourceCall(node: Expression): node is CallExpression {
    return node instanceof CallExpression
        && node.func instanceof ConstantExpression
        && (node.func.value as { __isQuerySource?: boolean } | null)?.__isQuerySource === true;
}

/** The entity/view constructor a query-source node reads from. */
export function querySourceCtor(node: CallExpression): Function {
    return (node.args[0] as ConstantExpression).value as Function;
}

class QuerySourceFinder extends ExpressionVisitor {
    readonly found: CallExpression[] = [];
    override visitCall(node: CallExpression): Expression {
        if (isQuerySourceCall(node)) {
            this.found.push(node);
            return node;
        }
        return super.visitCall(node);
    }
}

// ---- the query root, late-bound ------------------------------------------------------------------------
//
// `table()` lives in the QUERY layer, which imports this layer — so this file cannot import it back
// without a module cycle in the engine's hottest path. `table.ts` registers itself here on load instead,
// which is the same accommodation `cultureInfoEntity.setCultureNameResolver` makes.

let querySourceFactory: ((ctor: Function) => CallExpression) | undefined;

/** Called once by `server/table.ts` — see the note above. */
export function setQuerySourceFactory(factory: (ctor: Function) => CallExpression): void {
    querySourceFactory = factory;
}

function querySourceCall(ctor: Function): CallExpression {
    if (querySourceFactory == null)
        throw new Error("FilterQueryArgs: the query source factory is not registered — import '@altea/altea/server/table' first.");
    return querySourceFactory(ctor);
}

// Re-exported for the factory's own use (it builds an ArrayType(ClassType(ctor)) source).
export { ArrayType, ClassType };
