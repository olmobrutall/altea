
import { Entity, type PrimaryKey, type Type, type ViewType, type View } from "../data/entity";
import { CallExpression, ConstantExpression, Expression, PropertyExpression, ParameterExpression, LambdaExpression } from "./linq/expressions";
import { Retriever } from "./linq/Retriever";
import { quotedFunction, type IQueryTranslator, Query } from "./query";
import { ArrayType, FunctionType, ClassType, RuntimeType, LiteralType } from "./runtimeTypes";
import type { Lite } from "../data/lite";
import { OverloadingSimplifier } from "./linq/visitors/OverloadingSimplifier";
import { Connector } from "./connection/connector";
import { QueryBinder } from "./linq/visitors/QueryBinder";
import { AggregateRewriter } from "./linq/visitors/AggregateRewriter";
import { OrderByRewriter } from "./linq/visitors/OrderByRewriter";
import { QueryRebinder } from "./linq/visitors/QueryRebinder";
import { RedundantSubqueryRemover } from "./linq/visitors/RedundantSubqueryRemover";
import { RedundantJoinRemover } from "./linq/visitors/RedundantJoinRemover";
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
import { TypeLogic, type TypeCaches } from "./typeLogic";
import type { Schema } from "./schema/schema";
import type { QueryFilterContext } from "./schema/entityEvents";
import { HeavyProfiler } from "./profiler/heavyProfiler";
import type { CacheController } from "./cache";



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

