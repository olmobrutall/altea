import { Lite } from "@altea/altea/data/lite";
import type { FilterTypeKeys } from "@altea/altea/data/dynamicQueries";

// The value↔string half of Signum's FilterValueConverter — see docs/port/UserAssets.md.
//
// It is ISOMORPHIC, not client code: the SearchControl editors need it on the client and QueryFilterUtils
// needs it on the server. A stored filter/column keeps its value as a STRING
// (UserQueryEntity_Filter.valueString) while the live SearchControl works with the typed value, so these
// translate a single scalar between the two, given the token's FilterType.
//
// DEFERRED, and passed through unchanged as raw strings: the SmartDateTime expression grammar ("Today",
// "Now+2Months") and the [CurrentEntity] / [CurrentUser] special expressions.

// Parse a stored string into the typed filter value for the given FilterType.
export function parseFilterValue(str: string | null | undefined, filterType: FilterTypeKeys | undefined): unknown {
    if (str == null || str === "")
        return undefined;

    switch (filterType) {
        case "Integer": return parseInt(str, 10);
        case "Decimal": return parseFloat(str);
        case "Boolean": return str === "True" || str === "true";
        case "Lite":
        case "Embedded":
        case "Model":
            return looksLikeLiteKey(str) ? tryParseLite(str) : str;
        // DateTime / Time / Guid / String / Enum (and anything else): keep the string.
        default: return str;
    }
}

// Stringify a typed filter value back to its stored form for the given FilterType.
export function stringifyFilterValue(value: unknown, filterType: FilterTypeKeys | undefined): string | null {
    if (value == null || value === "")
        return null;

    switch (filterType) {
        case "Boolean": return value ? "True" : "False";
        case "Lite":
        case "Embedded":
        case "Model": {
            const key = (value as { key?: () => string }).key;
            return typeof key === "function" ? key.call(value) : String(value);
        }
        default: return String(value);
    }
}

function looksLikeLiteKey(s: string): boolean {
    const semi = s.indexOf(";");
    return semi > 0 && /^[A-Z]\w*$/.test(s.slice(0, semi));
}

function tryParseLite(s: string): unknown {
    try { return Lite.parse(s); } catch { return s; }
}
