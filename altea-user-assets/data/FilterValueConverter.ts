import {
    type FilterValueResult, type FilterValueTarget, type IFilterValueConverter,
} from "./FilterValueConverters/IFilterValueConverter";
import { SmartDateTimeFilterValueConverter } from "./FilterValueConverters/SmartDateTimeFilterValueConverter";
import { LiteFilterValueConverter } from "./FilterValueConverters/LiteFilterValueConverter";

export type { FilterValueResult, FilterValueTarget, IFilterValueConverter };

// Port of Signum.UserAssets' FilterValueConverter registry (FilterValueConverter.cs) — the ORDERED list of
// rules that translate a filter value to and from the string a user asset stores, each answering "not
// mine" (null) until one claims the value. Signum's `SpecificConverters`.
//
// Two of Signum's four are here. `CurrentEntityConverter` and `CurrentUserConverter` are not: they read an
// ambient "the entity this is being rendered for" / "the logged-in user", which each CALLER already
// supplies differently (UserChartClient resolves "[CurrentEntity]" against the chart's scope entity and
// "[CurrentUser]" against AppContext) — porting them properly means an ambient context this package does
// not have. Still deferred; see port/UserAssets.md.
//
// The plain primitive fallback is NOT here but in FilterValueString, which is the façade the two tiers
// call — this file is only the rules and the loop, exactly as Signum splits them.
export namespace FilterValueConverter {

    /** Tried in order. An application may insert its own rule (Signum's list is public too). */
    export const specificConverters: IFilterValueConverter[] = [
        SmartDateTimeFilterValueConverter,
        LiteFilterValueConverter,
    ];

    /** The first rule that claims `expression`, or null for "no rule does" (the caller falls back). */
    export function tryParse(expression: string, target: FilterValueTarget): FilterValueResult<unknown> | null {
        for (const c of specificConverters) {
            const r = c.tryParseExpression(expression, target);
            if (r != null)
                return r;
        }
        return null;
    }

    /** The first rule that claims `value`, or null. */
    export function tryToString(value: unknown, target: FilterValueTarget): FilterValueResult<string | null> | null {
        for (const c of specificConverters) {
            const r = c.tryGetExpression(value, target);
            if (r != null)
                return r;
        }
        return null;
    }

    /**
     * Why a stored string is unusable for this target, or null when nothing objects.
     *
     * Signum answers the TYPE the expression yields and checks it against the target; here every rule that
     * declines simply leaves the value to the primitive fallback, which accepts anything — so "no rule
     * objects" is the only success there is.
     */
    export function validationError(expression: string | null | undefined, target: FilterValueTarget): string | null {
        if (expression == null || expression === "")
            return null;

        for (const c of specificConverters) {
            const r = c.isValidExpression(expression, target);
            if (r != null)
                return r.ok ? null : r.error;
        }
        return null;
    }
}
