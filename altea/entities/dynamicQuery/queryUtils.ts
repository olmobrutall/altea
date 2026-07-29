import { Entity, EmbeddedEntity, ModelEntity } from "../entity";
import { cleanTypeName } from "../registration";
import { niceName } from "../utils/localization";
import type { TypeReference } from "../reflection";

// A query's name (Signum's `object queryName`): an entity constructor (the common case —
// "the Album query") or a bare string key.
export type QueryName = Function | string;

// Signum's `QueryUtils.FilterType` — single home in the DynamicQuery enums file (this used to
// declare its own byte-identical copy; deduplicated here).
export type { FilterType } from "../dynamicQueries";
export { FilterTypeEnum } from "../dynamicQueries";
import type { FilterType } from "../dynamicQueries";

// Port of Signum's `QueryUtils.TryGetFilterType`, over an altea `TypeReference`. Unlike the old
// RuntimeType form this needs no `fromTypeName` refinement: the TypeReference carries `typeName` +
// `subTypeName`, so the Integer-vs-Decimal split is recovered directly.
export function tryGetFilterType(type: TypeReference): FilterType | undefined {
    if (type.getEnum() != undefined)
        return "Enum";

    // A Lite<T>, or a full/polymorphic entity reference — Signum maps all to "Lite".
    if (type.lite || type.is(Entity))
        return "Lite";
    if (type.is(EmbeddedEntity))
        return "Embedded";
    if (type.is(ModelEntity))
        return "Model";

    switch (type.typeName) {
        case "Boolean": return "Boolean";
        case "String": return "String";
        case "Guid": return "Guid";
        case "Decimal": return "Decimal";
        case "Number": return type.subTypeName === "decimal" ? "Decimal" : "Integer";
        case "PlainDate":
        case "PlainDateTime": return "DateTime";
        case "Duration":
        case "PlainTime": return "Time";
    }
    return undefined;
}

export function getFilterType(type: TypeReference): FilterType {
    const ft = tryGetFilterType(type);
    if (ft == undefined)
        throw new Error(`Type ${type.getTypeName() ?? "?"} not supported`);
    return ft;
}

// Port of Signum's `QueryUtils.GetKey`: the query's stable string key (the clean type name for
// an entity-ctor query, else the string itself).
export function getKey(queryName: QueryName): string {
    return typeof queryName === "function" ? cleanTypeName(queryName) : String(queryName);
}

// Port of Signum's `QueryUtils.GetNiceName`: a display name (localized entity name, else the key).
export function getNiceName(queryName: QueryName): string {
    return typeof queryName === "function" ? niceName(queryName) : String(queryName);
}
