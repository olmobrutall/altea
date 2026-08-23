import "@altea/altea/server";
import type { WebBuilder } from "@altea/altea/server/webApi";
import { WebSocketHub, type HubConnection } from "@altea/altea/server/webSocketHub";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import type { Schema } from "@altea/altea/server/schema/schema";
import { Lite } from "@altea/altea/data/lite";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import { CustomType } from "@altea/altea/server/webApi";
import { AuthTokenServer } from "@altea/altea-auth/server/AuthTokenServer";
import { UserEntity } from "@altea/altea-auth/data/User";
import { CacheLogic } from "@altea/altea-cache/server/CacheLogic";
import { ConcurrentUserEntity } from "../data/ConcurrentUser";
import { ConcurrentUserLogic } from "./ConcurrentUserLogic.server";

// Port of Signum.ConcurrentUser's ConcurrentUserServer.cs + ConcurrentUserHub.cs + ConcurrentUserController.cs
// — the whole server surface, in one file because the hub, the push and the query are one mechanism.
//
// WHAT IT DOES (unchanged from Signum): every open entity is a GROUP named by its lite key. A tab joins on
// mount and leaves on unmount; presence rows in ConcurrentUserEntity make the membership queryable. Two
// pushes go the other way: `ConcurrentUsersChanged` (someone joined / left / started typing → re-read the
// list) and `EntitySaved` (the row's `ticks` moved → your copy is stale).
//
// altea divergences, documented inline:
//  - SignalR → altea's WebSocket hub (altea/server/webSocketHub.ts). `Clients.Group(k).Method(...)` becomes
//    `hub.sendToGroup(k, "Method", ...)`, `Context.ConnectionId` becomes `conn.id`, and `IHubFilter`
//    (LogHubExceptionFilter.cs) becomes `hub.onError` — one hook instead of a filter class, since every
//    throw already funnels through the hub.
//  - hub methods carry NO ambient transaction or user (a WebSocket frame is not an HTTP request), so each
//    opens its own `Transaction.forceNew` and runs under `ExecutionMode.global` — altea's `AuthLogic.Disable()`
//    — with the CONNECTION's authenticated user, not the `userKey` the client passes. Signum trusts that
//    argument; here the socket is authenticated (see webSocketHub.ts) so the server can do better, and a tab
//    can no longer register presence as somebody else. The parameter is still accepted, and ignored.
//  - `OperationLogic.AllowSave<ConcurrentUserEntity>()` has no counterpart: altea does not enforce
//    "requires a save operation" yet, so a direct `.save()` is already allowed.
//  - the `#if DEBUG` w3wp check that sets `DisableSignalR` (IIS's connection limit on Windows client OS) is
//    not ported — it is diagnosing a Windows-only hosting quirk of a server altea does not run on. The
//    client-side escape hatch it fed (`window.__disableWebSockets`) IS kept, so a host can still set it.
export namespace ConcurrentUserServer {

    export let hub: WebSocketHub | undefined;

    const hubPath = "/api/concurrentUserHub";

    /** Signum's broadcast method names (CacheLogic.BroadcastReceivers keys). */
    const Method_ConcurrentUsersChanged = "ConcurrentUsersChanged";
    const Method_EntitySaved = "EntitySaved";

    /** Signum's `Transaction.UserData["SavedEntities"]` key. */
    const savedEntitiesKey = "ConcurrentUser_SavedEntities";

    export function start(wsb: WebBuilder, schema: Schema): void {
        if (hub != undefined)
            return;

        hub = buildHub();
        wsb.webSocket(hub);

        wsb.get("/api/concurrentUser/getUsers/:liteKey",
            { params: CustomType<{ liteKey: string }>(), res: CustomType<ConcurrentUserResponse[]>() },
            async (req, res) => {
                const { liteKey } = (req as unknown as { params: { liteKey: string } }).params;
                const lite = Lite.parse(decodeURIComponent(liteKey));
                // Signum's `using (AuthLogic.Disable())`: presence is not the entity, and a user who can
                // see the page must be able to see who else is on it.
                const rows = await ExecutionMode.global(() => table(ConcurrentUserEntity)
                    .filter(c => c.targetEntity.is(lite))
                    .toArray());

                res.jsonTyped(rows.map(cu => ({
                    user: cu.user,
                    startTime: cu.startTime.toString(),
                    connectionID: cu.connectionID,
                    isModified: cu.isModified,
                } satisfies ConcurrentUserResponse)));
            });

        // Watch every type the predicate accepts (Signum attaches the same two events per type through a
        // GenericInvoker). `schemaCompleted` is the point where every table is known.
        schema.schemaCompleted.push(() => {
            for (const type of schema.tables.keys()) {
                if (ConcurrentUserLogic.watchSaveFor(type))
                    attachSchemaEvents(schema, type);
            }
        });

        CacheLogic.registerBroadcastReceiver(Method_ConcurrentUsersChanged, arg =>
            notifyConcurrentUsersChanged(new Set(arg.split("/"))));

        CacheLogic.registerBroadcastReceiver(Method_EntitySaved, arg =>
            notifyEntitySaved(new Map(arg.split("/").map(a => {
                const [key, ticks] = [a.slice(0, a.indexOf("|")), a.slice(a.indexOf("|") + 1)];
                return [key, ticks === "" ? null : Number(ticks)] as const;
            }))));
    }

