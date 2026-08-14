import { tryGetTypeInfo, setDefinedQueries } from "./Reflection";
import { getRegisteredTypes, getTypeInfo, type OperationType, type TypeInfo, type OperationInfo } from "../data/reflection";
import { Localization } from "../data/utils/localization";
import { CultureInfo } from "../data/utils/cultureInfo";
type LocalizedTypes = Localization.LocalizedTypes;

// Client consumer of the server reflection metadata (Signum's ReflectionServer/reloadTypes). altea ships
// the entity SHAPE at compile time (@reflect stamps TypeInfo/FieldInfo onto constructors), so this only
// distributes the runtime/culture/user-dependent blob that /api/reflection/metadata returns:
//   translations → DescriptionManager (nice names), queries → the query-defined registry,
//   operations   → per-type TypeInfo.operations (so Operations buttons have their OperationInfo).
// Call once at client boot, before rendering.

// The wire shape (must match server/reflectionServer.ts ServerMetadata / OperationInfo).
interface WireOperationInfo {
    key: string;
    operationType: OperationType;
    canBeNew?: boolean;
    canBeModified?: boolean;
    resultIsSaved?: boolean;
    hasCanExecute?: boolean;
    hasStates?: boolean;
}
export interface ServerMetadata {
    culture: string;
    translations: LocalizedTypes;
    queries: string[];
    operations: Record<string, WireOperationInfo>;
    // OPAQUE per-type payload an authorization module may attach (cleanName → a numeric allowance); the core
    // just carries it. The auth client's applyMetadataHook reads it into its own (interface-expanded)
    // TypeInfo.min/maxTypeAllowed. Signum ships the analog per-TypeInfo; altea carries a flat map here.
    typeAllowed?: Record<string, number>;
}

// Post-apply hooks (Signum re-runs its `fixTypes` on reflection reload): invoked at the END of every
// applyMetadata with the freshly-applied blob. An authorization module pushes one to project
// `meta.typeAllowed` onto its interface-expanded TypeInfo fields. Core registers none.
export const applyMetadataHooks: ((meta: ServerMetadata) => void)[] = [];

// Extra request headers for the metadata fetch (Signum ships the blob role-filtered; altea attaches the
// bearer token here so the server sees the current user). An auth module sets this; undefined → none.
// Kept as a seam so this core module needn't depend on the auth client.
export let extraHeaders: (() => Record<string, string>) | undefined;
export function setExtraHeaders(fn: (() => Record<string, string>) | undefined): void { extraHeaders = fn; }

export async function loadReflectionMetadata(options?: { culture?: string }): Promise<ServerMetadata> {
    const url = "/api/reflection/metadata" + (options?.culture ? `?culture=${encodeURIComponent(options.culture)}` : "");
    const resp = await fetch(url, { headers: { Accept: "application/json", ...(extraHeaders?.() ?? {}) }, cache: "no-cache" });
    if (!resp.ok)
        throw new Error(`GET ${url} → ${resp.status} ${resp.statusText}`);
    const meta = await resp.json() as ServerMetadata;
    applyMetadata(meta);
    return meta;
}

export function applyMetadata(meta: ServerMetadata): void {
    // Culture + translations (the client has no async-context, so the process default IS the UI culture).
    CultureInfo.setDefaultCulture(meta.culture);
    CultureInfo.setDefaultUICulture(meta.culture);
    Localization.addLocalizedTypes(meta.culture, meta.translations);

    // Query-defined registry (Finder.isFindable / isQueryDefined).
    setDefinedQueries(meta.queries);

    // Operations → per-type TypeInfo.operations. altea's operation registry is keyed by symbol alone
    // (no runtime type), so associate each operation to its type by the Signum `<Type>Operation.Member`
    // key convention (e.g. OrderOperation.Ship → OrderEntity). The operation's niceName resolves from
    // the shipped translations (operation container = a localized "Type") or the humanized member name.
    for (const [key, info] of Object.entries(meta.operations)) {
        const dot = key.indexOf(".");
        const container = dot >= 0 ? key.slice(0, dot) : key;
        const member = dot >= 0 ? key.slice(dot + 1) : key;

        // clean type name (PseudoType string) — tryGetTypeInfo resolves the "Entity"-suffixed ctor too.
        const ti = tryGetTypeInfo(container.replace(/Operation$/, ""));
        if (ti == null)
            continue;

        const oi: OperationInfo = {
            key,
            niceName: Localization.translate(container, member) ?? Localization.niceNameFromName(member),
            operationType: info.operationType,
            canBeNew: info.canBeNew,
            canBeModified: info.canBeModified,
            hasCanExecute: info.hasCanExecute,
            hasStates: info.hasStates,
            resultIsSaved: info.resultIsSaved,
        };

        // Attach to the resolved type AND every concrete subclass. Signum registers an operation per
        // concrete type (Southwind's `.WithSave(CustomerOperation.Save)` on both Person and Company), so
        // a symbol typed on an ABSTRACT base (CustomerOperation → CustomerEntity) must reach the concrete
        // subtypes that are actually viewed. altea gives each class its own TypeInfo and operations don't
        // inherit, so we walk the registered ctors and copy the OperationInfo onto each descendant's
        // TypeInfo. For a concrete type with no subclasses (OrderEntity) this is just `ti` itself.
        for (const target of typeAndConcreteSubTypes(ti)) {
            (target.operations ??= {})[key] = oi;
            if (info.operationType !== "Execute" && info.operationType !== "Delete")
                target.hasConstructorOperation = true;
        }
    }

    // Extension hooks (e.g. auth projecting meta.typeAllowed onto its interface-expanded TypeInfo fields).
    for (const hook of applyMetadataHooks)
        hook(meta);
}

// `ti` plus the TypeInfos of every registered class that extends `ti.ctor` (its concrete subclasses).
function typeAndConcreteSubTypes(ti: TypeInfo): TypeInfo[] {
    const result = [ti];
    const base = ti.ctor;
    if (base != null) {
        for (const ctor of getRegisteredTypes()) {
            if (ctor !== base && ctor.prototype instanceof base) {
                const sub = getTypeInfo(ctor);
                if (sub != null && sub !== ti)
                    result.push(sub);
            }
        }
    }
    return result;
}
