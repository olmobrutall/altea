import "@altea/altea/server"; // installs Entity.save()/delete()
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Lite } from "@altea/altea/data/lite";
import { UserEntity, UserState } from "../data/User";
import { RoleEntity } from "../data/Role";
import { LoginAuthMessage } from "../data/AuthMessages";
import { BaseADConfigurationEmbedded, ActiveDirectoryAuthorizerMessage } from "../data/BaseAD";
import { AuthLogic, type ICustomAuthorizer } from "./AuthLogic";

// Port of Signum's directory-authorizer BASE: the parts that `AzureADAuthorizer`, `OpenIDAuthorizer` and
// `WindowsADAuthorizer` (Signum.Authorization.*/Authorizer/*.cs) implement IDENTICALLY — matching a
// directory identity to a local user, creating one, refreshing one, and resolving its role from the
// configured group→role mapping. Signum copy-pastes ~120 lines into each of the three; altea factors them
// into `ADAuthorizer` and leaves each module only what genuinely differs.
//
// The ONE thing that differs is HOW the directory reports a user's groups, so that is the single overridable
// hook (`getDirectoryGroups`). Everything else — the match order, the auto-create/auto-update rules, the
// role fallback, the "external identity clears the local password" rule — is shared.
//
// altea divergences, documented inline:
//  - `IAutoCreateUserContext` is an INTERFACE with plain readonly members (Signum's C# properties). Each
//    module's context object implements it; nothing is virtual, so a subclass simply supplies its own.
//  - `OperationLogic.AllowSave<UserEntity>()` has no counterpart (altea has no RequiresSaveOperation
//    guard): `AuthLogic.withDisabled` + `ExecutionMode.global` IS the trusted scope.
//  - `GraphExplorer.IsGraphModified(user)` → `user.isDirty()` (altea's snapshot-based dirty check).
//  - `user.CultureInfo = CultureServer.InferUserCulture(...)` is omitted: altea has no CultureInfoEntity
//    on the user (see data/User.ts), and the user's culture lives in the BROWSER (see CLAUDE.md).
//  - `new Transaction()` becomes `Transaction.create` (join-or-open — the same semantics).

/** Signum's `ExternalUser` (ICustomAuthorizer.cs) — one hit from a directory search. */
export interface ExternalUser {
    displayName: string;
    /** userPrincipalName / the directory's login name. */
    upn: string;
    jobTitle: string;
    /** The directory's stable identifier — an Entra object id, a Windows SID, an OIDC "sub". */
    externalId: string | null;
}

/** Signum's `IDirectoryInviter` — an authorizer that can also SEARCH the directory and import a user. */
export interface IDirectoryInviter {
    findUser(subString: string, count: number, signal?: AbortSignal): Promise<ExternalUser[]>;
    createFromExternalUser(user: ExternalUser): Promise<UserEntity>;
}

/** Signum's `IAutoCreateUserContext` — everything the authorizer needs about a directory identity. */
export interface IAutoCreateUserContext {
    readonly config: BaseADConfigurationEmbedded;
    readonly userName: string;
    readonly emailAddress: string | null;
    readonly firstName: string;
    readonly lastName: string;
    readonly externalId: string | null;
}

/** A directory group, in the only two shapes a `roleMapping` entry can name it by. */
export interface DirectoryGroup {
    id: string | null;
    displayName: string | null;
}

export function isDirectoryInviter(value: unknown): value is IDirectoryInviter {
    const v = value as Partial<IDirectoryInviter> | null;
    return v != null && typeof v.findUser === "function" && typeof v.createFromExternalUser === "function";
}

/**
 * The shared half of Signum's three `*ADAuthorizer` classes. A module subclasses it, supplies its
 * configuration and (optionally) the directory-group lookup, and overrides `login` only if it can
 * authenticate against the directory itself (WindowsAD's LDAP bind is the only one that can).
 */
export abstract class ADAuthorizer<TConfig extends BaseADConfigurationEmbedded> implements ICustomAuthorizer {

    /** Signum's `Func<TConfig?> GetConfig` — a callback, so the host can re-read a changed configuration. */
    constructor(readonly getConfig: () => TConfig | null) { }

    /** Signum's `Login`: by default the local database is the only credential store (an interactive
     *  directory sign-in happens through the module's own endpoint, not through /api/auth/login). */
    async login(username: string, password: string): Promise<{ user: UserEntity; authenticationType: string }> {
        return await AuthLogic.login(username, password);
    }

    /**
     * The groups the directory reports for this identity, or null when the module cannot ask (in which
     * case only `defaultRole` applies). Signum's three implementations: Microsoft Graph
     * `transitiveMemberOf`, the OIDC role claim, and `UserPrincipal.GetGroups`.
     */
    protected getDirectoryGroups(_ctx: IAutoCreateUserContext): Promise<DirectoryGroup[] | null> {
        return Promise.resolve(null);
    }

