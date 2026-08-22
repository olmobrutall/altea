import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { stringLengthValidator } from "@altea/altea/data/decorators";
import { msg } from "@altea/altea/data/utils/localization";
import { RoleEntity } from "./Role";
import { PermissionSymbol } from "./Rules";

// Port of Signum's BaseAD layer (Signum.Authorization/BaseAD/BaseADConfigurationEmbedded.cs +
// Signum.Authorization.BaseAD.ts) — the pieces EVERY directory-backed login module shares: how a
// directory identity is mapped onto a local UserEntity (auto-create / auto-update / role mapping) and the
// messages + permission the "invite a user from the directory" UI speaks.
//
// It lives in altea-auth (not in one of the AD packages) for exactly Signum's reason: `Signum.Authorization`
// owns `ICustomAuthorizer` / `IAutoCreateUserContext`, and the three concrete modules
// (@altea/altea-auth-azuread, -openid, -windowsad) each subclass this configuration. A module that only
// needs the mapping semantics therefore depends on altea-auth alone.
//
// altea divergences, documented inline:
//  - the configuration is a `@part` ENTITY, not an embedded: `MList<RoleMappingEmbedded> RoleMapping` is a
//    COLLECTION, and altea has no MList — a collection is `@part` child rows, whose back reference needs a
//    real owner TABLE, which a flattened embedded is not. (This is the same reshaping altea-email applied to
//    `SmtpNetworkDeliveryEmbedded`, which owns `clientCertificationFiles`.) The Signum NAMES are kept, suffix
//    included, so the two stay comparable. An application persists it by REFERENCING it from its own
//    configuration entity — eastwind's `ApplicationConfigurationEntity.azureAD`, mirroring Southwind.
//  - the ROW TYPE is declared per module, not here: a `@part` collection is keyed by ONE back reference to
//    its owner's table, so a shared row type would make the three directories read each other's rows. Hence
//    the abstract `RoleMappingEmbedded` below plus one concrete row per module, and `roleMappings()` — the
//    accessor the shared ADAuthorizer reads, since the base cannot name the subclass's row type.
//  - `[PreserveOrder]` is not modelled (`@rowOrder` would be an extra column for an order nothing reads);
//    the rows' natural order IS the order.
//  - Signum's `PropertyValidation` override becomes per-field `@fieldValidation` in each SUBCLASS (altea
//    has no entity-level validation hook), so nothing to override here.

/**
 * Signum's RoleMappingEmbedded — "directory group X grants application role Y".
 *
 * ABSTRACT: each directory module declares the concrete row that back-references ITS configuration table
 * (see the header). Never included on its own — only its subclasses get tables.
 */
@reflect
export abstract class RoleMappingEmbedded extends Entity {
    /** The directory group's display name OR its GUID/objectGUID — whichever the directory reports. */
    @stringLengthValidator({ max: 100 })
    adNameOrGuid: string;

    role: Lite<RoleEntity>;

    toString(): string {
        return `${this.adNameOrGuid ?? ""} → ${this.role?.toString() ?? ""}`;
    }
}

/**
 * Signum's BaseADConfigurationEmbedded — the mapping half of every directory login module: whether a
 * directory user with no local row may be created, whether an existing row is refreshed on each login,
 * and which local role a directory group grants.
 *
 * Abstract on purpose (Signum's is concrete but never used directly): the three modules each add their own
 * connection settings on top.
 */
@reflect
export abstract class BaseADConfigurationEmbedded extends Entity {
    /** Match a directory "user@domain" against a local `userName` of just "user" (and against `email`). */
    allowMatchUsersBySimpleUserName: boolean = true;

    /** Create a local UserEntity the first time a directory user signs in. */
    autoCreateUsers: boolean = false;

    /** Refresh userName / email / externalId from the directory on every sign-in. */
    autoUpdateUsers: boolean = false;

    /** The role a user gets when no `roleMapping` entry matches. */
    defaultRole: Lite<RoleEntity> | null = null;

    /**
     * This configuration's group→role mappings. Each module declares the FIELD (`roleMapping`) with its own
     * row type and implements this accessor, because the row type cannot be shared — see the header. It is
     * what the shared ADAuthorizer reads.
     */
    abstract roleMappings(): RoleMappingEmbedded[];
}

// ---- Messages -------------------------------------------------------------------------------------------

export const ActiveDirectoryAuthorizerMessage = {
    ActiveDirectoryUser0IsNotAssociatedWithAUserInThisApplication:
        msg("Active Directory user '{0}' is not associated with a user in this application."),
};

/** Signum's `[AllowUnauthenticated] enum UserADMessage` — spoken by the invite-from-directory UI. */
export const UserADMessage = {
    Find0InActiveDirectory: msg("Find '{0}' in Active Directory"),
    FindInActiveDirectory: msg("Find in Active Directory"),
    NoUserContaining0FoundInActiveDirectory: msg("No user containing '{0}' found in Active Directory"),
    SelectActiveDirectoryUser: msg("Select Active Directory User"),
    PleaseSelectTheUserFromActiveDirectoryThatYouWantToImport:
        msg("Please select the user from Active Directory that you want to import"),
    NameOrEmail: msg("Name or e-Mail"),
};

/** Signum's `enum ActiveDirectoryMessage` — the column captions of the directory-backed queries. */
export const ActiveDirectoryMessage = {
    Id: msg(),
    DisplayName: msg("Display Name"),
    Mail: msg(),
    GivenName: msg("Given Name"),
    Surname: msg(),
    JobTitle: msg("Job Title"),
    OnPremisesImmutableId: msg("On Premises Immutable Id"),
    CompanyName: msg("Company Name"),
    AccountEnabled: msg("Account Enabled"),
    OnPremisesExtensionAttributes: msg("On Premises Extension Attributes"),
    OnlyActiveUsers: msg("Only Active Users"),
    InGroup: msg("In Group"),
    Description: msg(),
    SecurityEnabled: msg("Security Enabled"),
    Visibility: msg(),
    HasUser: msg("Has User"),
};

// ---- Permission -----------------------------------------------------------------------------------------

// Signum's `[AutoInit] static class ActiveDirectoryPermission` — as in altea-omnibox, reusing altea-auth's
// ONE PermissionSymbol table: the quote-transformer rewrites `init()` into
// `init(PermissionSymbol, "ActiveDirectoryPermission.InviteUsersFromAD", …)`, so merely importing this
// module (the AD logics do) puts it in the declared-symbol set SymbolLogic seeds.
export namespace ActiveDirectoryPermission {
    export const InviteUsersFromAD: PermissionSymbol = init();
}
