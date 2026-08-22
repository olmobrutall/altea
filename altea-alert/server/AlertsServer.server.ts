import { CustomType, type WebBuilder } from "@altea/altea/server/webApi";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { WebSocketHub, type HubConnection } from "@altea/altea/server/webSocketHub";
import { table } from "@altea/altea/server/table";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { AuthTokenServer } from "@altea/altea-auth/server/AuthTokenServer";
import { CacheLogic } from "@altea/altea-cache/server/CacheLogic";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { AlertEntity, AlertState } from "../data/Alert";

// Port of Signum.Alerts' AlertsServer.cs + AlertController.cs + AlertsHub.cs — the two endpoints the navbar
// dropdown polls, and the PUSH that tells a browser its alerts changed.
//
// altea divergences:
//
//  - **SignalR → altea's WebSocket hub** (altea/server/webSocketHub.ts), the same substitution
//    altea-concurrent-user makes. `Clients.Client(connectionId).AlertsChanged()` becomes
//    `hub.sendToGroup(userKey, "AlertsChanged")`, and Signum's `ConnectionMapping<Lite<IUserEntity>>` —
//    a hand-rolled user→connections dictionary — is just a GROUP per user, which the hub already has.
//  - **the socket's OWN user is authoritative.** Signum's hub takes `Login(tokenString)` and trusts the
//    token the client passes; altea authenticates the CONNECTION on its first frame (see webSocketHub.ts),
//    so the group a tab joins is the user the server resolved — a tab cannot subscribe to someone else's
//    notifications. (Same call the concurrent-user hub makes.)
//  - **cross-process notification is unchanged in shape**: `CacheLogic.registerBroadcastReceiver` is
//    altea-cache's port of Signum's `CacheLogic.BroadcastReceivers`, and the same "*" / id-list protocol
//    (chunked, with a limit above which everybody is notified) is kept verbatim.
export namespace AlertsServer {

    export const hubPath = "/api/alertshub";

    export let hub: WebSocketHub | undefined;

    /** Signum's NotifyEverybodyLimit / NotifyChunkSize — above the limit, broadcast "*" instead of ids. */
    export let notifyEverybodyLimit = 1000;
    export let notifyChunkSize = 100;

    let started = false;

    export function start(wb: WebBuilder, sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        hub = buildHub();
        wb.webSocket(hub);

        // GET /api/alerts/myAlerts — Signum's AlertController.MyAlerts.
        wb.get("/api/alerts/myAlerts",
            { res: CustomType<AlertEntity[]>() },
            async (_req, res) => {
                res.jsonTyped(await myAlerts());
            });

        // GET /api/alerts/myAlertsCount — Signum's MyAlertsCount (one query, two aggregates).
        wb.get("/api/alerts/myAlertsCount",
            { res: CustomType<MyAlertCountResult>() },
            async (_req, res) => {
                res.jsonTyped(await myAlertsCount());
            });

        // ---- the notify-on-commit wiring (Signum's four entity events) ----------------------------------
        const events = sb.schema.entityEvents(AlertEntity);

        events.saved.push(alert => {
            if (alert.recipient != null)
                notifyOnCommit([alert.recipient]);
        });

        // A set-based write does not materialise its rows, so Signum reads the affected RECIPIENTS first —
        // same here, and on all three unsafe hooks.
        events.preUnsafeDelete.push(async query => { await notifyOnCommitQuery(query); });
        events.preUnsafeUpdate.push(async query => { await notifyOnCommitQuery(query); });
        events.preUnsafeInsert.push(async query => { await notifyOnCommitQuery(query); });

        // Signum's BroadcastReceivers entry: another PROCESS raised an alert, so this one's sockets have to
        // hear about it (the browser is connected to exactly one server).
        CacheLogic.registerBroadcastReceiver("AlertForReceiver", argument => {
            if (argument === "*")
                notifyClients(undefined);
            else
                notifyClients(argument.split("/").map(id => Lite.parse(`User;${id}`) as Lite<UserEntity>));
        });
    }

    // ---- The two endpoints ----------------------------------------------------------------------------

    export interface MyAlertCountResult {
        numAlerts: number;
        lastAlert: string | null;
    }

    /** Signum's `MyAlerts` — everything addressed to me that is due and unattended. */
    export async function myAlerts(): Promise<AlertEntity[]> {
        const me = UserHolder.currentUserLite() as Lite<UserEntity> | null;
        if (me == null)
            return [];
        return await table(AlertEntity).filter(a => a.recipient!.is(me) && a.alerted()).toArray() as AlertEntity[];
    }

    /**
     * Signum's `MyAlertsCount`. Signum runs ONE grouped query to get the count and the newest creation date
     * together; altea's dynamic-query layer has no in-LINQ GroupBy over a lite, so this is a count plus a
     * top-1 — two cheap indexed reads, and the pair is only ever used to decide whether the bell rings.
     */
    export async function myAlertsCount(): Promise<MyAlertCountResult> {
        const me = UserHolder.currentUserLite() as Lite<UserEntity> | null;
        if (me == null)
            return { numAlerts: 0, lastAlert: null };

        const numAlerts = await table(AlertEntity).filter(a => a.recipient!.is(me) && a.alerted()).count();
        if (numAlerts === 0)
            return { numAlerts: 0, lastAlert: null };

        const newest = await table(AlertEntity).filter(a => a.recipient!.is(me) && a.alerted())
            .orderByDescending(a => a.creationDate).firstOrNull() as AlertEntity | null;

        return { numAlerts, lastAlert: newest?.creationDate?.toString() ?? null };
    }

