// Client half of the query token layer (Signum's Finder.API.subTokens, narrowed): it wires the
// ASYNC server-only sub-token source (setServerTokensProvider). The client generates the metadata
// sub-tokens LOCALLY off the shared entities token model; only the tokens it can't compute
// (extensions — later manual / operations) are fetched from the server (logic/queryServer's
// `/api/query/:queryKey/serverTokens`) and rebuilt into real entities token instances.
//
// Importing this module activates client-side server-token fetching (mirrors how logic/queryLogic
// wires the server-side hooks on import). `getSubTokens(token, options)` then returns the local
// metadata tokens merged with the fetched ones.

import { getKey } from "../entities/dynamicQuery/queryUtils";
import { setServerTokensProvider, type QueryToken, type SubTokensOptions } from "../entities/dynamicQuery/tokens";
import { deserializeServerToken, type ServerTokenJson } from "../entities/dynamicQuery/tokenSerializer";

// query key | token fullKey | options  ->  the in-flight/settled fetch. Cached as raw JSON (not token
// instances) so each call rebuilds the tokens off the CALLER's local parent.
const cache = new Map<string, Promise<ServerTokenJson[]>>();

// The transport: a cached ajax GET of the server-only tokens. A plain field so tests (and alternative
// hosts) can swap it via setFetchServerTokens without touching the wiring below.
export let fetchServerTokens = (queryKey: string, tokenFullKey: string, options: SubTokensOptions): Promise<ServerTokenJson[]> => {
    const cacheKey = `${queryKey}|${tokenFullKey}|${options}`;
    let p = cache.get(cacheKey);
    if (p == undefined) {
        const qs = `token=${encodeURIComponent(tokenFullKey)}&options=${options}`;
        // ./Services is browser-coupled (touches `document` at module load), so import it lazily —
        // this keeps QueryClient importable in non-DOM hosts (tests / SSR that swap the transport).
        p = import("./Services").then(({ ajaxGet }) =>
            ajaxGet<ServerTokenJson[]>({ url: `/api/query/${encodeURIComponent(queryKey)}/serverTokens?${qs}` }));
        cache.set(cacheKey, p);
    }
    return p;
};

export function setFetchServerTokens(fn: typeof fetchServerTokens): void { fetchServerTokens = fn; }
export function clearServerTokenCache(): void { cache.clear(); }

// Wire the client-side server-only sub-token source: fetch the serialized tokens for the parent, then
// rebuild each off the caller's LOCAL parent instance. Run once on import; re-callable so a host (or a
// test) can restore the wiring after something else swapped the global provider.
export function initQueryClient(): void {
    setServerTokensProvider(async (token: QueryToken, options: SubTokensOptions) => {
        const json = await fetchServerTokens(getKey(token.queryName), token.fullKey(), options);
        return json.map(j => deserializeServerToken(j, token));
    });
}

initQueryClient();
