import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Saver } from "@altea/altea/server/saver";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import type { QueryExecutedContext } from "@altea/altea/server/dynamicQuery/dynamicQueryContainer";
import { withQuoted } from "@altea/altea/data/decorators";
import { Clock } from "@altea/altea/data/utils/clock";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { IQuery } from "@altea/altea/data/iquery";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { ViewLogEntity, ViewLogMessage, type IViewLogTarget } from "../data/ViewLog";

// Port of Signum.ViewLog's ViewLogLogic.cs — the module IS one table plus three subscriptions: "the API
// handed out an entity", "a query ran", and the two navigations that let any type's search page ask
// "who looked at this one?".
//
// altea divergences:
//  - **the two core seams are HANDLERS RETURNING AN AFTER CALLBACK**, not events returning an IDisposable:
//    `ExecutionMode.onApiRetrieved` and `QueryLogic.queries.queryExecuted`, both added for this module in
//    the shape `OperationLogic.surroundOperation` established. Signum's `ExecuteType` argument goes with
//    it — altea funnels every read through one `executeQueryAsync`, so there is nothing to discriminate.
//  - **the SQL arrives through the seam, captured by an ASYNC-LOCAL sink** (`Connector.withSqlCapture`,
//    opened by the query container). Signum swaps the process-wide `Connector.CurrentLogger` for a
//    StringWriter for the duration of one query, which is racy on a server running concurrent work — that
//    StringWriter sees every OTHER query's SQL too. Its `DuplicateTextWriter` (so an existing logger keeps
//    working) is unnecessary here: the sink is additive and leaves `currentLogger` alone.
//  - **the row is saved INLINE, awaited**, where Signum fires a detached `Task.Factory.StartNew` so the
//    request does not wait for the log write. A floating promise in Node is an unhandled rejection waiting
//    to happen and races process exit; the write is one INSERT in its own transaction, and the response has
//    already been sent by the time the after-half runs.
//  - **`registerExpressions` is per CONCRETE type** (Signum hangs its two extension methods off `Entity`
//    itself): altea keys an extension token on a constructor and the token walk follows the concrete
//    prototype chain — the same accommodation altea-alert's `registerExpressions` makes.
//  - **`ViewLogMyLast` stays a QUERY** rather than Signum's single-row `FirstOrDefault()`: altea's
//    registered expressions are projections, and there is no single-entity extension token. It is narrowed
//    to the current user, so the sub-token a search page offers reads "LastViewLog.Any.…".
//  - NOT ported: `ExceptionLogic.DeleteLogs` (altea has no log-retention machinery — the note every other
//    module carries) and `EntityEvents<TypeEntity>.PreDeleteSqlSync` (no such schema event, so deleting a
//    TypeEntity row does not sweep this table's `@implementedByAll` orphans).
//
// KNOWN GAP (core, pre-existing): an `@implementedByAll` column stores only (id, typeId), so a query hands
// back a lite with NO display string — Signum fills it with one batched query per type
// (`IRetriever.RequestLite`), which altea does not do. `Lite.toString()` therefore falls back to
// "<NiceName> <id>", so the `target` column reads "Order 10248" / "Query 6" rather than the row's own
// toString. It affects `OperationLogEntity.target` identically and predates this module.
//
// REACHABILITY: of the three "a client looked at this asset" scopes Signum reports, only the DASHBOARD ones
// are reachable in altea — `UserQueriesLogic.retrieveUserQuery` / `UserChartLogic.retrieveUserChart` are
// cache-hit fast paths nothing routes to, because altea's SPA fetches a user asset through the generic
// `/api/entity/…`. Those views are still logged, under `EntitiesController.GetEntity`.
export namespace ViewLogLogic {

    /** Signum's `LogType` — which entity types are worth logging. Default: all. */
    export let logType: (type: Type<Entity>) => boolean = () => true;

    /** Signum's `LogQuery` — which query requests are worth logging. Default: all. */
    export let logQuery: (ctx: QueryExecutedContext) => boolean = () => true;

    /**
     * Signum's `GetQueryData` — what goes in the row's `data`. Default: the query key, the request, and the
     * SQL the run actually executed (Signum's `request.QueryUrl + "\n\n" + sw.ToString()`).
     */
    export let getQueryData: (ctx: QueryExecutedContext, statements: readonly string[]) => string =
        (ctx, statements) =>
            `${getKey(ctx.queryName)}\n\n${JSON.stringify(ctx.request, tokensAsKeys, 2)}\n\n${statements.join("\n\n")}`;

    /** Signum's `IsStarted`: `logView` stands down entirely until the module is started. */
    export let isStarted = false;