    // ---- Notification ----------------------------------------------------------------------------------

    /** The hub GROUP a user's tabs join — the same key the client passes to `useWebSocketGroup`. */
    export function groupOf(user: Lite<UserEntity>): string {
        return liteKeyOf(user);
    }

    function notifyOnCommit(recipients: Lite<UserEntity>[]): void {
        if (recipients.length === 0)
            return;

        // Signum stashes the recipients in Transaction.UserData and notifies on PostRealCommit — a
        // notification must not go out for a write that then rolls back. altea's Transaction has the same
        // post-commit seam.
        // Signum stashes them in Transaction.UserData so several writes in one transaction notify once.
        const data = Transaction.userData() as { alertRecipients?: Map<string, Lite<UserEntity>> };
        const first = data.alertRecipients == null;
        const pending = data.alertRecipients ??= new Map<string, Lite<UserEntity>>();
        for (const r of recipients)
            pending.set(liteKeyOf(r), r);

        if (first)
            Transaction.postRealCommit(() => {
                const users = [...pending.values()];
                pending.clear();
                broadcastToServers(users);
                notifyClients(users);
            });
    }

    async function notifyOnCommitQuery(query: { toArray(): Promise<unknown[]> }): Promise<void> {
        // Signum: `alerts.Where(a => a.Recipient != null && a.State == Saved).Select(a => a.Recipient).Distinct()`.
        const rows = await (query as unknown as {
            filter(f: (a: AlertEntity) => boolean): { toArray(): Promise<AlertEntity[]> };
        }).filter(a => a.recipient != null && a.state == AlertState.Saved).toArray();

        const byKey = new Map<string, Lite<UserEntity>>();
        for (const a of rows)
            if (a.recipient != null)
                byKey.set(liteKeyOf(a.recipient), a.recipient);

        notifyOnCommit([...byKey.values()]);
    }

    /** Signum's BroadcastToServers — tell the OTHER app servers, chunked, or "*" when there are too many. */
    export function broadcastToServers(users: Lite<UserEntity>[]): void {
        const broadcast = CacheLogic.serverBroadcast;
        if (broadcast == null || users.length === 0)
            return;

        if (users.length > notifyEverybodyLimit) {
            broadcast.send("AlertForReceiver", "*");
            return;
        }

        for (let i = 0; i < users.length; i += notifyChunkSize)
            broadcast.send("AlertForReceiver", users.slice(i, i + notifyChunkSize).map(u => String(u.id)).join("/"));
    }

    /** Signum's NotifySignalRClients — `undefined` means "every connected user". */
    export function notifyClients(users: Lite<UserEntity>[] | undefined): void {
        if (hub == null)
            return;
        if (users == null)
            hub.sendToAll("AlertsChanged");
        else
            for (const user of users)
                hub.sendToGroup(groupOf(user), "AlertsChanged");
    }

    // ---- The hub ---------------------------------------------------------------------------------------

    function buildHub(): WebSocketHub {
        const h = new WebSocketHub(hubPath);

        // A browser WebSocket cannot send `Authorization`, so the token rides the first frame and is
        // validated through the SAME authenticator chain an HTTP request uses (see webSocketHub.ts). This
        // replaces Signum's `Login(tokenString)` hub method, which trusts whatever the client passes.
        h.authenticate = async token => {
            if (token == null || token === "")
                throw new Error("AlertsHub: no authentication token");

            const fakeReq = {
                header: (name: string) => name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined,
                hasQuery: () => false,
            };
            const fakeRes = { setHeader: () => { /* a socket cannot carry New_Token */ } };

            for (const authenticator of AuthTokenServer.authenticators) {
                const user = await Transaction.forceNew(() => authenticator(fakeReq, fakeRes));
                if (user != null)
                    return user;
            }
            throw new Error("AlertsHub: the token did not resolve to a user");
        };

        h.onError = (e, context) => {
            void ExecutionMode.global(() => Transaction.forceNew(() => ExceptionLogic.logException(e, ex => {
                ex.controllerName = context;
            }))).catch(inner => console.error("[alerts] could not log:", inner, "original:", e));
        };

        // Signum's `Login` / `Logout` hub methods. The GROUP is derived from the socket's own user (see the
        // header), so `Login` carries no argument — it only says "start listening".
        h.methods["Login"] = conn => { joinOwnGroup(conn); };
        h.methods["Logout"] = conn => { leaveOwnGroup(conn); };

        return h;
    }

    function ownUserLite(conn: HubConnection): Lite<UserEntity> | null {
        const user = conn.user as { user?: Lite<UserEntity> } | undefined;
        return user?.user ?? null;
    }

    function joinOwnGroup(conn: HubConnection): void {
        const me = ownUserLite(conn);
        if (me != null)
            conn.hub.addToGroup(conn, groupOf(me));
    }

    function leaveOwnGroup(conn: HubConnection): void {
        const me = ownUserLite(conn);
        if (me != null)
            conn.hub.removeFromGroup(conn, groupOf(me));
    }
}

/** `Lite.key()` — Signum's free `liteKey`, the "CleanType;id" string a hub group is named by. */
function liteKeyOf(lite: Lite<UserEntity>): string {
    return lite.key();
}

export type { Entity, Clock, Temporal };
