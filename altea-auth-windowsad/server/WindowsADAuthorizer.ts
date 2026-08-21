import {
    ADAuthorizer, type DirectoryGroup, type ExternalUser, type IAutoCreateUserContext, type IDirectoryInviter,
} from "@altea/altea-auth/server/ADAuthorizer";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { UserEntity, UserState } from "@altea/altea-auth/data/User";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import { WindowsADConfigurationEmbedded } from "../data/WindowsAD";
import { WindowsADLogic } from "./WindowsADLogic";
import { WindowsDirectory, localNameOf, type DirectoryUser } from "./WindowsDirectory";

// Port of Signum.Authorization.WindowsAD's Authorizer/WindowsADAuthorizer.cs +
// Authorizer/DirectoryServiceAutoCreateUserContext.cs.
//
// This is the ONE authorizer of the three that can authenticate a typed password itself: `login` tries the
// local database FIRST (Signum: "Database is faster than Active Directory"), then a directory bind, then the
// database again so the ordinary failure messages come out of AuthLogic.
//
// altea divergences, documented inline:
//  - `UserPrincipal` → a `DirectoryUser` read over LDAP (see WindowsDirectory's header).
//  - `catch (PrincipalServerDownException) { /* ignore */ }` becomes a narrower guard: an INVALID CREDENTIAL
//    is a false from `validateCredentials`, and any other failure (host unreachable) propagates rather than
//    being swallowed as "wrong password". Signum swallows the server-down case so login falls through to the
//    database; that behaviour is kept, but only for connection failures, and it is logged by the caller.

/** Signum's DirectoryServiceAutoCreateUserContext. */
export class DirectoryServiceContext implements IAutoCreateUserContext {

    constructor(
        readonly config: WindowsADConfigurationEmbedded,
        /** The sAMAccountName — Signum's `localName`, which becomes the local `userName`. */
        readonly userName: string,
        /** What the directory was searched BY (a UPN or `DOMAIN\user`) — Signum's IdentityValue. */
        readonly identityValue: string,
        private user: DirectoryUser | null = null,
    ) { }

    /** Signum's `GetUserPrincipal()` — resolved once, lazily. */
    async getDirectoryUser(): Promise<DirectoryUser> {
        this.user ??= await WindowsDirectory.findByIdentity(this.config, this.identityValue);
        if (this.user == null)
            throw new Error(`No Active Directory user found for '${this.identityValue}'`);
        return this.user;
    }

    /** The already-resolved directory user, if any (the synchronous property accessors need one). */
    get resolved(): DirectoryUser | null {
        return this.user;
    }

    get emailAddress(): string | null { return this.user?.mail ?? null; }
    get firstName(): string { return this.user?.givenName ?? this.userName; }
    get lastName(): string { return this.user?.surname ?? "Unknown"; }
    get externalId(): string | null { return this.user?.sid ?? null; }
}

export class WindowsADAuthorizer extends ADAuthorizer<WindowsADConfigurationEmbedded> implements IDirectoryInviter {

    /**
     * Signum's `Login`: the local database first (a DB round trip beats an LDAP bind), then the directory,
     * then the database again — so a user who exists locally with a wrong password gets AuthLogic's normal
     * `IncorrectPassword`, not a directory error.
     */
    override async login(userName: string, password: string): Promise<{ user: UserEntity; authenticationType: string }> {
        // A probe, not a login: `tryRetrieveUser` does not touch the failed-attempt counter.
        if ((await AuthLogic.tryRetrieveUser(userName, password)) != null)
            return await AuthLogic.login(userName, password);

        const user = await this.loginWithWindowsADRegistry(userName, password);
        if (user != null)
            return { user, authenticationType: "adRegistry" };

        return await AuthLogic.login(userName, password);
    }

    /** Signum's `LoginWithWindowsADRegistry` — validate the credential by binding to the directory. */
    async loginWithWindowsADRegistry(userName: string, password: string): Promise<UserEntity | null> {
        return await AuthLogic.withDisabled(async () => {
            const config = this.getConfig();
            if (config == null || !config.loginWithActiveDirectoryRegistry)
                return null;

            if (!(await WindowsDirectory.validateCredentials(config, userName, password)))
                return null;

            const localName = localNameOf(userName);
            const ctx = new DirectoryServiceContext(config, localName, userName);
            await ctx.getDirectoryUser();

            // Signum matches by SID first, then falls back to the local name through AuthLogic.
            const user = await this.tryFindUser(ctx.externalId, localName, config.allowMatchUsersBySimpleUserName);

            if (user != null) {
                await this.updateUser(user, ctx);

                if (user.state === UserState.Deactivated)
                    throw new Error(LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));

                AuthLogic.onUserLogingIn(user, "LoginWithWindowsADRegistry");
                return user;
            }

            if (!config.autoCreateUsers)
                throw this.notAssociated(localName);

            const created = await this.onCreateUser(ctx);

            if (created.state === UserState.Deactivated)
                throw new Error(LoginAuthMessage.User0IsDeactivated.niceToString(created.userName));

            AuthLogic.onUserLogingIn(created, "LoginWithWindowsADRegistry");
            return created;
        });
    }

    /** Signum's `GetRole`'s directory half: the user's transitive AD groups, by NAME and by objectGUID. */
    protected override async getDirectoryGroups(ctx: IAutoCreateUserContext): Promise<DirectoryGroup[] | null> {
        if (!(ctx instanceof DirectoryServiceContext))
            return null;

        const user = await ctx.getDirectoryUser();
        const groups = await WindowsDirectory.getGroups(ctx.config, user.dn);
        return groups.map(g => ({ id: g.guid, displayName: g.name }));
    }

    // ---- IDirectoryInviter -----------------------------------------------------------------------------

    findUser(subString: string, count: number): Promise<ExternalUser[]> {
        return WindowsADLogic.searchUser(subString, count);
    }

    createFromExternalUser(user: ExternalUser): Promise<UserEntity> {
        return WindowsADLogic.createUserFromAD(user);
    }
}
