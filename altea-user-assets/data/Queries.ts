import { reflect, setDefaultDatabaseSchema, MAX_SIZE } from "@altea/altea/data/reflection";
import { EmbeddedEntity, Entity } from "@altea/altea/data/entity";
import { column, serialize, rowOrder } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { type int, toInt } from "@altea/altea/data/basics";
import {
    PinnedFilterActive, FilterGroupOperation, FilterOperation, DashboardBehaviour,
} from "@altea/altea/data/dynamicQueries";
import { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";

// Port of Signum.UserAssets' Queries/QueryTokenEmbedded.cs + PinnedQueryFilterEmbedded.cs — see
// port/UserAssets.md. The OWNER-AGNOSTIC value embeddeds every stored query definition is built from
// (a filter/column/order token; a filter's pinning). They flatten into whichever owner table embeds them,
// which is why they live in this shared package.

@reflect
export class QueryTokenEmbedded extends EmbeddedEntity {
    // The token's rootless fullKey — altea tokens carry no root: "Customer.Name", "Id", "ToString".
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

    /** Signum's QueryTokenEmbedded.Clone(). The resolved `token` rides along (it is the same token,
     *  and re-resolving it is a client round-trip); neither it nor `parseException` is persisted. */
    clone(): QueryTokenEmbedded {
        return QueryTokenEmbedded.create({ tokenString: this.tokenString, token: this.token });
    }
}

@reflect
export class PinnedQueryFilterEmbedded extends EmbeddedEntity {
    @stringLengthValidator({ max: 100 })
    label: string | null;

    column: int | null;

    colSpan: int | null;

    row: int | null;

    // A real altea enum (int FK to the enum table, translatable), so the in-memory value is the numeric
    // ORDINAL while the wire / XML form is the member name.
    active: PinnedFilterActive = PinnedFilterActive.Always;

    splitValue: boolean = false;

    toString(): string {
        return this.label ?? "";
    }

    /** Signum's PinnedQueryFilterEmbedded.Clone(). */
    clone(): PinnedQueryFilterEmbedded {
        return PinnedQueryFilterEmbedded.create({
            label: this.label,
            column: this.column,
            colSpan: this.colSpan,
            row: this.row,
            active: this.active,
            splitValue: this.splitValue,
        });
    }
}

// The shared filter ROW: one row of a stored filter tree — either a condition (token + operation + valueString) or a group header (isGroup +
// groupOperation), positioned in the tree by `indentation`.
//
// ABSTRACT (`@reflect`, not `@entity`) so it has no table of its own: every stored query definition owns its
// own filter rows, and an altea `@part` row belongs to exactly ONE owner, so each owner subclasses this and
// adds nothing but its `@backReference` — @altea/altea-user-queries' UserQueryEntity_Filter and
// @altea/altea-chart's UserChartEntity_Filter. That is what lets one filter editor
// (altea-user-queries' FilterBuilderEmbedded) drive both.
//
// It lives in altea-user-assets alongside the other owner-agnostic pieces of a stored query
// (QueryTokenEmbedded, PinnedQueryFilterEmbedded), which is what both packages already depend on.
@reflect
export abstract class QueryFilterBaseEntity extends Entity {
    @rowOrder order: int;

    token: QueryTokenEmbedded | null;
    isGroup: boolean = false;
    // Real altea enums (int FK to the enum table, translatable), so the in-memory value is the numeric
    // ORDINAL while the wire / XML / query form is the member name (Enum.toName). See dynamicQueries.
    groupOperation: FilterGroupOperation | null;
    operation: FilterOperation | null;
    // Signum's `[StringLengthValidator(Max = int.MaxValue)]` — a stored filter value can be a whole list of
    // ids, so the 200-character default a sizeless string column now takes would truncate the filter.
    @stringLengthValidator({ max: MAX_SIZE })
    valueString: string | null;
    pinned: PinnedQueryFilterEmbedded | null;
    dashboardBehaviour: DashboardBehaviour | null;
    indentation: int = toInt(0);

    /**
     * Signum's QueryFilterEmbedded.Clone(). Signum has ONE filter embedded shared by every owner and so
     * ONE Clone; altea has a filter ROW per owner (six subclasses of this base, each adding only its
     * `@backReference`), so the copy lives here and mints the SAME row type it was called on —
     * `entity.constructor`, altea's stand-in for Signum's `GetType()`.
     *
     * `@rowOrder` and the `@backReference` are deliberately left unset: the save cascade fills both from
     * the array the clone is placed into.
     *
     * DIVERGENCE (a fix, not a port): Signum's Clone omits `DashboardBehaviour`, so cloning a UserQuery
     * whose filter drives a dashboard interaction silently turns it back into an ordinary filter.
     */
    clone(): this {
        const target = new (this.constructor as new () => this)();
        target.token = this.token?.clone() ?? null;
        target.isGroup = this.isGroup;
        target.groupOperation = this.groupOperation;
        target.operation = this.operation;
        target.valueString = this.valueString;
        target.pinned = this.pinned?.clone() ?? null;
        target.dashboardBehaviour = this.dashboardBehaviour;
        target.indentation = this.indentation;
        return target;
    }
}

// The database schema this package's tables live in. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("userAssets");
