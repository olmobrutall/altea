// Client half of the query token layer (Signum's Finder.API.subTokens, narrowed): it wires the
// ASYNC server-only sub-token source (setServerTokensProvider). The client generates the metadata
// sub-tokens LOCALLY off the shared entities token model; the ones it cannot compute — registered
// EXPRESSIONS — come from the reflection metadata blob it already has, and are rebuilt into real
// entities token instances against the caller's own parent.
//
// It used to fetch them per token from `/api/query/:queryKey/serverTokens`, which cost one round trip
// for EVERY token a picker expanded — a dozen on opening a chart, most answering `[]`. An expression is
// registered against a TYPE, not a query, so the answer belongs in the per-type blob: see
// `TypeMetadata.extensions` (shipped once, on the type that declares it, found by walking the chain).
//
// The endpoint stays for what a blob cannot enumerate: PARAMETERIZED extensions, Signum's dictionary
// -style access with dynamic keys. Nothing in altea declares one yet, so nothing calls it on the happy
// path — `fetchServerTokens` remains the seam for when one does.
//
// Importing this module activates client-side extension-token resolution (mirrors how
// logic/queryLogic wires the server-side hooks on import).

import type { Metadata } from "../data/metadata";
import { getKey } from "../data/dynamicQuery/queryUtils";
import {
    setServerTokensProvider, extensionSourceTypeNames, type QueryToken, type SubTokensOptions,
} from "../data/dynamicQuery/tokens";
import { deserializeServerToken, type ServerTokenJson } from "../data/dynamicQuery/tokenSerializer";

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

/**
 * The registered expressions that apply to a token, read out of the metadata blob.
 *
 * `extensionSourceTypeNames` is the shared rule — the chain of declaring types, nearest first, and empty
 * for a raw collection navigation — so this walks exactly what the server's `getExtensionsTokens` walks.
 * Nearest wins on a key collision, as it does there.
 */
function extensionsFromMetadata(metadata: typeof Metadata, token: QueryToken): ServerTokenJson[] {
    const out: ServerTokenJson[] = [];
    const seen = new Set<string>();
    for (const typeName of extensionSourceTypeNames(token))
        for (const [key, ext] of Object.entries(metadata.tryType(typeName)?.extensions ?? {}))
            if (!seen.has(key)) { seen.add(key); out.push({ ...ext, key }); }
    return out;
}

// Wire the client-side server-only sub-token source. Run once on import; re-callable so a host (or a
// test) can restore the wiring after something else swapped the global provider.
//
// Before a blob has been applied there is nothing to read, and "no extensions entry" would be
// indistinguishable from "no blob" — a picker running that early would silently show no extension tokens
// at all. So the endpoint still answers until `Metadata.apply` has run once: falling back is correct
// where guessing would be wrong.
export function initQueryClient(): void {
    setServerTokensProvider(async (token: QueryToken, options: SubTokensOptions) => {
        // `data/metadata` is imported LAZILY, for the same reason `./Services` is: this module is pulled
        // in by the token layer at the very start of client boot, and a static edge from here to the
        // metadata store closes a cycle that leaves OTHER modules half-initialised — the symptom was
        // ChartClient's script registry coming up empty ("No chartScriptComponent registered"), nowhere
        // near the edge that caused it. The provider is async, so deferring costs nothing.
        const { Metadata } = await import("../data/metadata");
        const json = Metadata.isApplied()
            ? extensionsFromMetadata(Metadata, token)
            : await fetchServerTokens(getKey(token.queryName), token.fullKey(), options);
        return json.map(j => deserializeServerToken(j, token));
    });
}

initQueryClient();
