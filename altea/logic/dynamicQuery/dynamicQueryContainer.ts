import type { ResultTable } from "./resultTable";
import type { QueryRequest } from "./requests";
import type { QueryToken } from "./tokens/queryToken";
import { RootToken } from "./tokens/rootToken";
import type { DynamicQueryCore } from "./dynamicQueryCore";
import { getKey, type QueryName } from "./queryUtils";

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

    executeQueryAsync(request: QueryRequest): Promise<ResultTable> {
        return this.getCore(request.queryName).executeQueryAsync(request);
    }
}
