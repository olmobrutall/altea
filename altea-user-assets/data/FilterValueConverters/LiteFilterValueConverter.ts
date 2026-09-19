import { Lite } from "@altea/altea/data/lite";
import {
    FilterValueResult, type FilterValueTarget, type IFilterValueConverter,
} from "./IFilterValueConverter";

// Port of Signum.UserAssets' LiteFilterValueConverter — an entity reference stored as its lite KEY
// ("Order;42"). It was inlined in FilterValueString before the converter family existed; the behaviour is
// unchanged, only the shape.
//
// Two divergences, both because this runs on BOTH tiers where Signum's runs only on the server:
//  * it claims Embedded and Model targets too, not just Lite — altea's stored value for those is a key as
//    well, and nothing else would decode it;
//  * a key that does not LOOK like one is passed through rather than reported as an error. A filter on an
//    @implementedByAll token can hold text a user typed, and the alternative is an import that dies on it.
//  * no `Database.RetrieveLite`: there is no database on the client, and the lite's toStr is filled by
//    whoever renders it (see Finder.parseFilterValues).

function claims(target: FilterValueTarget): boolean {
    return target.filterType === "Lite" || target.filterType === "Embedded" || target.filterType === "Model";
}

export const LiteFilterValueConverter: IFilterValueConverter = {

    tryGetExpression(value: unknown, target: FilterValueTarget): FilterValueResult<string | null> | null {
        if (!claims(target) || value == null)
            return null;

        const key = (value as { key?: () => string }).key;
        return FilterValueResult.success(typeof key === "function" ? key.call(value) : String(value));
    },

    tryParseExpression(expression: string, target: FilterValueTarget): FilterValueResult<unknown> | null {
        if (!claims(target))
            return null;

        if (!looksLikeLiteKey(expression))
            return FilterValueResult.success(expression);

        try {
            return FilterValueResult.success(Lite.parse(expression));
        } catch {
            return FilterValueResult.success(expression);
        }
    },

    isValidExpression(expression: string, target: FilterValueTarget): FilterValueResult<string> | null {
        if (!claims(target) || !looksLikeLiteKey(expression))
            return null;

        try {
            Lite.parse(expression);
            return FilterValueResult.success(expression);
        } catch (e) {
            return FilterValueResult.error(e instanceof Error ? e.message : String(e));
        }
    },
};

function looksLikeLiteKey(s: string): boolean {
    const semi = s.indexOf(";");
    return semi > 0 && /^[A-Z]\w*$/.test(s.slice(0, semi));
}
