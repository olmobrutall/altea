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
import { Temporal } from "@altea/altea/data/basics";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { IQuery } from "@altea/altea/data/iquery";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { ViewLogEntity, ViewLogMessage } from "../data/ViewLog";

// The module IS one table plus three subscriptions: "the API handed out an entity", "a query ran", and the
// two navigations that let any type's search page ask "who looked at this one?".
//
// It rests on three core seams added for it — `ExecutionMode.onApiRetrieved`,
// `DynamicQueryContainer.queryExecuted` and `Connector.withSqlCapture` — each a handler returning an AFTER
// callback. Other modules (altea-dashboard, -user-queries, -chart) report their own "a client looked at
// this" scopes through the first, which is what keeps this module optional.
//
// Port of Signum.ViewLog's ViewLogLogic.cs — see port/ViewLog.md.
export namespace ViewLogLogic {

    /** Which entity types are worth logging. Default: all. */
    export let logType: (type: Type<Entity>) => boolean = () => true;

    /** Which query requests are worth logging. Default: all. */
    export let logQuery: (ctx: QueryExecutedContext) => boolean = () => true;

    /**
     * What goes in the row's `data`. Default: the query key, the request, and the SQL the run actually
     * executed.
     */
    export let getQueryData: (ctx: QueryExecutedContext, statements: readonly string[]) => string =
        (ctx, statements) =>
            `${getKey(ctx.queryName)}\n\n${JSON.stringify(ctx.request, tokensAsKeys, 2)}\n\n${statements.join("\n\n")}`;

    /** `logView` stands down entirely until the module is started. */
    export let isStarted = false;

    export function start(sb: SchemaBuilder, options?: { registerExpressionsFor?: Type<Entity>[] }): void {
        if (sb.alreadyDefined(start))
            return;

        isStarted = true;

        sb.include(ViewLogEntity).withQuery();

        // The log's own Duration column. The caption is a MESSAGE: `nicePropertyName` resolves under
        // (declaring type, member), and a `@quoted` method is not a PropertyRoute here, so it has no
        // translatable <Member> entry and the call silently humanised to "Duration milliseconds" in every
        // culture — Signum's own label is the property `Duration`.
        QueryLogic.expressions.register(ViewLogEntity, e => e.durationMilliseconds(),
            ViewLogMessage.Duration);

        for (const type of options?.registerExpressionsFor ?? [])
            registerExpressions(type);

        // "The API handed this entity to a client".
        ExecutionMode.onApiRetrieved.push((lite, viewAction) => logView(lite, viewAction));

        // "A query ran".
        QueryLogic.queries.queryExecuted.push(onQueryExecuted);

        // Signum's `ExceptionLogic.DeleteLogs += ExceptionLogic_DeleteLogs`. One pass: a view log records
        // what was looked at, never a failure, so there is no exception cut-off.
        ExceptionLogic.registerDeleteLogs(async (parameters, ctx) => {
            const dateLimit = parameters.getDateLimitDelete(ViewLogEntity.toTypeEntity());
            if (dateLimit != null)
                await ExceptionLogic.deleteChunksLog(ViewLogEntity, table(ViewLogEntity)
                    .filter(v => Temporal.PlainDateTime.compare(v.startDate, dateLimit) < 0), parameters, ctx);
        });
    }

    /** Per CONCRETE type: an extension token is keyed on a constructor, and the walk follows the
     *  concrete prototype chain. */
    export function registerExpressions<T extends Entity>(type: Type<T>): void {
        QueryLogic.expressions.register(type, (e: Entity) => e.viewLogs!(),
            { niceName: () => ViewLogEntity.nicePluralName() });
        QueryLogic.expressions.register(type, (e: Entity) => e.lastViewLog!(),
            { niceName: () => ViewLogMessage.ViewLogMyLast.niceToString() });
    }

    /**
     * Returns the "after" half — the row is written once the caller's scope closes, which is what makes
     * `endDate` mean "when the client got its answer". `undefined` (log nothing) when the module is not
     * started, there is no current user, or the type opted out.
     *
     * Public because other modules report their OWN scopes through it — altea-dashboard's
     * `logView(dashboard, "Dashboard")`.
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
            // The QUERY is the target. A map lookup into the key→QueryEntity cache loaded at
            // `schema.initialize()`, NOT a `table(QueryEntity)` read: that one fired on EVERY observed
            // query, i.e. once per search, and showed up as a round-trip per request in the profiler.
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

    /** The rows written here never join the caller's transaction. */
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

// The bodies of the two expressions DECLARED in data/ViewLog (see there). Stamped ONCE on
// `Entity.prototype`; the per-type registration decides which types offer them as tokens.
Entity.prototype.viewLogs = withQuoted(function (this: Entity): IQuery<ViewLogEntity> {
    return table(ViewLogEntity).filter(log => log.target.is(this));
});

Entity.prototype.lastViewLog = withQuoted(function (this: Entity): IQuery<ViewLogEntity> {
    return table(ViewLogEntity).filter(log =>
        log.target.is(this) && log.user.is(UserHolder.currentUserLite()));
});
