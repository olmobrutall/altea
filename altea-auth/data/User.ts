import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, column, uniqueIndex, quoted, serialize,
    stringLengthValidator, emailValidator, fieldValidation,
} from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol } from "@altea/altea/data/operations";
import { CurrentUser, UserWithClaims, type IUserEntity, type IEmailOwnerEntity } from "@altea/altea/data/security";
import { RoleEntity } from "./Role";
import { TypeConditionSymbol } from "./Rules";
import { AuthAdminMessage, UserExternalIdMessage } from "./AuthMessages";

// Port of Signum's UserEntity (Signum.Authorization/UserEntity.cs). The application user: a login name,
// a password hash, a role, and an activation state machine (New → Active ⇄ Deactivated/AutoDeactivate).
//
// altea divergences, documented inline:
//  - `byte[]? PasswordHash [DbType(Size=128)]` → a `Uint8Array | null` binary column (the "Blob" value
//    type → bytea / varbinary(128)); server code works in Buffers (a Buffer IS a Uint8Array). @serialize(false)
//    so it never reaches the client.
//  - `CultureInfoEntity? CultureInfo` is omitted — no CultureInfoEntity is ported to altea yet.
//  - `UserTypeCondition` (a TypeConditionSymbol) and `UserLiteModel` land with the authorization /
//    client phases respectively (TypeConditionSymbol is an authorization type; UserLiteModel needs the
//    client custom-lite wiring).
//  - `UserEntity.Current` / `CurrentExternalId` are server-only in Signum (they read UserHolder);
//    altea declares them here as `current()` / `currentExternalId()` and they answer on BOTH tiers, through
//    the injected `CurrentUser` provider (data/security). Same for `RoleEntity.current()`.
//  - `PropertyValidation` → per-field `@fieldValidation` (altea has no entity-level validation hook).

// Signum's UserState (UserEntity.cs). New = -1 (the pre-Create sentinel); the rest are the live states.
// A plain numeric entity enum (like OrderState), used directly by the UserGraph state machine.
export enum UserState {
    New = -1,
    Active,
    Deactivated,
    AutoDeactivate,
}

@reflect
@entity("Main", "Transactional")
export class UserEntity extends Entity implements IUserEntity, IEmailOwnerEntity {
    @uniqueIndex
    @stringLengthValidator({ min: 2, max: 100 })
    userName: string;

    // Signum's `byte[]? PasswordHash [DbType(Size=128)]` — the PBKDF2 hash as raw bytes. The isomorphic
    // type is `Uint8Array` (the data layer has no node types; a Node `Buffer`, which the server stores and
    // reads, IS a Uint8Array), mapped to a bytea / varbinary(128) column (the "Blob" value type).
    // @serialize(false): the hash NEVER crosses the wire — not sent to the client (Signum suppresses it via
    // CustomWriteJsonProperty) and not accepted from it. Set server-side only (login/changePassword/seed).
    // Because a client save carries no hash and altea UPDATEs every column, UserGraph.Save preserves the
    // stored hash for an existing user (see AuthLogic.server.ts) so an admin edit doesn't wipe it.
    @serialize(false)
    @column({ size: 128 })
    passwordHash: Uint8Array | null = null;

    // Signum's [Ignore] PasswordIsChanging — a transient flag (not a column). Its presence when saving
    // means a password change was started but not completed (Signum's PropertyValidation).
    @column(false)
    @fieldValidation<UserEntity>((u) =>
        u.passwordIsChanging ? AuthAdminMessage.PasswordChangeIsNotCompleted.niceToString() : null)
    passwordIsChanging: boolean = false;

    role: Lite<RoleEntity>;

    @stringLengthValidator({ max: 200 })
    @emailValidator()
    email: string | null = null;

    disabledOn: Temporal.PlainDateTime | null = null;

    mustChangePassword: boolean = false;

