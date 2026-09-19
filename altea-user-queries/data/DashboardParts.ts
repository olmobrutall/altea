// The `reflect` import must be PRESENT even where no class is decorated with it: the quote-transformer
// augments THIS import with the `field()` / `registerType()` helpers it injects for every entity field.
import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { part, backReference, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, ValidationMessage } from "@altea/altea/data/validators";
import { type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { type IPartEntity, tryGetDashboard } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "./UserQuery";

// Port of the DASHBOARD PART entities Signum declares in Signum.UserQueries/UserQueryEntity.cs —
// UserQueryPartEntity, ValueUserQueryListPartEntity (+ its element) and BigValuePartEntity. They live in this
// module (not in altea-dashboard) exactly as in Signum: the Dashboard package knows nothing about user
// queries; the app widens `DashboardEntity_Part.content`'s implementedBy list to include them (see eastwind's
// entityOverrides.data.ts).
//
// altea divergences, documented inline:
//  - Signum's `MList<ValueUserQueryElementEmbedded>` → per-owner `@part` rows (no MList in altea).
//  - The `IsQueryCached` flags are NOT ported: CachedQuery needs Signum.Files' FilePathEmbedded +
//    Signum.Scheduler, so altea's dashboard always queries live (see @altea/altea-dashboard's data header).
//  - `RequiresTitle` stays an entity member (the title validation is isomorphic); `Clone`/`ToXml`/`FromXml`
//    live in the server-side part registry — see server/UserQueriesDashboardXml.server.ts.
//  - Signum's `PropertyValidation`s on BigValuePart cross-check the OWNING dashboard's entityType through
//    `GetDashboard()`. altea's part HAS a parent pointer now: `@altea/altea-dashboard` marks
//    `DashboardEntity.parts` and `DashboardEntity_Part.content` `@bindParent`, exactly as Signum does, and
//    exposes `tryGetDashboard` for the two hops.

// Signum's AutoUpdate (UserQueryEntity.cs): after this part's data changes, refresh the rest of the dashboard.
export enum AutoUpdate {
    None,
    InteractionGroup,
    Dashboard,
}

// Signum's UserQueryPartEntity: a saved query rendered as a full SearchControl inside a dashboard cell.
@part
export class UserQueryPartEntity extends Entity implements IPartEntity {
    // Signum's IsQueryCached: this part's query is served from the dashboard's SNAPSHOT rather than run
    // against the database (see @altea/altea-dashboard's CachedQuery). Only meaningful on a dashboard whose
    // cacheQueryConfiguration is set.
    isQueryCached: boolean = false;

    userQuery: UserQueryEntity;

    autoUpdate: AutoUpdate = AutoUpdate.None;

    allowSelection: boolean = false;

    showFooter: boolean = false;

    createNew: boolean = false;

    allowMaxHeight: boolean = false;

    requiresTitle(): boolean {
        return false;
    }

    @quoted

    toString(): string {
        return this.userQuery?.toString() ?? "";
    }
}

// Signum's ValueUserQueryElementEmbedded: ONE row of the value list — a label + the saved query whose count
// (or aggregate) is shown, optionally linking somewhere else than the query itself.
@part
export class ValueUserQueryListPartEntity_UserQuery extends Entity {
    // Signum's IsQueryCached: this part's query is served from the dashboard's SNAPSHOT rather than run
    // against the database (see @altea/altea-dashboard's CachedQuery). Only meaningful on a dashboard whose
    // cacheQueryConfiguration is set.
    isQueryCached: boolean = false;

    @backReference valueUserQueryListPart: Lite<ValueUserQueryListPartEntity>;
    // No `@rowOrder`: Signum does not mark `ValueUserQueryListPartEntity.UserQueries` [PreserveOrder],
    // so its table has no Order column.

    @stringLengthValidator({ max: 200 })
    label: string | null;

    userQuery: UserQueryEntity;

    @stringLengthValidator({ max: 200 })
    href: string | null;

    toString(): string {
        return this.label ?? this.userQuery?.toString() ?? "";
    }
}

// Signum's ValueUserQueryListPartEntity: a compact list of "label → value" rows, one per saved query.
@part
export class ValueUserQueryListPartEntity extends Entity implements IPartEntity {
    userQueries: ValueUserQueryListPartEntity_UserQuery[];

    requiresTitle(): boolean {
        return true;
    }

    toString(): string {
        return `${this.userQueries?.length ?? 0} ${UserQueryPartMessage.UserQueries.niceToString()}`;
    }
}

// Signum's BigValuePartEntity: ONE number (a query count or an aggregate token) rendered large, optionally
// clickable / navigating somewhere.
@part
export class BigValuePartEntity extends Entity implements IPartEntity {
    // Signum's BigValuePartEntity.PropertyValidation, which turns on whether the dashboard it sits on is
    // scoped to an ENTITY TYPE (`tryGetDashboard`, the two `@bindParent` hops up):
    //
    //  - on a STANDALONE dashboard there is no entity for a bare token to be read off, so the number can
    //    only come from a user query — the query is mandatory and a token without one is meaningless;
    //  - on an ENTITY dashboard either source works (the token reads off the entity the dashboard is
    //    shown on), so exactly one of the two has to be there.
    //
    // A part not yet placed on a dashboard answers undefined and both rules stand down.
    @validate<BigValuePartEntity>((p, fi) => {
        const dashboard = tryGetDashboard(p);
        if (dashboard == null)
            return null;
        if (dashboard.entityType == null)
            return p.valueToken != null && p.userQuery == null
                ? ValidationMessage._0ShouldBeNull.niceToString(fi.niceToString()) : null;
        return bothUnset(p);
    })
    valueToken: QueryTokenEmbedded | null;

    @validate<BigValuePartEntity>((p, fi) => {
        const dashboard = tryGetDashboard(p);
        if (dashboard == null)
            return null;
        return dashboard.entityType == null
            ? (p.userQuery == null ? ValidationMessage._0IsNotSet.niceToString(fi.niceToString()) : null)
            : bothUnset(p);
    })
    userQuery: UserQueryEntity | null;

    customBigValue: string | null;

    navigate: boolean = false;

    customUrl: string | null;

    isClickable: boolean | null;

    requiresTitle(): boolean {
        return false;
    }

    @quoted

    toString(): string {
        return this.userQuery?.toString() ?? this.valueToken?.tokenString ?? "";
    }
}

/** The shared half of the two rules above: on an ENTITY dashboard a big value needs one source or the other. */
function bothUnset(p: BigValuePartEntity): string | null {
    return p.userQuery == null && p.valueToken == null
        ? ValidationMessage._0Or1ShouldBeSet.niceToString(
            BigValuePartEntity.nicePropertyName("userQuery"), BigValuePartEntity.nicePropertyName("valueToken"))
        : null;
}

// altea-only message container for the part toStrings Signum expressed with NicePluralName.
export const UserQueryPartMessage = {
    UserQueries: msg("User queries"),
};
