import { reflect } from "@altea/altea/data/reflection";
import { EmbeddedEntity, Entity } from "@altea/altea/data/entity";
import { column, serialize, stringLengthValidator, rowOrder } from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import {
    PinnedFilterActiveEnum, FilterGroupOperationEnum, FilterOperationEnum, DashboardBehaviourEnum,
} from "@altea/altea/data/dynamicQueries";
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
    tokenString: string;

    // The resolved token — filled client-side from `tokenString` (Finder.TokenCompleter). Never a column,
    // never serialized (altea resolves tokens on the client; the server only ever sees `tokenString`).
    @column(false) @serialize(false)
    token: QueryToken | null;

    // The parse error message when `tokenString` no longer resolves against the query (client-filled).
    @column(false) @serialize(false)
    parseException: string | null;

    toString(): string {
        return this.tokenString;
    }
}

@reflect
export class PinnedQueryFilterEmbedded extends EmbeddedEntity {
    // Signum's `[StringLengthValidator(Max = 100), Translatable] Label`.
    @stringLengthValidator({ max: 100 })
    label: string | null;

    column: int | null;

    colSpan: int | null;

    row: int | null;

    // Signum's PinnedFilterActive (default Always). A real altea enum (int FK to the enum table,
    // translatable); the in-memory value is the numeric ordinal, the wire/XML form is the member name.
    active: PinnedFilterActiveEnum = PinnedFilterActiveEnum.Always;

    splitValue: boolean = false;

    toString(): string {
        return this.label ?? "";
    }
}

// The shared filter ROW (Signum's QueryFilterEmbedded, Queries/QueryFilterEmbedded.cs): one row of a stored
// filter tree — either a condition (token + operation + valueString) or a group header (isGroup +
// groupOperation), positioned in the tree by `indentation`.
//
// ABSTRACT (`@reflect`, not `@entity`) so it has no table of its own: every stored query definition owns its
// own filter rows, and an altea `@part` row belongs to exactly ONE owner, so each owner subclasses this and
// adds nothing but its `@backReference` — @altea/altea-user-queries' UserQueryEntity_Filter and
// @altea/altea-chart's UserChartEntity_Filter. That is what lets one filter editor
// (altea-user-queries' FilterBuilderEmbedded) drive both. Signum needed no such base: there the ONE
// QueryFilterEmbedded is an EmbeddedEntity reused by every owner's MList.
//
// It lives in altea-user-assets alongside the other owner-agnostic pieces of a stored query
// (QueryTokenEmbedded, PinnedQueryFilterEmbedded), which is what both packages already depend on.
@reflect
export abstract class QueryFilterBaseEntity extends Entity {
    @rowOrder order: int;

    token: QueryTokenEmbedded | null;
    isGroup: boolean = false;
    // Real altea enums (int FK to the enum table, translatable) — Signum's enum columns. The in-memory
    // value is the numeric ordinal; the wire/XML/query form is the member name (Enum.toName). See dynamicQueries.
    groupOperation: FilterGroupOperationEnum | null;
    operation: FilterOperationEnum | null;
    valueString: string | null;
    pinned: PinnedQueryFilterEmbedded | null;
    dashboardBehaviour: DashboardBehaviourEnum | null;
    indentation: int = toInt(0);
}
