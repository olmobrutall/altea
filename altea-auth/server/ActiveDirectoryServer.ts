import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { Lite } from "@altea/altea/data/lite";
import { UserEntity } from "../data/User";
import { ActiveDirectoryPermission } from "../data/BaseAD";
import { PermissionAuthLogic } from "./PermissionAuthLogic";
import { AuthLogic } from "./AuthLogic";
import { isDirectoryInviter, type ExternalUser, type IDirectoryInviter } from "./ADAuthorizer";

// Port of Signum's `ActiveDirectoryController` (Signum.Authorization/BaseAD/ActiveDirectoryController.cs) —
// the two routes behind the "invite a user from the directory" UI. Provider-agnostic: they delegate to
// whatever `AuthLogic.authorizer` is, as long as it implements `IDirectoryInviter` (altea-auth-azuread and
// altea-auth-windowsad do).
//
// altea divergences:
//  - `ActiveDirectoryPermission.InviteUsersFromAD.AssertAuthorized()` becomes an explicit
//    `PermissionAuthLogic.isAuthorized` check (altea's permission API is async).
//  - `CancellationToken` becomes the request's `AbortSignal` where the provider accepts one.
//  - Signum's autocomplete request also carries a `types` field (it reuses `AutocompleteRequest`); it is
//    always `UserEntity` here, so the route takes just `subString` / `count`.

interface FindADUsersRequest { subString?: string; count?: string }

export namespace ActiveDirectoryServer {

    export function start(ws: WebBuilder): void {

        // GET /api/activeDirectory/canInviteUsers — whether THIS user may import from the directory.
        //
        // altea divergence: Signum gates the invite UI client-side with
        // `AppContext.isPermissionAuthorized(ActiveDirectoryPermission.InviteUsersFromAD)`, which works
        // because `ReflectionServer.RegisterLike(typeof(ActiveDirectoryPermission), () => …IsAuthorized())`
        // drops the permission container from the reflection blob for an unauthorized role, so mere
        // PRESENCE is the answer. altea's metadata blob carries no permissions, so the same
        // server-computed answer is served as one boolean the client reads once at start-up. (An
        // unauthorized client that ignores it still gets a 403 from the two routes below — the gate that
        // actually matters is on the server, exactly as in Signum.)
        ws.get("/api/activeDirectory/canInviteUsers",
            { res: CustomType<boolean>() },
            async (_req, res) => {
                res.jsonTyped(await PermissionAuthLogic.isAuthorized(ActiveDirectoryPermission.InviteUsersFromAD));
            });

        // GET /api/findADUsers?subString=…&count=… — search the directory.
        ws.get("/api/findADUsers",
            { params: CustomType<FindADUsersRequest>(), res: CustomType<ExternalUser[]>() },
            async (req, res) => {
                await assertInviteUsers();

                const query = (req as unknown as { query: Record<string, unknown> }).query;
                const subString = (query["subString"] as string | undefined) ?? "";
                const count = Number(query["count"] ?? 5);

                const users = await inviter().findUser(subString, Number.isFinite(count) ? count : 5);
                res.jsonTyped(users);
            });

        // POST /api/createADUser — import ONE directory hit as a local user.
        ws.post("/api/createADUser",
            { req: CustomType<ExternalUser>(), res: CustomType<Lite<UserEntity>>() },
            async (req, res) => {
                await assertInviteUsers();

                const external = (await req.jsonTyped()) as ExternalUser | undefined;
                if (external == null)
                    throw new Error("No ExternalUser in the request body");

                const user = await inviter().createFromExternalUser(external);
                res.jsonTyped(user.toLite());
            });
    }

    async function assertInviteUsers(): Promise<void> {
        if (!(await PermissionAuthLogic.isAuthorized(ActiveDirectoryPermission.InviteUsersFromAD)))
            throw new UnauthorizedAccessException(`Not authorized for '${ActiveDirectoryPermission.InviteUsersFromAD.key}'`);
    }

    /** Signum's `GetDirectoryInviter()`. */
    function inviter(): IDirectoryInviter {
        const authorizer = AuthLogic.authorizer;
        if (authorizer == null)
            throw new Error("No Authorizer set in AuthLogic");

        if (!isDirectoryInviter(authorizer))
            throw new Error(`${authorizer.constructor.name} does not support inviting users from a directory`);

        return authorizer;
    }
}
