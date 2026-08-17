import { reflect } from "@altea/altea/data/reflection";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import { column, serialize, stringLengthValidator } from "@altea/altea/data/decorators";
import { type int } from "@altea/altea/data/basics";
import { PinnedFilterActiveEnum } from "@altea/altea/data/dynamicQueries";
import { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";

// Port of Signum's Signum.UserAssets/Queries/QueryTokenEmbedded.cs + PinnedQueryFilterEmbedded.cs (and
// their client twin Signum.UserAssets.Queries.ts). The OWNER-AGNOSTIC value embeddeds shared by every
// stored query definition (a UserQuery filter/column/order token; a filter's pinning). They flatten into
// whichever owner table embeds them, so they live in the shared altea-user-assets package.
//
// altea divergences, documented inline:
//  - Signum's `[Ignore] QueryToken token` (the resolved token) + `Exception? parseException` are transient
//    (never columns). altea's client resolves tokens LOCALLY from `tokenString` (Finder.TokenCompleter /
//    parseSingleToken — there is no server QueryTokenTS round-trip), so `token` is `@column(false)
//    @serialize(false)` (client-only, never persisted or wired) and `parseException` is a plain string
//    filled client-side when a stored token no longer resolves.

@reflect
export class QueryTokenEmbedded extends EmbeddedEntity {
    // Signum's `[StringLengthValidator(Min = 1, Max = 200), NotNullValidator] TokenString`. The token's
    // rootless fullKey (altea tokens are rootless: "Customer.Name", "Id", "ToString").
    @stringLengthValidator({ min: 1, max: 200 })
    tokenString: string = "";

    // The resolved token — filled client-side from `tokenString` (Finder.TokenCompleter). Never a column,
    // never serialized (altea resolves tokens on the client; the server only ever sees `tokenString`).
    @column(false) @serialize(false)
    token: QueryToken | null = null;

    // The parse error message when `tokenString` no longer resolves against the query (client-filled).
    @column(false) @serialize(false)
    parseException: string | null = null;

    toString(): string {
        return this.tokenString;
    }
}

@reflect
export class PinnedQueryFilterEmbedded extends EmbeddedEntity {
    // Signum's `[StringLengthValidator(Max = 100), Translatable] Label`.
    @stringLengthValidator({ max: 100 })
    label: string | null = null;

    column: int | null = null;

    colSpan: int | null = null;

    row: int | null = null;

    // Signum's PinnedFilterActive (default Always). A real altea enum (int FK to the enum table,
    // translatable); the in-memory value is the numeric ordinal, the wire/XML form is the member name.
    active: PinnedFilterActiveEnum = PinnedFilterActiveEnum.Always;

    splitValue: boolean = false;

    toString(): string {
        return this.label ?? "";
    }
}