    export function start(sb: SchemaBuilder, options?: { registerExpressionsFor?: Type<Entity>[] }): void {
        if (sb.alreadyDefined(start))
            return;

        isStarted = true;

        sb.include(ViewLogEntity).withQuery();

        // The log's own Duration column (Signum gets it from `[AutoExpressionField]` on the member).
        QueryLogic.expressions.register(ViewLogEntity, e => e.durationMilliseconds(),
            { key: "Duration", niceName: () => ViewLogEntity.nicePropertyName(e => e.durationMilliseconds()) });

        for (const type of options?.registerExpressionsFor ?? [])
            registerExpressions(type);

        // "The API handed this entity to a client" (Signum's ExecutionMode.OnApiRetrieved).
        ExecutionMode.onApiRetrieved.push((lite, viewAction) => logView(lite, viewAction));

        // "A query ran" (Signum's QueryLogic.Queries.QueryExecuted).
        QueryLogic.queries.queryExecuted.push(onQueryExecuted);
    }

    /** Signum's two `QueryLogic.Expressions.Register(new ExtensionInfo(t, …))` calls — see the header. */
    export function registerExpressions<T extends Entity>(type: Type<T>): void {
        const proto = (type as unknown as { prototype: Record<string, unknown> }).prototype;

        proto.viewLogs = withQuoted(function (this: Entity): IQuery<ViewLogEntity> {
            return table(ViewLogEntity).filter(log => log.target.is(this));
        });
        proto.viewLogMyLast = withQuoted(function (this: Entity): IQuery<ViewLogEntity> {
            return table(ViewLogEntity).filter(log =>
                log.target.is(this) && log.user.is(UserHolder.currentUserLite()));
        });

        QueryLogic.expressions.register(type, (e: IViewLogTarget) => e.viewLogs!(),
            { key: "ViewLogs", niceName: () => ViewLogEntity.nicePluralName() });
        QueryLogic.expressions.register(type, (e: IViewLogTarget) => e.viewLogMyLast!(),
            { key: "LastViewLog", niceName: () => ViewLogMessage.ViewLogMyLast.niceToString() });
    }

    /**
     * Signum's `LogView(entity, viewAction)`. Returns the "after" half — the row is written once the
     * caller's scope closes, which is what makes `endDate` mean "when the client got its answer".
     * `undefined` (log nothing) when the module is not started, there is no current user, or the type opted
     * out: Signum's same three guards.
     *
     * Public because the modules Southwind registers expressions for report their OWN scopes through it
     * (`ViewLogLogic.LogView(userQuery, "UserQuery")` in Signum.UserQueries, and the equivalents in
     * Signum.Dashboard / Signum.Chart).
     */
    export function logView(target: Lite<Entity>, viewAction: string): (() => Promise<void>) | undefined {
        if (!isStarted || target == null)
            return undefined;

        const user = UserHolder.currentUserLite();
        if (user == null)
            return undefined;

        if (!logType(target.entityType as Type<Entity>))
            return undefined;

        const log = ViewLogEntity.create({ target, user, viewAction, startDate: Clock.now });

        return async () => {
            log.endDate = Clock.now;
            await save(log);
        };
    }

    function onQueryExecuted(ctx: QueryExecutedContext): ((statements: readonly string[]) => Promise<void>) | undefined {
        if (!logQuery(ctx))
            return undefined;

        const user = UserHolder.currentUserLite();
        if (user == null)
            return undefined;

        const startDate = Clock.now;

        // Everything that touches the database happens in the AFTER half: the before half runs while the
        // observed query is about to execute, and issuing a read there would share its pinned connection
        // (node-postgres warns, and a second statement on a busy client is undefined behaviour).
        return async statements => {
            // Signum logs the QUERY as the target: `QueryLogic.GetQueryEntity(queryName).ToLite()`, which
            // reads its in-memory key→QueryEntity cache (`QueryNameToEntity`). altea loads that same cache
            // at `schema.initialize()`, so this is a map lookup rather than the `table(QueryEntity)` read it
            // used to be — that one fired on EVERY observed query, i.e. once per search, and showed up as an
            // extra round-trip per request in the heavy profiler.
            const query = QueryLogic.tryGetQueryEntityByKey(getKey(ctx.queryName));
            if (query == null)
                return;

            const log = ViewLogEntity.create({
                target: query.toLite(),
                user,
                viewAction: "ExecuteQuery",
                startDate,
                endDate: Clock.now,
            });
            log.data.text = getQueryData(ctx, statements);
            await save(log);
        };
    }

    /** The rows written here never join the caller's transaction (Signum's same `Transaction.ForceNew`). */
    async function save(log: ViewLogEntity): Promise<void> {
        try {
            await Transaction.forceNew(() => ExecutionMode.global(() => Saver.save([log])));
        } catch (e) {
            // Logging a view must never fail the request it observed.
            try { await Transaction.forceNew(() => ExceptionLogic.logException(e)); } catch { /* never mask */ }
        }
    }

    // `JSON.stringify` over a parsed QueryRequest would walk cyclic QueryTokens (a token holds its parent).
    // Tokens print as their key; everything else passes through untouched.
    function tokensAsKeys(_key: string, value: unknown): unknown {
        const t = value as { fullKey?: () => string } | null;
        return t != null && typeof t.fullKey === "function" ? t.fullKey() : value;
    }
}
