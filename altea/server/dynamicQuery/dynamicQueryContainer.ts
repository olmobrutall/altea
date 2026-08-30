import type { ResultTable } from "./resultTable";
import type { QueryRequest } from "./requests";
import { SystemTime } from "../systemTime";
import { Connector } from "../connection/connector";
import { RootToken, type QueryToken } from "../../data/dynamicQuery/tokens";
import type { DynamicQueryCore } from "./dynamicQueryCore";
import { getKey, type QueryName } from "../../data/dynamicQuery/queryUtils";

// Port of Signum's `DynamicQueryContainer` (DynamicQuery/DynamicQueryContainer.cs): the registry of
// executable queries. Each is registered as a lazy `DynamicQueryBucket` (Signum's ResetLazy) so the
// query core is built on first use. Backs `QueryLogic.Queries`.
export class DynamicQueryContainer {
    private readonly buckets = new Map<string, { queryName: QueryName; lazyCore: () => DynamicQueryCore; core?: DynamicQueryCore }>();

    register(queryName: QueryName, lazyCore: () => DynamicQueryCore): void {
        this.buckets.set(getKey(queryName), { queryName, lazyCore });
    }

    getQueryNames(): QueryName[] {
        return [...this.buckets.values()].map(b => b.queryName);
    }

    /** The registered query with this key, or undefined. The buckets are already keyed by it. */
    tryGetQueryNameByKey(key: string): QueryName | undefined {
        return this.buckets.get(key)?.queryName;
    }

    tryGetCore(queryName: QueryName): DynamicQueryCore | undefined {
        const b = this.buckets.get(getKey(queryName));
        if (b == undefined)
            return undefined;
        return b.core ??= b.lazyCore();
    }

    getCore(queryName: QueryName): DynamicQueryCore {
        const core = this.tryGetCore(queryName);
        if (core == undefined)
            throw new Error(`No query registered for '${getKey(queryName)}' (call sb.include(T).withQuery(...))`);
        return core;
    }

    // The entity-root token of a query (key "", the reflected shape type): the entry point for token
    // navigation. Replaces Signum's QueryDescription (which listed columns) — columns are now the
    // navigable sub-tokens of this root.
    rootToken(queryName: QueryName): QueryToken {
        return new RootToken(this.getCore(queryName).getRootType(), queryName);
    }

    /**
     * Signum's `DynamicQueryContainer.QueryExecuted` — observe every query run. A handler sees the request
     * and may return an "after" callback that runs once the query has finished (Signum returns an
     * IDisposable and the `using` scope runs the second half); the shape mirrors
     * `OperationLogic.surroundOperation`. The first and only consumer is @altea/altea-view-log.
     *
     * A throwing handler is logged and skipped: an auditing concern must not break what it observes.
     *
     * ALTEA: Signum's event carries an `ExecuteType` (ExecuteQuery / ExecuteQueryValue / …), which it uses
     * only as the logged `viewAction`. altea funnels every read through this one method — the queryValue
     * route builds a QueryRequest too — so there is nothing to discriminate and no enum to pass.
     */
    readonly queryExecuted: QueryExecutedHandler[] = [];

    /**
     * Run a query request. When it carries a {@link QueryRequest.systemTime}, the WHOLE run happens inside
     * that scope (Signum's `using (SystemTime.Override(request.SystemTime))` in DynamicQueryCore) — which
     * is what makes a history query return past row versions instead of the current ones. Applied here, in
     * the container, so EVERY core (auto, manual, custom) honours it.
     */
    async executeQueryAsync(request: QueryRequest): Promise<ResultTable> {
        const core = this.getCore(request.queryName);
        const run = (): Promise<ResultTable> => request.systemTime == undefined
            ? core.executeQueryAsync(request)
            : SystemTime.override(request.systemTime, () => core.executeQueryAsync(request));

        if (this.queryExecuted.length === 0)
            return await run();

        const afters: QueryExecutedAfter[] = [];
        for (const handler of this.queryExecuted) {
            try {
                const after = await handler({ queryName: request.queryName, request });
                if (after != undefined)
                    afters.push(after);
            } catch (e) {
                console.warn(`[query] a queryExecuted handler threw and was skipped: ${(e as Error)?.message ?? e}`);
            }
        }

        // The run happens inside a SQL-capture scope so an observer can record what the query actually
        // executed (Signum's ViewLog swaps Connector.CurrentLogger for a StringWriter — see
        // Connector.withSqlCapture on why an async-local sink replaces that). The sink is ours, so the
        // statements are readable in the `finally` even when the query threw.
        const statements: string[] = [];
        try {
            return await Connector.withSqlCapture(statements, run);
        } finally {
            // The "after" halves run even when the query THREW — that is what an IDisposable's `using`
            // does, and a log of a failed search is worth as much as a log of a successful one.
            for (const after of afters) {
                try { await after(statements); } catch (e) {
                    console.warn(`[query] a queryExecuted after-handler threw and was skipped: ${(e as Error)?.message ?? e}`);
                }
            }
        }
    }
}

export interface QueryExecutedContext {
    queryName: QueryName;
    request: QueryRequest;
}
/** Runs once the query has finished (or thrown), with the SQL statements it executed. */
export type QueryExecutedAfter = (statements: readonly string[]) => void | Promise<void>;
export type QueryExecutedHandler = (ctx: QueryExecutedContext) => QueryExecutedAfter | undefined | Promise<QueryExecutedAfter | undefined>;
