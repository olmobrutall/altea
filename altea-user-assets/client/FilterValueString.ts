import { Lite } from "@altea/altea/data/lite";
import type { FilterType } from "@altea/altea/data/dynamicQueries";

// Client-side port of the value↔string half of Signum's FilterValueConverter (the C# server converter).
// A stored filter/column keeps its value as a STRING (QueryFilterEmbedded.valueString); the live
// SearchControl works with the typed value. altea resolves this on the client (no server round-trip), so
// these translate a single scalar value between the two, given the token's FilterType.
//
// Deferred vs. Signum (marked): the SmartDateTime expression grammar ("Today", "Now+2Months") and the
// [CurrentEntity] / [CurrentUser] special expressions — those pass through unchanged as raw strings.

// Parse a stored string into the typed filter value for the given FilterType.
export function parseFilterValue(str: string | null | undefined, filterType: FilterType | undefined): unknown {
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
export function stringifyFilterValue(value: unknown, filterType: FilterType | undefined): string | null {
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