    // ---- the hub (Signum's ConcurrentUserHub) ------------------------------------------------------

    function buildHub(): WebSocketHub {
        const h = new WebSocketHub(hubPath);

        // A browser WebSocket cannot send `Authorization`, so the token rides the first frame and is
        // validated through the SAME authenticator chain an HTTP request uses (see webSocketHub.ts).
        h.authenticate = async token => {
            if (token == null || token === "")
                throw new Error("ConcurrentUserHub: no authentication token");

            const fakeReq = {
                header: (name: string) => name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined,
                hasQuery: () => false,
                // A WebSocket upgrade carries no query string here — the token is the first FRAME, so no
                // authenticator in the chain can authenticate on a query parameter over this transport.
                query: () => [],
            };
            const fakeRes = { setHeader: () => { /* a socket cannot carry New_Token; the next ajax refreshes */ } };

            for (const authenticator of AuthTokenServer.authenticators) {
                const user = await Transaction.forceNew(() => authenticator(fakeReq, fakeRes));
                if (user != null)
                    return user;
            }
            throw new Error("ConcurrentUserHub: the token did not resolve to a user");
        };

        h.onError = (e, context) => {
            // Signum's LogHubExceptionFilter: log it, don't lose it. The write needs its own transaction
            // (a failed hub method may have rolled its own back) — the lesson from the scheduler port.
            void ExecutionMode.global(() => Transaction.forceNew(() => ExceptionLogic.logException(e, ex => {
                ex.controllerName = context;
            }))).catch(inner => console.error("[concurrentUser] could not log:", inner, "original:", e));
        };

        h.methods["EnterEntity"] = (conn, liteKey: string) => runOnConnection(conn, async () => {
            const lite = Lite.parse(liteKey);
            await cleanConcurrentUsersIfNeeded();

            await ConcurrentUserEntity.create({
                targetEntity: lite,
                user: currentUserLite(conn),
                startTime: Clock.now,
                connectionID: conn.id,
                // Explicit, not a field initializer: a non-nullable field must be SET by whoever creates the
                // row (altea's implicit NotNull validator rejects `undefined`), and C#'s `bool` gives Signum
                // this `false` for free. The repo's convention keeps zero-value initializers off the entity.
                isModified: false,
            }).save();

            updateConcurrentUsers(new Set([liteKey]));
            conn.hub.addToGroup(conn, liteKey);
        });

        h.methods["EntityModified"] = (conn, liteKey: string, _userKey: string, modified: boolean) => runOnConnection(conn, async () => {
            const lite = Lite.parse(liteKey);
            const user = currentUserLite(conn);
            const connectionID = conn.id;

            await table(ConcurrentUserEntity)
                .filter(a => a.targetEntity.is(lite) && a.user.is(user) && a.connectionID == connectionID)
                .executeUpdate(() => ({ isModified: modified }));

            updateConcurrentUsers(new Set([liteKey]));
        });

        h.methods["ExitEntity"] = (conn, liteKey: string) => runOnConnection(conn, async () => {
            const lite = Lite.parse(liteKey);
            const user = currentUserLite(conn);
            const connectionID = conn.id;

            await table(ConcurrentUserEntity)
                .filter(a => a.targetEntity.is(lite) && a.user.is(user) && a.connectionID == connectionID)
                .executeDelete();

            updateConcurrentUsers(new Set([liteKey]));
            conn.hub.removeFromGroup(conn, liteKey);
        });

        // Signum's OnDisconnectedAsync: a closed tab leaves its rows behind, so drop them all and tell the
        // groups they were in. (The hub has already emptied `conn.groups` by the time this runs, so the
        // notification targets are read from the DELETED rows, exactly as Signum does.)
        h.onDisconnected = conn => ExecutionMode.global(() => Transaction.forceNew(async () => {
            const connectionID = conn.id;
            const rows = await table(ConcurrentUserEntity)
                .filter(a => a.connectionID == connectionID)
                .toArray();

            if (rows.length === 0)
                return;

            await table(ConcurrentUserEntity)
                .filter(a => a.connectionID == connectionID)
                .executeDelete();

            updateConcurrentUsers(new Set(rows.map(a => a.targetEntity.key())));
        }));

        return h;
    }

    /** The authenticated user of this socket (see the divergence note: NOT the client-supplied userKey). */
    function currentUserLite(conn: HubConnection): Lite<UserEntity> {
        const user = (conn.user as { user?: Lite<Entity> } | undefined)?.user;
        if (user == null)
            throw new Error("ConcurrentUserHub: the connection has no authenticated user");
        return user as Lite<UserEntity>;
    }

