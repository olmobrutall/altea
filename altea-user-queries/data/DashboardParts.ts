// The `reflect` import must be PRESENT even where no class is decorated with it: the quote-transformer
// augments THIS import with the `field()` / `registerType()` helpers it injects for every entity field.
import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, backReference, rowOrder, stringLengthValidator } from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import type { IPartEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "./UserQuery";

// Port of the DASHBOARD PART entities Signum declares in Signum.UserQueries/UserQueryEntity.cs —
// UserQueryPartEntity, ValueUserQueryListPartEntity (+ its element) and BigValuePartEntity. They live in this
// module (not in altea-dashboard) exactly as in Signum: the Dashboard package knows nothing about user
// queries; the app widens `PanelPartEmbedded.content`'s implementedBy list to include them (see eastwind's
// entityOverrides.data.ts).
//
// altea divergences, documented inline:
//  - Signum's `MList<ValueUserQueryElementEmbedded>` → per-owner `@part` rows (no MList in altea).
//  - The `IsQueryCached` flags are NOT ported: CachedQuery needs Signum.Files' FilePathEmbedded +
//    Signum.Scheduler, so altea's dashboard always queries live (see @altea/altea-dashboard's data header).
//  - `RequiresTitle` stays an entity member (the title validation is isomorphic); `Clone`/`ToXml`/`FromXml`
//    live in the server-side part registry — see server/UserQueriesDashboardXml.server.ts.
//  - Signum's `PropertyValidation`s on BigValuePart (which cross-check the OWNING dashboard's entityType via
//    GetDashboard()) are dropped: an altea part has no parent pointer, and the editor already surfaces the
//    mismatch (getEntityTypeHelpText).

// Signum's AutoUpdate (UserQueryEntity.cs): after this part's data changes, refresh the rest of the dashboard.
export enum AutoUpdateEnum {
    None,
    InteractionGroup,
    Dashboard,
}

// Signum's UserQueryPartEntity: a saved query rendered as a full SearchControl inside a dashboard cell.
@entity("Part", "Master")
export class UserQueryPartEntity extends Entity implements IPartEntity {
    userQuery: UserQueryEntity;

    autoUpdate: AutoUpdateEnum = AutoUpdateEnum.None;

    allowSelection: boolean = false;

    showFooter: boolean = false;

    createNew: boolean = false;

    allowMaxHeight: boolean = false;

    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.userQuery?.toString() ?? "";
    }
}

// Signum's ValueUserQueryElementEmbedded: ONE row of the value list — a label + the saved query whose count
// (or aggregate) is shown, optionally linking somewhere else than the query itself.
@entity("Part")
export class ValueUserQueryElementEmbedded extends Entity {
    @backReference valueUserQueryListPart: Lite<ValueUserQueryListPartEntity>;
    @rowOrder order: int = toInt(0);

    @stringLengthValidator({ max: 200 })
    label: string | null = null;

    userQuery: UserQueryEntity;

    @stringLengthValidator({ max: 200 })
    href: string | null = null;

    toString(): string {
        return this.label ?? this.userQuery?.toString() ?? "";
    }
}

// Signum's ValueUserQueryListPartEntity: a compact list of "label → value" rows, one per saved query.
@entity("Part", "Master")
export class ValueUserQueryListPartEntity extends Entity implements IPartEntity {
    userQueries: ValueUserQueryElementEmbedded[];

    requiresTitle(): boolean {
        return true;
    }

    toString(): string {
        return `${this.userQueries?.length ?? 0} ${UserQueryPartMessage.UserQueries.niceToString()}`;
    }
}

// Signum's BigValuePartEntity: ONE number (a query count or an aggregate token) rendered large, optionally
// clickable / navigating somewhere.
@entity("Part", "Master")
export class BigValuePartEntity extends Entity implements IPartEntity {
    valueToken: QueryTokenEmbedded | null = null;

    userQuery: UserQueryEntity | null = null;

    customBigValue: string | null = null;

    navigate: boolean = false;

    customUrl: string | null = null;

    isClickable: boolean | null = null;

    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.userQuery?.toString() ?? this.valueToken?.tokenString ?? "";
    }
}

// altea-only message container for the part toStrings Signum expressed with NicePluralName.
export const UserQueryPartMessage = {
    UserQueries: msg("User queries"),
};