    // Signum's PropertyValidation: if disabled, the state must be a disabled one.
    @fieldValidation<UserEntity>((u) =>
        u.disabledOn != null && u.state !== UserState.Deactivated && u.state !== UserState.AutoDeactivate
            ? AuthAdminMessage.TheUserStateMustBeDisabled.niceToString()
            : null)
    state: UserState = UserState.New;

    loginFailedCounter: number = 0;

    // Signum's `UserEntity.AllowPasswordForUserWithExternalId` static flag — when false (the default) a
    // user linked to an external identity provider (Azure AD / OpenID / a Windows domain) may NOT also
    // carry a local password, so the directory is the single source of truth. A host that wants both sets
    // it to true at startup.
    static allowPasswordForUserWithExternalId: boolean = false;

    @uniqueIndex
    @stringLengthValidator({ max: 500 })
    // Signum's PropertyValidation on ExternalId: refuse the combination of an external identity and a
    // local password hash unless the host opted in.
    @fieldValidation<UserEntity>((u) =>
        u.externalId != null && u.passwordHash != null && !UserEntity.allowPasswordForUserWithExternalId
            ? UserExternalIdMessage.TheUser0IsConnectedToAnExternalProviderAndCanNotHaveALocalPasswordSet.niceToString(u.userName)
            : null)
    externalId: string | null = null;

    @quoted
    toString(): string {
        return this.userName;
    }

    /**
     * Signum's `UserEntity.Current` (`(Lite<UserEntity>)UserHolder.Current?.User!`), and — unlike Signum's,
     * which is server-only — it answers on BOTH TIERS: the server resolves it from the request's user
     * scope, the client from the logged-in user (see `CurrentUser` in altea's data/security).
     *
     * A LITE, as in Signum: the server has only the lite (plus the claims) once the token is decoded, so
     * that is the shape both tiers can honour. Null when nobody is logged in — where Signum's `!` would
     * NullReference, because a nullable type says it better than a crash does.
     */
    static current(): Lite<UserEntity> | null {
        return (CurrentUser.current()?.user as Lite<UserEntity> | undefined) ?? null;
    }

    /** Signum's `UserEntity.CurrentExternalId` — the external identity claim of the current login. */
    static currentExternalId(): string | null {
        return CurrentUser.claim<string>("ExternalId");
    }
}

// Signum's `[AutoInit] static class UserTypeCondition` (UserEntity.cs) — a framework-declared
// TypeConditionSymbol. `DeactivatedUsers` scopes a role to only the deactivated user rows; its predicate
// (`u => u.state == "Deactivated"`) is registered in TypeAuthLogic.start.
export namespace UserTypeCondition {
    export const DeactivatedUsers: TypeConditionSymbol = init();
}

// Signum's `[AutoInit] static class UserOperation`.
export namespace UserOperation {
    export const Create: ConstructSymbol<UserEntity> = init();
    export const Save: ExecuteSymbol<UserEntity> = init();
    export const Reactivate: ExecuteSymbol<UserEntity> = init();
    export const Deactivate: ExecuteSymbol<UserEntity> = init();
    export const AutoDeactivate: ExecuteSymbol<UserEntity> = init();
    export const Delete: DeleteSymbol<UserEntity> = init();
}

// ---- The current user, on BOTH tiers -----------------------------------------------------------------

// Signum's `UserWithClaims.FillClaims += …` (in AuthLogic.Start, i.e. server-only): stamp Role / ExternalId
// onto the claims bag whenever a UserWithClaims is built from a full user. It lives HERE, in the data
// layer, because altea builds a UserWithClaims on both tiers — the server per request (UserHolder) and the
// client on every login (AppContext) — and a filler declared once serves both. That is what makes
// `RoleEntity.current()` answer in a React component as well as in a query.
// (Culture is omitted: altea's CultureInfoEntity is not carried in the claims.)
UserWithClaims.fillClaims.push((uwc, user) => {
    const u = user as UserEntity;
    uwc.claims["Role"] = u.role;
    uwc.claims["ExternalId"] = u.externalId;
});
