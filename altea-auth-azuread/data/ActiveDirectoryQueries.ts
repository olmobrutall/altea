import { reflect } from "@altea/altea/data/reflection";
import { ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { niceName } from "@altea/altea/data/decorators";
import { UserEntity } from "@altea/altea-auth/data/User";
import { ADGroupEntity } from "./ADGroup";

// The ROW SHAPES of the two directory-backed queries Signum registers in AzureADLogic.Start
// (`AzureADQuery.ActiveDirectoryUsers` / `.ActiveDirectoryGroups`) — a search page over Microsoft Graph
// rather than over the database.
//
// altea divergence: Signum names a manual query with an enum member and describes its columns with an
// anonymous `Select` projection plus `.ColumnDisplayName(…)` calls. altea has no QueryDescription: a query's
// shape IS a reflected type, and the query NAME is that type (see eastwind's CustomerRowModel and
// `QueryLogic.queries.register(Model, () => new ManualDynamicQueryCore(Model, …))`). So each projection
// becomes a ModelEntity here, and every `ColumnDisplayName` becomes the field's own `@niceName` —
// which also makes the captions translatable through the ordinary reflection path.
//
// `entity` is always null on these rows (there is no local entity behind a directory record); it exists
// because the SearchControl expects an entity column, exactly as in Signum's projection.

/** Signum's `OnPremisesExtensionAttributesModel`. */
@reflect
export class OnPremisesExtensionAttributesModel extends ModelEntity {
    extensionAttribute1: string | null = null;
    extensionAttribute2: string | null = null;
    extensionAttribute3: string | null = null;
    extensionAttribute4: string | null = null;
    extensionAttribute5: string | null = null;
    extensionAttribute6: string | null = null;
    extensionAttribute7: string | null = null;
    extensionAttribute8: string | null = null;
    extensionAttribute9: string | null = null;
    extensionAttribute10: string | null = null;
    extensionAttribute11: string | null = null;
    extensionAttribute12: string | null = null;
    extensionAttribute13: string | null = null;
    extensionAttribute14: string | null = null;
    extensionAttribute15: string | null = null;

    override toString(): string {
        return [this.extensionAttribute1, this.extensionAttribute2, this.extensionAttribute3]
            .filter(a => a != null).join(" ");
    }
}

/** The `ActiveDirectoryUsers` query row — one Microsoft Graph `user`. */
@reflect
export class ActiveDirectoryUserModel extends ModelEntity {
    /** Always null: a directory record has no local entity (Signum's `(Lite<Entity>?)null`). */
    entity: Lite<UserEntity> | null = null;

    /**
     * The directory object id. NOT called `id`: a member of that name is EXCLUDED from a query's token
     * tree (QueryToken.entityProperties skips it, because for a real entity the framework adds its own PK
     * token instead) — so a model field called `id` would be unreachable as a column or filter. The Graph
     * field it maps to is still `id`; MicrosoftGraphQueryConverter aliases it back (see its toGraphField).
     */
    @niceName("Id")
    objectId: string | null = null;

    @niceName("Display Name")
    displayName: string | null = null;

    userPrincipalName: string | null = null;

    @niceName("Mail")
    mail: string | null = null;

    @niceName("Given Name")
    givenName: string | null = null;

    @niceName("Surname")
    surname: string | null = null;

    @niceName("Job Title")
    jobTitle: string | null = null;

    department: string | null = null;
    officeLocation: string | null = null;
    employeeType: string | null = null;

    @niceName("On Premises Extension Attributes")
    onPremisesExtensionAttributes: OnPremisesExtensionAttributesModel | null = null;

    @niceName("On Premises Immutable Id")
    onPremisesImmutableId: string | null = null;

    @niceName("Company Name")
    companyName: string | null = null;

    creationType: string | null = null;

    @niceName("Account Enabled")
    accountEnabled: boolean | null = null;

    /**
     * A FILTER-ONLY column (Signum's `InGroup = (Lite<ADGroupEntity>?)null`): filtering on it switches the
     * Graph call to that group's `transitiveMembers`, so it never carries a value in a result row.
     */
    @niceName("In Group")
    inGroup: Lite<ADGroupEntity> | null = null;

    override toString(): string {
        return this.displayName ?? this.userPrincipalName ?? this.objectId ?? "";
    }
}

/** The `ActiveDirectoryGroups` query row — one Microsoft Graph `group`. */
@reflect
export class ActiveDirectoryGroupModel extends ModelEntity {
    entity: Lite<ADGroupEntity> | null = null;

    /**
     * The directory object id. NOT called `id`: a member of that name is EXCLUDED from a query's token
     * tree (QueryToken.entityProperties skips it, because for a real entity the framework adds its own PK
     * token instead) — so a model field called `id` would be unreachable as a column or filter. The Graph
     * field it maps to is still `id`; MicrosoftGraphQueryConverter aliases it back (see its toGraphField).
     */
    @niceName("Id")
    objectId: string | null = null;

    @niceName("Display Name")
    displayName: string | null = null;

    @niceName("Description")
    description: string | null = null;

    @niceName("Security Enabled")
    securityEnabled: boolean | null = null;

    @niceName("Visibility")
    visibility: string | null = null;

    /** A FILTER-ONLY column (Signum's `HasUser`): filtering on it asks for that user's `transitiveMemberOf`. */
    @niceName("Has User")
    hasUser: Lite<UserEntity> | null = null;

    override toString(): string {
        return this.displayName ?? this.objectId ?? "";
    }
}
