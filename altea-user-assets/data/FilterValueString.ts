import type { FilterTypeKeys } from "@altea/altea/data/dynamicQueries";
import { FilterValueConverter } from "./FilterValueConverter";
import { isSmartDateTimeExpression } from "./FilterValueConverters/SmartDateTimeFilterValueConverter";

// The value↔string half of Signum's FilterValueConverter — see port/UserAssets.md.
//
// It is ISOMORPHIC, not client code: the SearchControl editors need it on the client and QueryFilterUtils
// needs it on the server. A stored filter/column keeps its value as a STRING
// (UserQueryEntity_Filter.valueString) while the live SearchControl works with the typed value, so these
// translate a single scalar between the two, given the token's FilterType.
//
// The FAÇADE only: the rules themselves are the converter list in FilterValueConverter (Signum's
// `SpecificConverters`) — the current entity / user ("[CurrentEntity].Member", "[CurrentUser].Member"), a
// RELATIVE date ("yyyy/mm/01 00:00:00"), an entity reference ("Order;42") — and what remains here is
// Signum's own fallback, the plain primitive parse, plus its "|" split for a list / pair operation.

/**
 * Whether a stored string is an EXPRESSION — "[CurrentEntity]…", "[CurrentUser]…", a relative date — rather
 * than an encoded value. A filter EDITOR keeps these as the text the user typed; running the asset resolves them.
 */
export function isFilterValueExpression(str: unknown): str is string {
    return typeof str === "string" && (str.startsWith("[") || isSmartDateTimeExpression(str));
}

/** Whether the value is for a list operation (IsIn, …) or a pair one (between) — Signum's `isList` / `isPair`. */
export interface FilterValueShape {
    isList?: boolean;
    isPair?: boolean;
}

/**
 * Parse a stored string into the typed filter value for the given FilterType.
 *
 * `typeName` is the token's own value type when the caller has the token. It is what separates a
 * `PlainDate` token from a `PlainDateTime` one — both are FilterType "DateTime" — so a smart date resolves
 * to the precision the editor and the column expect.
 *
 * With `shape`, the string is split on "|" as Signum's `FilterValueConverter.Parse` does: a list skips
 * blank parts, a pair keeps them (an open end is null).
 */
export function parseFilterValue(
    str: string | null | undefined,
    filterType: FilterTypeKeys | undefined,
    typeName?: string | undefined,
    shape?: FilterValueShape,
): unknown {
    if (shape?.isPair)
        return (str ?? "").split("|").map(p => p === "" ? null : parseFilterValue(p.trim(), filterType, typeName) ?? null);

    if (shape?.isList)
        return (str ?? "").split("|").map(p => p.trim()).filter(p => p !== "").map(p => parseFilterValue(p, filterType, typeName));

    if (str == null || str === "")
        return undefined;

    const converted = FilterValueConverter.tryParse(str, { filterType, typeName });
    if (converted != null) {
        // A value that MEANT to be an expression and is malformed is an error, not a string to pass on:
        // Signum throws FormatException here, and the alternative is a filter that silently means something
        // else. A string no rule claims never reaches this.
        if (!converted.ok)
            throw new Error(converted.error);
        return converted.value;
    }

    switch (filterType) {
        case "Integer": return parseInt(str, 10);
        case "Decimal": return parseFloat(str);
        case "Boolean": return str === "True" || str === "true";
        // DateTime / Time / Guid / String / Enum (and anything else): keep the string.
        default: return str;
    }
}

/** Stringify a typed filter value back to its stored form for the given FilterType. A list / pair value is
 *  joined with "|", as Signum's `FilterValueConverter.ToString` does (an open end of a pair stays empty). */
export function stringifyFilterValue(
    value: unknown,
    filterType: FilterTypeKeys | undefined,
    typeName?: string | undefined,
): string | null {
    if (Array.isArray(value))
        return value.map(v => stringifyFilterValue(v, filterType, typeName) ?? "").join("|");

    if (value == null || value === "")
        return null;

    const converted = FilterValueConverter.tryToString(value, { filterType, typeName });
    if (converted != null) {
        if (!converted.ok)
            throw new Error(converted.error);
        return converted.value;
    }

    switch (filterType) {
        case "Boolean": return value ? "True" : "False";
        default: return String(value);
    }
}