export function table<T extends Entity>(entityType: Type<T>): Query<T> {
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
export function view<T extends View>(viewType: ViewType<T>): Query<T> {
    const arrayType = new ArrayType(new ClassType(viewType));
    const callExpression = new CallExpression(
        new ConstantExpression(view, new FunctionType(view, arrayType)),
        [new ConstantExpression(viewType, new FunctionType(viewType, new ClassType(viewType)))],
        arrayType,
    );
    return new Query<T>(callExpression, MyQueryTranslator.instance);
}

// Start a top-level query whose source is a table-valued @sqlMethod marker (e.g. GetDatesInRange).
// Mirrors table()/view() but the root CallExpression targets the branded TVF function, so the
// QueryBinder lowers it via bindSqlMethod → bindTableValuedFunction (Signum's
// `new Query<DateValue>(provider, Expression.Call(GetDatesInRange, …))`). `viewType` is the row
// IView; `args` become the function's SQL arguments (parametrised).
export function sqlMethodQuery<T extends View>(marker: Function, viewType: ViewType<T>, args: unknown[]): Query<T> {
    const arrayType = new ArrayType(new ClassType(viewType));
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
export function bindAndOptimize(expression: Expression, schema: Schema, isPostgres: boolean, alreadySimplified = false, filterContext?: QueryFilterContext, typeCaches: TypeCaches | undefined = schema.typeCaches.valueOrUndefined): ProjectionExpression {
    // `alreadySimplified` skips the OverloadingSimplifier for a hand-built expression (the
    // batch-retrieve query): it already uses only core operators (filter/contains), so there's
    // no sugar/methodExpander to lower.
    // `filterContext` carries row-level security (Signum's FilterQuery), resolved async by the caller
    // BEFORE translation and read synchronously by the binder's queryFilter handlers.
    // `typeCaches` is the type↔id snapshot resolved at the LINQ boundary (undefined only while loading);
    // threaded into the binder so @implementedByAll discriminators bind against an explicit cache.
    // Profiler: the whole translate under a "LINQ" span, with each optimiser pass timed as a switched
    // sibling under a "Clean" span — mirrors Signum's DbQueryProvider.Translate/Optimize instrumentation
    // (Log("LINQ") + LogNoStackTrace("Clean").Switch(...) chain). No-op (undefined) when disabled.
    using _linq = HeavyProfiler.log("LINQ", () => expression.toString());
    using log = HeavyProfiler.logNoStackTrace("OvrLdSmp");
    const simplified = alreadySimplified ? expression : OverloadingSimplifier.simplify(expression);
    const binder = new QueryBinder(schema, isPostgres, filterContext, typeCaches);
    log?.switch("Bind");
    let projection: Expression = binder.bindQuery(simplified);
    // Hoist deferred group aggregates (g.elements.sum()…) into their GROUP BY select as
    // columns — Signum runs AggregateRewriter first in Optimize.
    log?.switch("Aggregate");
    projection = AggregateRewriter.rewrite(projection);
    log?.switch("OrderBy");
    projection = OrderByRewriter.rewrite(projection);
    // A versioned table under a per-row AsOfExpression (a dynamic AS OF whose instant is a column —
    // a time-series query) is rewritten to `FOR SYSTEM_TIME ALL WHERE period.contains(expr)` on
    // BOTH dialects (SQL Server's FOR SYSTEM_TIME AS OF can't take a column). Runs EARLY (Signum's
    // order: before the rebinder), so the AS OF's outer-column reference is exposed before the join
    // correlation is finalised — else a correlated flatMap renders as a plain (non-LATERAL) join.
    // DuplicateHistory (Postgres, below) later turns the ALL into the history UNION.
    log?.switch("AsOfExpression");
    projection = AsOfExpressionVisitor.rewrite(projection, binder.aliases);
    log?.switch("Rebinder");
    projection = QueryRebinder.rebind(projection);
    // Drop columns (and dead single-row joins) no enclosing scope references — Signum
    // runs UnusedColumnRemover here, right before collapsing redundant subqueries.
    log?.switch("UnusedColumn");
    projection = UnusedColumnRemover.remove(projection);
    log?.switch("Redundant");
    projection = RedundantSubqueryRemover.remove(projection, isPostgres);
    // Merge identical entity-completion joins (e.g. `label.toLite()` + `label.name` → one Label join)
    // now that subquery collapse has settled both onto the same owner FK.
    log?.switch("RedundantJoin");
    projection = RedundantJoinRemover.remove(projection) as ProjectionExpression;
    if (!isPostgres) {
        log?.switch("Condition");
        projection = ConditionsRewriter.rewrite(projection);
    }
    // SQL Server can't aggregate over a scalar subquery — lift those to OUTER APPLYs
    // (no-op on Postgres, which allows scalar subqueries in aggregates).
    log?.switch("Scalar");
    projection = ScalarSubqueryRewriter.rewrite(projection, isPostgres);
    if (!(projection instanceof ProjectionExpression))
        throw new Error("Optimiser pipeline did not preserve the ProjectionExpression");
    // Eager-load nested projections (e.g. map(l => …toArray())) as separate child
    // queries, then re-clean the selects the flattener introduced.
    log?.switch("ChPrjFlatt");
    const flattened = ChildProjectionFlattener.flatten(projection, binder.aliases);
    let result = RedundantSubqueryRemover.remove(flattened, isPostgres) as ProjectionExpression;
    // Postgres has no native FOR SYSTEM_TIME: rewrite each versioned table under a SystemTime
    // scope into a UNION ALL of the main + history tables with a period predicate (Signum's
    // DuplicateHistory, Postgres-only). Runs LAST, after the optimisers: a union spliced as a
    // SELECT's direct FROM doesn't survive UnusedColumnRemover's column pruning (it collapses to
    // undefined columns), so we rewrite once the column set is settled. The union over-projects
    // all physical columns, which is valid (just slightly wider SQL) since the enclosing SELECT
    // was already pruned. Present-only queries (no override) are untouched.
    if (isPostgres) {
        log?.switch("DupHistory");
        result = DuplicateHistory.rewrite(result, binder.aliases) as ProjectionExpression;
    }
    return result;
}

// LINQ-provider translate with row-level security resolved: await the schema's QueryFilterContext (Signum's
// FilterQuery args) and bind+optimize with it. THE single place row-security is requested — so consumers
// (the ORM translator, dynamic queries) call this and never touch the QueryFilterContext themselves.
export async function bindOptimizeSecured(expression: Expression, schema: Schema, isPostgres: boolean, alreadySimplified = false): Promise<ProjectionExpression> {
    // Resolve the type↔id caches ONCE (async) at this boundary — undefined only if we're inside the
    // caches' own load (re-entrant `table(TypeEntity)`), where no discriminator arises. `ready()` also
    // warms the box for the downstream sync readers (optimiser visitors, Retriever).
    const typeCaches = TypeLogic.isLoading ? undefined : await TypeLogic.ready(schema);
    const filterContext = await schema.buildQueryFilterContext();
    return bindAndOptimize(expression, schema, isPostgres, alreadySimplified, filterContext, typeCaches);
}

// Binds `table(ctor).filter(e => ids.includes(e.id))` — the shared shape behind both the
// Retriever's batch stub-completion and Database.retrieveList. The predicate is hand-built
// (no quoted lambda needed at runtime); the captured id array is a ConstantExpression the
// binder lowers to an `IN (…)`.
function retrieveByIdsProjection(ctor: Type<Entity>, ids: PrimaryKey[], filterContext?: QueryFilterContext, typeCaches?: TypeCaches): ProjectionExpression {
    const connector = Connector.current();
    const q = table(ctor);
    const param = new ParameterExpression("e", q.elementType);
    const predicate = new LambdaExpression([param],
        new CallExpression(new PropertyExpression(new ConstantExpression(ids), "includes"),
            [new PropertyExpression(param, "id")], LiteralType.boolean));
    const filterExpr = new CallExpression(new PropertyExpression(q.expression, "filter"), [predicate], q.type);
    // Run the full simplifier (as the normal query path does): the OverloadingSimplifier is what
    // establishes the default entity projection — skipping it yielded an empty SELECT column list.
    return bindAndOptimize(filterExpr, connector.schema, connector.isPostgres, false, filterContext, typeCaches);
}

// Signum's Database.RetrieveList, injected into the Retriever (which can't import the
// query pipeline). Batch-loads `ctor` rows whose id is in `ids` into the SAME retriever,
// so the id-only stubs it left behind get populated in place.
Retriever.retrieveListImpl = async (ctor: Type<Entity>, ids: PrimaryKey[], retriever: Retriever): Promise<void> => {
    const connector = Connector.current();
    const typeCaches = TypeLogic.isLoading ? undefined : await TypeLogic.ready(connector.schema);
    const filterContext = await connector.schema.buildQueryFilterContext();
    await buildTranslateResult(retrieveByIdsProjection(ctor, ids, filterContext, typeCaches), connector.isPostgres).executeInto(retriever);
};

// The DISPLAY-STRING projection behind `Retriever.completeLiteToStrings` (Signum's RequestLite completion):
// one query per type that reads only each row's own name. `map(e => e.toLite())` is a lite projection, so the
// SELECT is the id plus the `to_str` column (or the lowered `@quoted toString()`) — never the whole row.
//
// It runs on its OWN retriever (the caller's is mid-completion, and these rows are not what the caller
// asked for) and with the caller's rights, so the row-level filter applies as usual.
Retriever.liteListImpl = async (ctor: Type<Entity>, ids: PrimaryKey[]): Promise<Lite<Entity>[]> => {
    return await table(ctor).filter(e => ids.includes(e.id)).map(e => e.toLite()).toArray();
};

// Materialise the `ctor` rows whose id is in `ids` from a CACHE CONTROLLER instead of the database —
// Signum's `Database.Retrieve` under a cache controller (`EntityCache.NewRetriever()` → Request →
// CompleteAll). A FRESH instance per call (the cache hands out rows, never its own entities, so a caller
// may mutate and save what it gets); nested references are stubbed and drained — from their own cache when
// they are cached too, from the database when they are not — and `postRetrieved` fires at the end, so the
// `Retrieved` handlers AND the global retrieve gates (the type-READ authorization gate) apply to a cached
// read exactly as to a queried one.
//
// It lives HERE, not in Database.ts, purely to keep the module graph acyclic: `Retriever.retrieveListImpl`
// above is assigned at THIS module's top level, so a module that imports Retriever before table.ts would
// hit it mid-initialisation (a TDZ error). table.ts already owns that edge.
export async function retrieveEntitiesFromCache<T extends Entity>(
    ctor: Type<T>,
    ids: PrimaryKey[],
    controller: CacheController,
): Promise<T[]> {
    const retriever = new Retriever();
    const result: T[] = [];
    for (const id of ids) {
        if (!controller.exists(id))
            continue;
        const e = retriever.entity(ctor as unknown as Type<Entity>, id, e2 => controller.complete(e2, retriever));
        if (e != null)
            result.push(e as T);
    }
    await retriever.completeAll();
    await retriever.postRetrieved();
    return result;
}

// Materialise the `ctor` rows whose id is in `ids` (a single `WHERE id IN (…)` query) as a
// fresh list. The DB half of Database.retrieveList — order/missing handling and chunking
// live there. Returns [] for an empty id list without touching the database.
export async function retrieveEntitiesByIds<T extends Entity>(ctor: Type<T>, ids: PrimaryKey[]): Promise<T[]> {
    if (ids.length === 0)
        return [];
    const connector = Connector.current();
    const typeCaches = TypeLogic.isLoading ? undefined : await TypeLogic.ready(connector.schema);
    const filterContext = await connector.schema.buildQueryFilterContext();
    return await buildTranslateResult(retrieveByIdsProjection(ctor, ids, filterContext, typeCaches), connector.isPostgres).execute() as T[];
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
        // SYNCHRONOUS bind (debug SQL / offline comparison): can't await; bindAndOptimize's default reads
        // the already-loaded caches box (warm in production; offline binders seed it — the test layer's seedTypeCachesForTest).
        return bindAndOptimize(expression, connector.schema, connector.isPostgres);
    }

    async execute(expression: Expression): Promise<unknown> {
        // "DBQuery" wraps translate + execute (Signum's DbQueryProvider.Execute). The nested "LINQ" and
        // "SQL" spans (bindAndOptimize / connector.withLogging) hang under it.
        using _prof = HeavyProfiler.log("DBQuery", () => expression.toString());
        const connector = Connector.current();
        // Row-level security + the type↔id snapshot are both resolved (async) inside bindOptimizeSecured,
        // which also warms the caches box for the downstream sync readers (optimiser visitors, Retriever).
        const projection = await bindOptimizeSecured(expression, connector.schema, connector.isPostgres);
        const tr = buildTranslateResult(projection, connector.isPostgres);
        return tr.execute();
    }

    // Bulk-DML pipeline: bind to a CommandExpression, run the same optimiser tier as
    // queries (so the source SELECT is cleaned/condition-normalised), DELETE-simplify
    // for SQL Server, format, and execute returning the affected row count scalar.
    async executeCommand(expression: Expression): Promise<number> {
        using _prof = HeavyProfiler.log("DBQuery", () => expression.toString());
        const connector = Connector.current();
        const typeCaches = TypeLogic.isLoading ? undefined : await TypeLogic.ready(connector.schema);
        // Row-level security applies to the SELECT that feeds an unsafe UPDATE/DELETE too (you may only
        // touch rows you can see): resolve the context async, then bind the command with it.
        const filterContext = await connector.schema.buildQueryFilterContext();
        const simplified = OverloadingSimplifier.simplify(expression);
        const binder = new QueryBinder(connector.schema, connector.isPostgres, filterContext, typeCaches);
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