    /**
     * Signum's `GetRole`: the roles reached by the matching `roleMapping` entries, several matches merged
     * into one trivial-merge role, else `defaultRole`. A `roleMapping` entry matches a group by DISPLAY
     * NAME or by ID (Signum tries `Guid.TryParse` on the mapping value and compares both).
     */
    async getRole(ctx: IAutoCreateUserContext, throwIfNull: boolean): Promise<Lite<RoleEntity> | null> {
        const config = ctx.config;

        const roleMapping = config.roleMappings();
        if (roleMapping.length > 0) {
            const groups = await this.getDirectoryGroups(ctx);
            if (groups != null) {
                const roles = roleMapping
                    .filter(m => groups.some(g => g.displayName === m.adNameOrGuid || g.id === m.adNameOrGuid))
                    .map(m => m.role)
                    .filter((r): r is Lite<RoleEntity> => r != null);

                if (roles.length > 0)
                    return await AuthLogic.getOrCreateTrivialMergeRole(roles);

                if (config.defaultRole == null && throwIfNull)
                    throw new Error("No Default Role set and no matching RoleMapping found for any group:\n"
                        + groups.map(g => (g.id ?? "") + ": " + (g.displayName ?? "")).join("\n"));
            }
        }

        if (config.defaultRole != null)
            return config.defaultRole;

        if (throwIfNull)
            throw new Error("No default role set");

        return null;
    }

    /** Signum's `OnCreateUser` — build and persist the local user for a directory identity. */
    async onCreateUser(ctx: IAutoCreateUserContext): Promise<UserEntity> {
        return await Transaction.create(async () => {
            const user = await this.createUserInternal(ctx);
            if (user.isNew)
                await AuthLogic.withDisabled(() => ExecutionMode.global(() => user.save()));
            return user;
        });
    }

    /** Signum's `CreateUserInternal`. */
    async createUserInternal(ctx: IAutoCreateUserContext): Promise<UserEntity> {
        const result = UserEntity.create({
            userName: ctx.userName,
            passwordHash: null,
            email: ctx.emailAddress,
            role: (await this.getRole(ctx, /* throwIfNull */ true))!,
            state: UserState.Active,
        });

        this.updateUserInternal(result, ctx);
        return result;
    }

    /** Signum's `UpdateUserInternal` — refresh the local row from the directory identity. */
    updateUserInternal(user: UserEntity, ctx: IAutoCreateUserContext): void {
        if (user.state === UserState.AutoDeactivate) {
            user.state = UserState.Active;
            user.disabledOn = null;
        }

        if (ctx.externalId != null) {
            user.externalId = ctx.externalId;
            // A user owned by the directory carries no local password (see UserEntity's externalId
            // validation), unless the host explicitly allows both.
            if (!UserEntity.allowPasswordForUserWithExternalId) {
                user.passwordHash = null;
                user.mustChangePassword = false;
            }
        }

        user.userName = ctx.userName;

        if (ctx.emailAddress != null && ctx.emailAddress !== "")
            user.email = ctx.emailAddress;
    }

    /** Signum's `UpdateUser` — refresh, and save only if something actually changed. */
    async updateUser(user: UserEntity, ctx: IAutoCreateUserContext): Promise<void> {
        await Transaction.create(async () => {
            this.updateUserInternal(user, ctx);

            if (user.isDirty())
                await AuthLogic.withDisabled(() => ExecutionMode.global(() => user.save()));
        });
    }

    /**
     * The match-then-create/update core every module's login endpoint runs once the directory has
     * authenticated the caller (Signum repeats it verbatim in `AzureADAuthenticationServer`,
     * `OpenIDAuthenticationServer` and `WindowsADServer`).
     *
     * Match order (Signum's): `externalId`, then exact `userName`, then — only when
     * `allowMatchUsersBySimpleUserName` and the directory name looks like an address — `email` or the
     * local part before the "@".
     */
    async findOrCreateUser(ctx: IAutoCreateUserContext): Promise<UserEntity> {
        const config = ctx.config;
        let user = await this.tryFindUser(ctx.externalId, ctx.userName, config.allowMatchUsersBySimpleUserName);

        if (user == null) {
            if (!config.autoCreateUsers)
                throw new Error(LoginAuthMessage.NoLocalUserFound.niceToString());

            user = await this.onCreateUser(ctx);
        } else {
            if (user.state === UserState.Deactivated)
                throw new Error(LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));

            if (config.autoUpdateUsers)
                await this.updateUser(user, ctx);
        }

        if (user.state === UserState.Deactivated)
            throw new Error(LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));

        return user;
    }

    /** The match half of `findOrCreateUser`, reusable on its own (the invite-a-user flow needs it). */
    async tryFindUser(externalId: string | null, userName: string, allowSimpleUserName: boolean): Promise<UserEntity | null> {
        if (externalId != null) {
            const byExternalId = await table(UserEntity).filter(u => u.externalId == externalId).singleOrNull() as UserEntity | null;
            if (byExternalId != null)
                return byExternalId;
        }

        const byUserName = await table(UserEntity).filter(u => u.userName == userName).singleOrNull() as UserEntity | null;
        if (byUserName != null)
            return byUserName;

        if (allowSimpleUserName && userName.includes("@")) {
            const simpleName = userName.substring(0, userName.indexOf("@"));
            return await table(UserEntity)
                .filter(u => u.email == userName || u.userName == simpleName)
                .firstOrNull() as UserEntity | null;
        }

        return null;
    }

    /** Signum's `ActiveDirectoryUser0IsNotAssociatedWithAUserInThisApplication` — the message a module
     *  raises when auto-create is off and nothing matched. */
    protected notAssociated(localName: string): Error {
        return new Error(ActiveDirectoryAuthorizerMessage
            .ActiveDirectoryUser0IsNotAssociatedWithAUserInThisApplication.niceToString(localName));
    }
}
