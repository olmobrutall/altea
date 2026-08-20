import { setDefinedQueries } from "./Reflection";
import { Metadata } from "../data/metadata";
import type { MetadataBlob } from "../data/metadata";
import { cleanTypeName, resolveType } from "../data/registration";

// Client consumer of the server reflection metadata (Signum's ReflectionServer/reloadTypes). altea ships
// the entity SHAPE at compile time (@reflect stamps TypeInfo/FieldInfo onto constructors), so this only
// distributes the per-culture / per-role blob that /api/reflection/metadata returns — one TypeMetadata
// per type, carrying nice names, enum/symbol ids, `hasQuery`, operations, and whatever an authorization
// module widened it with. Call once at client boot, before rendering.
//
// The wire shape is `MetadataBlob` (data/metadata), declared ONCE and shared by both tiers — it used to
// be hand-mirrored here against the server's copy.
export type { MetadataBlob };

// Post-apply hooks (Signum re-runs its `fixTypes` on reflection reload): invoked at the END of every
// applyMetadata with the freshly-applied blob. Core registers none; an extension that has to derive
// something from the blob at load time (rather than read it on demand) pushes one here.
export const applyMetadataHooks: ((meta: MetadataBlob) => void)[] = [];

// Extra request headers for the metadata fetch (Signum ships the blob role-filtered; altea attaches the
// bearer token here so the server sees the current user). An auth module sets this; undefined → none.
// Kept as a seam so this core module needn't depend on the auth client.
export let extraHeaders: (() => Record<string, string>) | undefined;
export function setExtraHeaders(fn: (() => Record<string, string>) | undefined): void { extraHeaders = fn; }

// The culture of the blob currently applied. A RELOAD (a role change, say) must not silently drop the
// user's chosen culture back to the server default — every caller other than the culture picker itself is
// asking for "the same blob, freshly" — so this is the default for `culture`. Undefined only before the
// first load, where sending no culture is right: the SERVER's default is the answer, not the client's.
let currentCulture: string | undefined;

export async function loadReflectionMetadata(options?: { culture?: string }): Promise<MetadataBlob> {
    const culture = options?.culture ?? currentCulture;
    const url = "/api/reflection/metadata" + (culture ? `?culture=${encodeURIComponent(culture)}` : "");
    const resp = await fetch(url, { headers: { Accept: "application/json", ...(extraHeaders?.() ?? {}) }, cache: "no-cache" });
    if (!resp.ok)
        throw new Error(`GET ${url} → ${resp.status} ${resp.statusText}`);
    const meta = await resp.json() as MetadataBlob;
    currentCulture = meta.culture;
    applyMetadata(meta);
    return meta;
}

export function applyMetadata(meta: MetadataBlob): void {
    // Adopts the blob's culture as the process default (the client has no async-context, so the process
    // default IS the UI culture) and REPLACES that culture's types — a re-login as a different role must
    // not leave the previous role's allowances or visible queries behind.
    Metadata.apply(meta);

    // Query-defined registry (Finder.isFindable / isQueryDefined), derived from the per-type `hasQuery`.
    setDefinedQueries(queryKeys(meta));

    for (const hook of applyMetadataHooks)
        hook(meta);
}

// The keys of the queries the blob declares. `types` is keyed by the REGISTERED type name ("OrderEntity")
// because that is what translations key on, while a query key is the CLEAN name ("Order") — so a
// class-backed entry is mapped through its ctor. A string-named query is its own key already.
function queryKeys(meta: MetadataBlob): string[] {
    const result: string[] = [];
    for (const [name, tm] of Object.entries(meta.types)) {
        if (!tm.hasQuery) continue;
        const ctor = resolveType(name);
        result.push(ctor != null ? cleanTypeName(ctor) : name);
    }
    return result;
}
