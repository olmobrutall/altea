import { Entity, EmbeddedEntity, ModelEntity } from "../entity";
import { cleanTypeName } from "../registration";
import { niceName } from "../utils/localization";
import {
    RuntimeType, ClassType, LiteType, EnumType, TemporalType, LiteralType,
} from "../runtimeTypes";

// A query's name (Signum's `object queryName`): an entity constructor (the common case —
// "the Album query") or a bare string key.
export type QueryName = Function | string;

// Signum's `QueryUtils.FilterType` — single home in the DynamicQuery enums file (this used to
// declare its own byte-identical copy; deduplicated here).
export { FilterType } from "../dynamicQueries";
import { FilterType } from "../dynamicQueries";

function isEntityCtor(ctor: Function): boolean {
    return ctor === Entity || ctor.prototype instanceof Entity;
}

// Port of Signum's `QueryUtils.TryGetFilterType`, over an altea `RuntimeType`.
//
// Divergence: altea's RuntimeType collapses `int`/`number` to `LiteralType.number`, so this
// returns `FilterType.Integer` for every plain number — the Integer-vs-Decimal split needs the
// field's declared typeName ("Decimal"), which only a PropertyRoute/FieldInfo carries.
// `tryGetFilterTypeFromTypeName` below refines it when that context is available.
export function tryGetFilterType(type: RuntimeType): FilterType | undefined {
    if (type instanceof EnumType)
        return FilterType.Enum;

    // A Lite<T>, or a full entity reference — Signum maps both to FilterType.Lite.
    if (type instanceof LiteType)
        return FilterType.Lite;

    if (type instanceof TemporalType)
        return type.kind === "duration" ? FilterType.Time : FilterType.DateTime;

    if (type === LiteralType.boolean)
        return FilterType.Boolean;
    if (type === LiteralType.number)
        return FilterType.Integer;
    if (type === LiteralType.string)
        return FilterType.String;

    if (type instanceof ClassType) {
        const c = type.constructorFunction;
        if (isEntityCtor(c))
            return FilterType.Lite;
        if (c.prototype instanceof EmbeddedEntity)
            return FilterType.Embedded;
        if (c.prototype instanceof ModelEntity)
            return FilterType.Model;
    }

    return undefined;
}

// Refine `tryGetFilterType` with the field's declared typeName, recovering the split altea's
// RuntimeType loses: "Decimal" → Decimal, "Number" → Integer. Other typeNames defer to the
// RuntimeType classification.
export function tryGetFilterTypeFromTypeName(typeName: string | undefined, type: RuntimeType): FilterType | undefined {
    if (typeName === "Decimal")
        return FilterType.Decimal;
    if (typeName === "Number")
        return FilterType.Integer;
    return tryGetFilterType(type);
}

export function getFilterType(type: RuntimeType): FilterType {
    const ft = tryGetFilterType(type);
    if (ft == undefined)
        throw new Error(`Type ${type.constructor.name} not supported`);
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
