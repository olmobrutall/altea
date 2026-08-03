import { tryGetTypeInfo, setDefinedQueries } from "./Reflection";
import type { OperationType } from "../data/reflection";
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
}

export async function loadReflectionMetadata(options?: { culture?: string }): Promise<ServerMetadata> {
    const url = "/api/reflection/metadata" + (options?.culture ? `?culture=${encodeURIComponent(options.culture)}` : "");
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
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

        (ti.operations ??= {})[key] = {
            key,
            niceName: Localization.translate(container, member) ?? Localization.niceNameFromName(member),
            operationType: info.operationType,
            canBeNew: info.canBeNew,
            canBeModified: info.canBeModified,
            hasCanExecute: info.hasCanExecute,
            hasStates: info.hasStates,
            resultIsSaved: info.resultIsSaved,
        };
        if (info.operationType !== "Execute" && info.operationType !== "Delete")
            ti.hasConstructorOperation = true;
    }
}
