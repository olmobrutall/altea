import type { ResultTable } from "./resultTable";
import type { QueryRequest } from "./requests";
import { SystemTime } from "../systemTime";
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
     * Run a query request. When it carries a {@link QueryRequest.systemTime}, the WHOLE run happens inside
     * that scope (Signum's `using (SystemTime.Override(request.SystemTime))` in DynamicQueryCore) — which
     * is what makes a history query return past row versions instead of the current ones. Applied here, in
     * the container, so EVERY core (auto, manual, custom) honours it.
     */
    executeQueryAsync(request: QueryRequest): Promise<ResultTable> {
        const core = this.getCore(request.queryName);
        return request.systemTime == undefined
            ? core.executeQueryAsync(request)
            : SystemTime.override(request.systemTime, () => core.executeQueryAsync(request));
    }
}