    /** Every hub method body: the connection's user, authorization off, its own transaction. */
    function runOnConnection(conn: HubConnection, body: () => Promise<void>): Promise<void> {
        const user = conn.user;
        const run = (): Promise<void> => ExecutionMode.global(() => Transaction.forceNew(body));
        return user == null ? run() : UserHolder.withUser(user as never, run);
    }

    /** Signum's CleanConcurrentUsersIfNeeded — 1-in-100 sweep of rows older than a day. */
    async function cleanConcurrentUsersIfNeeded(): Promise<void> {
        if (Math.floor(Math.random() * 100) !== 0)
            return;
        const limit = Clock.now.subtract({ days: 1 }) as Temporal.PlainDateTime;
        await table(ConcurrentUserEntity)
            .filter(a => a.startTime < limit)
            .executeDelete();
    }

    // ---- push (Signum's Notify* / BroadcastToServers*) --------------------------------------------

    /** Signum's UpdateConcurrentUsers: tell sibling processes, then this one's own sockets. */
    export function updateConcurrentUsers(liteKeys: Set<string>): void {
        broadcastConcurrentUsersChanged(liteKeys);
        notifyConcurrentUsersChanged(liteKeys);
    }

    function broadcastConcurrentUsersChanged(liteKeys: Set<string>): void {
        const broadcast = CacheLogic.serverBroadcast;
        if (broadcast == null)
            return;
        for (const chunk of chunks([...liteKeys], 100))
            broadcast.send(Method_ConcurrentUsersChanged, chunk.join("/"));
    }

    function broadcastEntitySaved(newTicks: Map<string, number | null>): void {
        const broadcast = CacheLogic.serverBroadcast;
        if (broadcast == null)
            return;
        for (const chunk of chunks([...newTicks], 100))
            broadcast.send(Method_EntitySaved, chunk.map(([key, ticks]) => `${key}|${ticks ?? ""}`).join("/"));
    }

    function notifyConcurrentUsersChanged(liteKeys: Set<string>): void {
        for (const liteKey of liteKeys)
            hub?.sendToGroup(liteKey, "ConcurrentUsersChanged");
    }

    function notifyEntitySaved(newTicks: Map<string, number | null>): void {
        for (const [liteKey, ticks] of newTicks)
            hub?.sendToGroup(liteKey, "EntitySaved", liteKey, ticks?.toString() ?? null);
    }

    // ---- save / delete detection (Signum's AttachSchemaEvents<T>) ---------------------------------

    function attachSchemaEvents(schema: Schema, type: Type<Entity>): void {
        const ee = schema.entityEvents(type);

        ee.saved.push(entity => {
            notifyEntitySavedOnCommit(new Map([[entity.toLite().key(), entity.ticks ?? null]]));
        });

        // A set-based delete never materialises its rows, so read the keys first (Signum does the same).
        // `ticks: null` is Signum's "gone" marker — the client's stale check fires on any change.
        ee.preUnsafeDelete.push(async query => {
            const ids = await query.map(a => a.id).toArray();
            if (ids.length === 0)
                return;
            const map = new Map<string, number | null>();
            for (const id of ids)
                map.set((type as unknown as { newLite(id: unknown, toStr?: string): Lite<Entity> }).newLite(id, "").key(), null);
            notifyEntitySavedOnCommit(map);
        });
    }

    /**
     * Signum's NotifyEntitySavedOnCommit — accumulate in the transaction's user data and push ONCE, after
     * the real commit. Pushing inside the transaction would tell every open tab to reload a version that a
     * rollback then un-does.
     */
    function notifyEntitySavedOnCommit(newTicks: Map<string, number | null>): void {
        const userData = Transaction.topParentUserData() as Record<string, unknown>;
        let accumulated = userData[savedEntitiesKey] as Map<string, number | null> | undefined;
        if (accumulated == undefined) {
            userData[savedEntitiesKey] = accumulated = new Map();
            // Registered ONCE per transaction (Signum re-subscribes a static handler, relying on delegate
            // identity to dedupe; a closure has no such identity, so the guard is this first-time branch).
            Transaction.postRealCommit(data => {
                const saved = (data as Record<string, unknown>)[savedEntitiesKey] as Map<string, number | null> | undefined;
                if (saved == undefined || saved.size === 0)
                    return;
                broadcastEntitySaved(saved);
                notifyEntitySaved(saved);
            });
        }
        for (const [key, ticks] of newTicks)
            accumulated.set(key, ticks);
    }

    function* chunks<T>(items: T[], size: number): Generator<T[]> {
        for (let i = 0; i < items.length; i += size)
            yield items.slice(i, i + size);
    }
}

/**
 * Signum's ConcurrentUserController.ConcurrentUserResponse (the shape the widget renders).
 *
 * `startTime` is an ISO STRING, not a Temporal — matching Signum's own generated client DTO, which declares
 * it as `string`. A DTO crosses the wire as an untyped `CustomType`, so the serializer has no field metadata
 * to revive a Temporal from; typing it as one would hand the widget a string that fails only later, when the
 * widget calls a Temporal method on it.
 */
export interface ConcurrentUserResponse {
    user: Lite<UserEntity>;
    startTime: string;
    connectionID: string;
    isModified: boolean;
}
