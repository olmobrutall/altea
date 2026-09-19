import type { FilterTypeKeys } from "@altea/altea/data/dynamicQueries";
import { FilterValueConverter } from "./FilterValueConverter";

// The value↔string half of Signum's FilterValueConverter — see port/UserAssets.md.
//
// It is ISOMORPHIC, not client code: the SearchControl editors need it on the client and QueryFilterUtils
// needs it on the server. A stored filter/column keeps its value as a STRING
// (UserQueryEntity_Filter.valueString) while the live SearchControl works with the typed value, so these
// translate a single scalar between the two, given the token's FilterType.
//
// The FAÇADE only: the rules themselves are the converter list in FilterValueConverter (Signum's
// `SpecificConverters`) — a RELATIVE date ("yyyy/mm/01 00:00:00"), an entity reference ("Order;42") — and
// what remains here is Signum's own fallback, the plain primitive parse. The `[CurrentEntity]` /
// `[CurrentUser]` expressions are still passed through unchanged as raw strings (each caller resolves
// them against its own context).

/**
 * Parse a stored string into the typed filter value for the given FilterType.
 *
 * `typeName` is the token's own value type when the caller has the token. It is what separates a
 * `PlainDate` token from a `PlainDateTime` one — both are FilterType "DateTime" — so a smart date resolves
 * to the precision the editor and the column expect.
 */
export function parseFilterValue(
    str: string | null | undefined,
    filterType: FilterTypeKeys | undefined,
    typeName?: string | undefined,
): unknown {
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

/** Stringify a typed filter value back to its stored form for the given FilterType. */
export function stringifyFilterValue(
    value: unknown,
    filterType: FilterTypeKeys | undefined,
    typeName?: string | undefined,
): string | null {
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
