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
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic";
import { WindowsADConfigurationEmbedded, WindowsADTask } from "../data/WindowsAD";
import { DirectoryServiceContext, WindowsADAuthorizer } from "./WindowsADAuthorizer";
import { WindowsADServer } from "./WindowsADServer";
import { WindowsDirectory, localNameOf } from "./WindowsDirectory";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";

// Start-up plus every directory operation: search, import a user, read a thumbnail photo, and the nightly
// deactivate-users sweep. Every directory call goes through WindowsDirectory.
//
// **The sweep uses `AutoDeactivate`, not `Deactivate`** — the state that exists precisely to mean "the
// directory did this, not an administrator", and which `ADAuthorizer.updateUserInternal` reverses
// automatically when the user comes back. `Deactivate` would leave a re-enabled account stuck, since a
// Deactivated user cannot be auto-reactivated on login. See port/AuthDirectory.md.

export namespace WindowsADLogic {

    /**
     * The application's authorizer when it is a WindowsAD one, else undefined. The APPLICATION installs
     * `AuthLogic.authorizer` in its Starter; the configuration comes from that object.
     */
    export function authorizer(): WindowsADAuthorizer | undefined {
        return AuthLogic.authorizer instanceof WindowsADAuthorizer ? AuthLogic.authorizer : undefined;
    }

    export interface StartOptions {
        /** Register the nightly sweep that deactivates users the directory no longer has. */
        deactivateUsersTask?: boolean;
    }

    /** The module's start-up. It does NOT install an authorizer: the application's Starter does. */
    export function start(sb: SchemaBuilder, options: StartOptions = {}): void {
        if (sb.alreadyDefined(start))
            return;

        // The same container
        // the AzureAD module registers.
        PermissionLogic.registerContainer(ActiveDirectoryPermission);

        if (options.deactivateUsersTask)
            registerDeactivateUsersTask();

        if (sb.webBuilder)
            WindowsADServer.start(sb.webBuilder);
    }

    export async function requireConfig(): Promise<WindowsADConfigurationEmbedded> {
        const config = await authorizer()?.getConfig() ?? null;
        if (config == null)
            throw new Error("No WindowsADConfiguration is set");
        return config;
    }

    /**
     * The nightly sweep. Two directions:
     *  - an ACTIVE local user who is disabled in AD (or gone from AD and has no local password, so AD is
     *    their only credential) is auto-deactivated;
     *  - an AUTO-DEACTIVATED local user who is enabled again in AD is reactivated.
     */
    function registerDeactivateUsersTask(): void {
        SimpleTaskLogic.register(WindowsADTask.DeactivateUsers, async ctx => {
            const config = await requireConfig();
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

    /** Find directory users by name, for the invite / import UI. */
    export async function searchUser(subString: string, limit: number): Promise<ExternalUser[]> {
        const config = await requireConfig();
        const found = await WindowsDirectory.searchUsers(config, subString, limit);

        return found.map(u => ({
            upn: u.userPrincipalName ?? "",
            displayName: u.displayName ?? "",
            // AD has no jobTitle attribute by default, so `description` stands in for it.
            jobTitle: u.description ?? "",
            externalId: u.sid,
        }));
    }

    /** Import a directory hit as a local user (or refresh it). */
    export async function createUserFromAD(adUser: ExternalUser): Promise<UserEntity> {
        const config = await requireConfig();
        const ada = authorizer()!;

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

    /** The AD `thumbnailPhoto`. */
    export async function getProfilePicture(userName: string): Promise<Buffer | null> {
        return await AuthLogic.withDisabled(async () => {
            const config = await requireConfig();
            return await WindowsDirectory.getThumbnailPhoto(config, userName);
        });
    }

    /** Whether AD says the account is enabled. */
    export async function checkUserActive(userName: string): Promise<boolean> {
        const config = await requireConfig();
        const found = await WindowsDirectory.findByIdentity(config, userName);
        return found?.enabled === true;
    }
}
