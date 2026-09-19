import type { FilterTypeKeys } from "@altea/altea/data/dynamicQueries";

// The converter CONTRACT, ported from Signum.UserAssets' `IFilterValueConverter` / `Result<T>`
// (FilterValueConverter.cs). It sits in its own file only so the registry may import the converters and
// the converters the contract without a cycle — see FilterValueConverter.ts for the registry itself.

/**
 * What a stored filter value is being converted FOR.
 *
 * Signum passes the .NET `targetType`; altea has no runtime Type here (this is the DATA layer, shared with
 * the browser), so the two facts a converter actually needs travel instead: the token's FilterType, and —
 * when the caller knows it — the token's own value type name, which is the only way to tell a `PlainDate`
 * token from a `PlainDateTime` one (both are FilterType "DateTime").
 */
export interface FilterValueTarget {
    filterType: FilterTypeKeys | undefined;
    /** `"PlainDate"` / `"PlainDateTime"` / …, when the caller has the token. */
    typeName?: string | undefined;
}

/** Signum's `Result<T>.Success` / `Result<T>.Error` as a discriminated union. */
export type FilterValueResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: string };

export const FilterValueResult = {
    success<T>(value: T): FilterValueResult<T> { return { ok: true, value }; },
    error<T>(error: string): FilterValueResult<T> { return { ok: false, error }; },
};

/**
 * One rule for translating a filter value to and from its stored string form.
 *
 * Every method answers `null` for "not mine", which is what lets the registry try them in order — the
 * whole shape of Signum's `SpecificConverters` list.
 */
export interface IFilterValueConverter {
    /** The typed value → its stored string. */
    tryGetExpression(value: unknown, target: FilterValueTarget): FilterValueResult<string | null> | null;

    /** The stored string → the typed value. */
    tryParseExpression(expression: string, target: FilterValueTarget): FilterValueResult<unknown> | null;

    /**
     * Is the stored string still meaningful for this target?
     *
     * Signum answers `Result<Type>` — the type the expression yields, which it then checks is convertible
     * to the target. There is no runtime Type to answer with here and every caller only wants "valid, or
     * why not", so the success payload is the expression's own canonical spelling.
     */
    isValidExpression(expression: string, target: FilterValueTarget): FilterValueResult<string> | null;
}
