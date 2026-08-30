import { Entity, EmbeddedEntity, ModelEntity, type BaseEntity, type Type } from "../entity";
import { cleanTypeName } from "../registration";
import { Localization } from "../utils/localization";
import type { TypeReference } from "../reflection";

/**
 * A query's name: the TYPE it yields rows of — an entity for a plain `withQuery()`, or the model a
 * manual query projects to (`CustomerModel`, `InboxRowModel`). Signum types this `object`, because its
 * queries may also be enum MEMBERS (`AlbumQuery.Recent`), and altea used to allow a bare string for that.
 *
 * It never worked: nothing outside a test called `QueryLogic.registerQuery`, so the key→name map a string
 * name would have to be recovered from was empty at runtime and the wire boundary fell through to
 * `resolveCleanType` — which only ever answers a CONSTRUCTOR. A string-named query was therefore
 * registrable but unreachable over HTTP. Narrowing the type deletes that trap and makes the rule explicit:
 * one query per type, and a second view of the same data is its own row model.
 */
export type QueryName = Type<BaseEntity>;

// Signum's `QueryUtils.FilterType` — single home in the DynamicQuery enums file (this used to
// declare its own byte-identical copy; deduplicated here).
export type { FilterType } from "../dynamicQueries";
export { FilterTypeEnum } from "../dynamicQueries";
import type { FilterType } from "../dynamicQueries";

// Port of Signum's `QueryUtils.TryGetFilterType`, over an altea `TypeReference`. Unlike the old
// RuntimeType form this needs no `fromTypeName` refinement: the TypeReference carries `typeName` +
// `subTypeName`, so the Integer-vs-Decimal split is recovered directly.
export function tryGetFilterType(type: TypeReference): FilterType | undefined {
    // A COLLECTION has no filter type (Signum: `MList<T>` / `T[]` reaches `TypeCode.Object` and matches
    // none of the Lite / entity / embedded / model tests, so TryGetFilterType returns null). altea models
    // a collection as a plain array whose TypeReference ALSO carries the element type, so the array facet
    // must be tested FIRST or a `Lite<T>[]` field would classify as "Lite" — which made a collection token
    // filterable, orderable, aggregatable and (worst) GROUPABLE: the chart editor happily picked
    // `Product.additionalInformation` as its dimension and "grouped" by a whole array, one group per row.
    // A collection is navigated (`.Any` / `.Element` / `.SeparatedByComma`), never filtered directly.
    if (type.array)
        return undefined;

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

// Port of Signum's `QueryUtils.GetKey`: the query's stable string key — its type's clean name.
export function getKey(queryName: QueryName): string {
    return cleanTypeName(queryName);
}

// Port of Signum's `QueryUtils.GetNiceName`: the localized type name. The SEARCH PAGE shows the PLURAL
// (client Reflection's getQueryNiceName); this is the singular, used where one row is meant.
export function getNiceName(queryName: QueryName): string {
    return queryName.niceName();
}
