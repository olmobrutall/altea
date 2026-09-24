// The client's source of SERVER-ONLY query tokens (Signum's Finder.API.subTokens, narrowed): it wires the
// ASYNC server-only sub-token source (setServerTokensProvider). The client generates the metadata
// sub-tokens LOCALLY off the shared entities token model; the ones it cannot compute — registered
// EXPRESSIONS — come from the reflection metadata blob it already has, and are rebuilt into real
// entities token instances against the caller's own parent.
//
// ALWAYS from the blob. They used to be fetched per token from `/api/query/:queryKey/serverTokens`,
// which cost one round trip for EVERY token a picker expanded — a dozen on opening a chart, most
// answering `[]`. An expression is registered against a TYPE, not a query, so the answer belongs in the
// per-type blob: see `TypeMetadata.extensions` (shipped once, on the type that declares it, found by
// walking the chain). The endpoint is gone; so is any support for PARAMETERIZED extensions (Signum's
// dictionary-style access with dynamic keys) — except for their CHILDREN, which a blob cannot enumerate: those
// are fetched from /api/query/indexerTokens when a container is expanded.
//
// Importing this module activates client-side extension-token resolution (mirrors how
// logic/queryLogic wires the server-side hooks on import).

import type { Metadata } from "../data/metadata";
import {
    setServerTokensProvider, extensionSourceTypeNames, expressionSourceKeyOf, IndexerContainerToken, type QueryToken,
} from "../data/dynamicQuery/tokens";
import { tryGetTypeInfo } from "../data/reflection";
import { deserializeServerToken, type ServerTokenJson } from "../data/dynamicQuery/tokenSerializer";

/**
 * The registered expressions that apply to a token, read out of the metadata blob.
 *
 * `extensionSourceTypeNames` is the shared rule — the chain of declaring types, nearest first, and empty
 * for a raw collection navigation — so this walks exactly what the server's `getExtensionsTokens` walks.
 * Nearest wins on a key collision, as it does there.
 */
function extensionsFromMetadata(metadata: typeof Metadata, token: QueryToken): { json: ServerTokenJson; declaringType: Function | object }[] {
    const out: { json: ServerTokenJson; declaringType: Function | object }[] = [];
    const seen = new Set<string>();
    for (const { typeName, source } of declaringSources(token))
        for (const [key, ext] of Object.entries(metadata.tryType(typeName)?.extensions ?? {}))
            if (!seen.has(key)) { seen.add(key); out.push({ json: { ...ext, key }, declaringType: source }); }
    return out;
}

// `extensionSourceTypeNames`, each name paired with the class (or enum object) it names — the key an
// expression's settings are registered under. Both walk the same chain from the same start.
function declaringSources(token: QueryToken): { typeName: string; source: Function | object }[] {
    const names = extensionSourceTypeNames(token);
    const key = expressionSourceKeyOf(token.type);
    if (names.length == 0 || key == undefined)
        return [];
    if (typeof key !== "function")
        return [{ typeName: names[0]!, source: key }];
    const out: { typeName: string; source: Function | object }[] = [];
    let c: Function = key;
    for (const typeName of names) {
        out.push({ typeName, source: c });
        c = Object.getPrototypeOf(c);
    }
    return out;
}

// Wire the client-side server-only sub-token source. Run once on import; re-callable so a host (or a
// test) can restore the wiring after something else swapped the global provider.
//
// Before a blob has been applied there is nothing to read, and "no extensions entry" would be
// indistinguishable from "no blob" — a picker running that early would silently show no extension tokens
// at all. So that is an error rather than an empty answer.
export function initTokenCache(): void {
    setServerTokensProvider(async (token: QueryToken) => {
        // `data/metadata` is imported LAZILY: this module is pulled
        // in by the token layer at the very start of client boot, and a static edge from here to the
        // metadata store closes a cycle that leaves OTHER modules half-initialised — the symptom was
        // ChartClient's script registry coming up empty ("No chartScriptComponent registered"), nowhere
        // near the edge that caused it. The provider is async, so deferring costs nothing.
        const { Metadata } = await import("../data/metadata");
        // Finder too, and for the same reason: it imports THIS module, so a static edge back would be a
        // cycle through the very first thing the token layer loads.
        const { Finder } = await import("./Finder");
        if (!Metadata.isApplied())
            throw new Error(`Sub-tokens of '${token.fullKey()}' were requested before the metadata blob was applied`);
        // The children of an expression-with-parameter container are listed by the server at runtime
        // (the blob carries the container, not its keys) — fetched per expansion, as Signum does.
        if (token instanceof IndexerContainerToken) {
            const [{ ajaxPost }, { getQueryKey }] = await Promise.all([import("./Services"), import("./Reflection")]);
            const children = await ajaxPost<ServerTokenJson[]>(
                { url: "/api/query/indexerTokens/" + getQueryKey(token.queryName) }, { token: token.fullKey() });
            return children.map(json => deserializeServerToken(json, token));
        }
        const extensions = extensionsFromMetadata(Metadata, token);
        // Only what Finder's expression settings offer on this token (`isVisibleForType`), judged against
        // the token's OWN type — the concrete one the chain walk started from — so an expression registered
        // on `Entity` can be left off the types it does not belong on.
        const source = expressionSourceKeyOf(token.type);
        const ti = typeof source === "function" ? tryGetTypeInfo(source) : undefined;
        return extensions
            .filter(e => ti == undefined || (Finder.getExpressionSettings(e.declaringType, e.json.key)?.isVisibleForType?.(ti) ?? true))
            .map(e => deserializeServerToken(e.json, token));
    });
}

initTokenCache();
