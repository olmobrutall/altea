import "@altea/altea/server"; // installs Entity.save()/delete()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Operations } from "@altea/altea/server/operationLogic";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { UserEntity, UserOperation, UserState } from "@altea/altea-auth/data/User";
import { ActiveDirectoryPermission } from "@altea/altea-auth/data/BaseAD";
import type { ExternalUser } from "@altea/altea-auth/server/ADAuthorizer";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic.server";
import { WindowsADConfigurationEmbedded, WindowsADTask } from "../data/WindowsAD";
import { DirectoryServiceContext, WindowsADAuthorizer } from "./WindowsADAuthorizer";
import { WindowsADServer } from "./WindowsADServer";
import { WindowsDirectory, localNameOf } from "./WindowsDirectory";

// Port of Signum.Authorization.WindowsAD's WindowsADLogic.cs — start-up plus every directory operation:
// search, import a user, read a thumbnail photo, and the nightly deactivate-users sweep.
//
// altea divergences, documented inline:
//  - Every `System.DirectoryServices` call goes through WindowsDirectory (see its header).
//  - `ReflectionServer.RegisterLike(typeof(WindowsADTask) / typeof(ActiveDirectoryPermission), …)` is NOT
//    ported (altea's reflection blob carries no message/permission containers — see altea-omnibox's note).
//  - `Lite.RegisterLiteModelConstructor` is NOT ported (altea has no lite-model entity).
//  - Signum's sweep deactivates a user with `UserOperation.Deactivate`; altea uses `AutoDeactivate`, the
//    state that exists precisely to mean "the directory did this, not an administrator" — and which
//    `ADAuthorizer.updateUserInternal` reverses automatically when the user comes back. Signum's own Azure AD
//    sweep uses AutoDeactivate; the Windows one using Deactivate looks like an oversight, and using it here
//    would leave a re-enabled account stuck (a `Deactivated` user cannot be auto-reactivated on login).
//  - `CheckAllUserActive()` (an empty method in Signum) is not ported.

export namespace WindowsADLogic {

    /** The authorizer this module installed (also reachable as `AuthLogic.authorizer`). */
    export let authorizer: WindowsADAuthorizer | undefined;

    export interface StartOptions {
        getConfig: () => WindowsADConfigurationEmbedded | null;
        /** Signum's `deactivateUsersTask`. */
        deactivateUsersTask?: boolean;
    }

    /** Signum's `WindowsADLogic.Start(sb, deactivateUsersTask)` plus the Starter's `AuthLogic.Authorizer = …`. */
    export function start(sb: SchemaBuilder, options: StartOptions): void {
        if (sb.alreadyDefined(start))
            return;

        authorizer = new WindowsADAuthorizer(options.getConfig);
        AuthLogic.authorizer = authorizer;

        // Signum's `PermissionLogic.RegisterTypes(typeof(ActiveDirectoryPermission))`: in altea a symbol is
        // seeded merely by being declared and imported, so referencing it here is what registers it.
        void ActiveDirectoryPermission.InviteUsersFromAD;

        if (options.deactivateUsersTask)
            registerDeactivateUsersTask();

        if (sb.webBuilder)
            WindowsADServer.start(sb.webBuilder);
    }

    export function requireConfig(): WindowsADConfigurationEmbedded {
        const config = authorizer?.getConfig() ?? null;
        if (config == null)
            throw new Error("No WindowsADConfiguration is set");
        return config;
    }

    /**
     * Signum's `SimpleTaskLogic.Register(WindowsADTask.DeactivateUsers, …)`. Two directions:
     *  - an ACTIVE local user who is disabled in AD (or gone from AD and has no local password, so AD is
     *    their only credential) is auto-deactivated;
     *  - an AUTO-DEACTIVATED local user who is enabled again in AD is reactivated.
     */
    function registerDeactivateUsersTask(): void {
        SimpleTaskLogic.register(WindowsADTask.DeactivateUsers, async ctx => {
            const config = requireConfig();
            const users = await table(UserEntity).toArray() as UserEntity[];

            await ctx.forEach(users, u => u.userName, async u => {
                const found = await WindowsDirectory.findByIdentity(config, u.userName);

                if (u.state === UserState.Active) {
                    if (found != null && found.enabled === false) {
                        ctx.writeLine(`User ${u.id} (${u.userName}) with SID ${u.externalId} has been deactivated in AD`);
                        await Operations.execute(u, UserOperation.AutoDeactivate);
                        return;
                    }

                    // Gone from AD AND with no local password: nothing left to log in with.
                    if (found == null && u.passwordHash == null) {
                        ctx.writeLine(`User ${u.id} (${u.userName}) with SID ${u.externalId} is no longer in AD`);
                        await Operations.execute(u, UserOperation.AutoDeactivate);
                    }
                    return;
                }

                if (u.state === UserState.AutoDeactivate && found != null && found.enabled === true) {
                    ctx.writeLine(`User ${u.id} (${u.userName}) with SID ${u.externalId} has been reactivated in AD`);
                    await Operations.execute(u, UserOperation.Reactivate);
                }
            });

            return null;
        });
    }

    /** Signum's `SearchUser(searchUserName, limit)`. */
    export async function searchUser(subString: string, limit: number): Promise<ExternalUser[]> {
        const config = requireConfig();
        const found = await WindowsDirectory.searchUsers(config, subString, limit);

        return found.map(u => ({
            upn: u.userPrincipalName ?? "",
            displayName: u.displayName ?? "",
            // Signum maps the AD `description` onto JobTitle (AD has no jobTitle attribute by default).
            jobTitle: u.description ?? "",
            externalId: u.sid,
        }));
    }

    /** Signum's `CreateUserFromAD(adUser)` — import a directory hit as a local user (or refresh it). */
    export async function createUserFromAD(adUser: ExternalUser): Promise<UserEntity> {
        const config = requireConfig();
        const ada = authorizer!;

        const directoryUser = await WindowsDirectory.findByIdentity(config, adUser.upn);
        if (directoryUser == null)
            throw new Error(`No Active Directory user found for '${adUser.upn}'`);

        const localName = directoryUser.sAMAccountName ?? localNameOf(adUser.upn);
        const ctx = new DirectoryServiceContext(config, localName, adUser.upn, directoryUser);

        return await ExecutionMode.global(() => Transaction.create(async () => {
            const existing = await ada.tryFindUser(ctx.externalId, localName, config.allowMatchUsersBySimpleUserName);

            if (existing != null) {
                if (config.autoUpdateUsers)
                    await ada.updateUser(existing, ctx);
                return existing;
            }

            return await ada.onCreateUser(ctx);
        }));
    }

    /** Signum's `GetProfilePicture(userName)` — the AD `thumbnailPhoto`. */
    export async function getProfilePicture(userName: string): Promise<Buffer | null> {
        return await AuthLogic.withDisabled(async () => {
            const config = requireConfig();
            return await WindowsDirectory.getThumbnailPhoto(config, userName);
        });
    }

    /** Signum's `CheckUserActive(username)` — whether AD says the account is enabled. */
    export async function checkUserActive(userName: string): Promise<boolean> {
        const config = requireConfig();
        const found = await WindowsDirectory.findByIdentity(config, userName);
        return found?.enabled === true;
    }
}
