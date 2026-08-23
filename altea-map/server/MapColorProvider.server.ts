import type { TableInfo } from "../data/Map";

// Port of Signum.Map's MapColorProvider.cs — the SERVER half of a colour provider: it does not compute a
// colour (that is the client's `ClientColorProvider`), it only ANNOUNCES that an entry should appear in the
// page's "Color" dropdown, and optionally stuffs whatever data that colouring needs into each table's
// `extra` bag. The pair is deliberate: the palette / scale is a d3 concern and lives in the browser; only
// the server knows the role rules the auth colouring reads.
//
// altea divergences:
//  - Signum registers providers with `MapColorProvider.GetColorProviders += () => new[]{…}` (a C#
//    multicast delegate) and guards two of them with an `if (Schema.Current.Tables.Any(…))` evaluated AT
//    START TIME. Here the registry is a plain array of FACTORIES and each factory decides for itself,
//    per request — so a provider can no longer be registered against a half-built schema, and a factory
//    may also return nothing (the shape Signum's AuthColorProvider already used).
//  - `Order` stays a number and is applied by the reader, mirroring Signum (auth providers sort last).
export interface MapColorProvider {
    /** Matches the CLIENT provider's `name` — the page throws if the two lists don't line up exactly. */
    name: string;
    niceName: string;
    /** Fills `table.extra` with whatever the matching client provider reads. */
    addExtra?: (table: TableInfo) => void;
    order?: number;
}

export namespace MapColorProvider {

    /** Signum's `GetColorProviders` multicast delegate — each entry may contribute zero or more providers. */
    export const getColorProviders: (() => MapColorProvider[] | Promise<MapColorProvider[]>)[] = [];

    /** Every provider the current request may offer, in Signum's order (`OrderBy(a => a.Order)`). */
    export async function all(): Promise<MapColorProvider[]> {
        const result: MapColorProvider[] = [];
        for (const factory of getColorProviders)
            result.push(...await factory());
        return result.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
}
