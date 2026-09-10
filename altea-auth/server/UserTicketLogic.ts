import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { randomUUID } from "node:crypto";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import type { Query } from "@altea/altea/server/query";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { withQuoted } from "@altea/altea/data/decorators";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import * as Database from "@altea/altea/server/Database";
import { UserEntity, UserState } from "../data/User";
import { UserTicketEntity, parseTicket } from "../data/UserTicket";
import { AuthLogic } from "./AuthLogic";

// Port of Signum.Authorization's UserTicket/UserTicketLogic.cs — see docs/port/Auth.md.
//
// Issue, rotate and revoke the long-lived "remember me" secrets. Every path runs with authorization
// DISABLED (
// altea's `ExecutionMode.global`), because the caller is by definition not logged in yet.
//
// altea divergences, documented inline:
//  - `Guid.NewGuid().ToString()` → `node:crypto`'s randomUUID: a v4 UUID from the CSPRNG, 36 chars with
//    hyphens, which is the length the entity's validator pins. The ticket is a bearer credential, so this
//    must not be `Math.random()`.
//  - `ref string ticket` → `updateTicket` RETURNS the rotated ticket beside the user (TS has no ref/out).
//  - `new Transaction()` + `tr.Commit(x)` → `Transaction.create(async () => x)`.
//  - `UnsafeDelete()` → `executeDelete()`, except the "too many tickets" sweep, which does not translate
//    see cleanExpiredTickets.
//  - `UserGraph.OnDeactivated` has no counterpart: altea's user state machine lives in AuthLogic, and
//    Signum's own AutoDeactivate branch bypasses that event and calls `RemoveTickets` directly anyway. So
//    both operations reach `removeTickets` through one slot AuthLogic owns — filled in `start`.
//  - `[AutoExpressionField] UserTickets()` → a `withQuoted` prototype member plus the query-token
//    registration, the shape altea-view-log uses; hence the module augmentation below.
//
// One Signum behaviour is MIRRORED rather than fixed, and is worth knowing: `updateTicket` leaves the
// SPENT row in place, so a presented ticket stays valid until a sweep removes it. That makes
// `maxTicketsPerUser` a cap on remembered LOGINS rather than on devices. Deleting the spent row would be
// true single-use rotation, but it buys little — a thief who uses a stolen cookie is handed a fresh
// ticket either way, so the credential's real lifetime is `expirationInterval` regardless — and it costs
// robustness: a response lost in flight would leave the browser holding a dead cookie and silently stop
// remembering the device. Nothing here detects a replay, so there is no gain to weigh against that.

declare module "../data/User" {
    interface UserEntity {
        /** This user's remembered devices. */
        userTickets?(): Query<UserTicketEntity>;
    }
}

export namespace UserTicketLogic {
    /** How long a remembered device stays remembered. */
    export let expirationInterval: Temporal.DurationLike = { days: 60 };

    /** How many tickets one user may keep at once (see the header note). */
    export let maxTicketsPerUser = 4;

    let started = false;
    export function isStarted(): boolean { return started; }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        // The default columns are a CLIENT setting, so there is no
        // QueryDescription, so the server registration takes none and those five are CLIENT default
        // columns (see client/AuthClient's cb.configure for UserTicketEntity).
        sb.include(UserTicketEntity).withQuery();

        UserEntity.prototype.userTickets = withQuoted(function (this: UserEntity): Query<UserTicketEntity> {
            return table(UserTicketEntity).filter(ut => ut.user.is(this));
        });

        QueryLogic.expressions.register(UserEntity, u => u.userTickets!(),
            { key: "UserTickets", niceName: () => UserTicketEntity.nicePluralName() });

        // Signum wires this two different ways — `UserGraph.OnDeactivated += …` for Deactivate, and a
        // direct `UserTicketLogic.RemoveTickets(u)` inside AutoDeactivate. Both mean "a user who can no
        // longer log in must not stay remembered on their devices", so altea has ONE slot on AuthLogic
        // that both operations call, filled here.
        AuthLogic.onRemoveUserTickets = removeTickets;

        // A password change revokes every remembered device.
        sb.schema.entityEvents(UserEntity).saving.push(user => onUserSaving(user));
    }

    /**
     * When a user's PASSWORD changes, every ticket dies with it.
     *
     * Otherwise "change my password because it leaked" would leave whoever holds the old cookie logged in
     * for the next 60 days, which is the one thing a password change must not do.
     *
     * The stored hash is compared with the in-memory one, both
     * `EmptyIfNull()`-ed. altea's `passwordHash` is a binary column (a `Uint8Array`), so the comparison is
     * byte-wise, behind an `isNew` / dirty gate.
     */
    async function onUserSaving(user: UserEntity): Promise<void> {
        if (user.isNew || !user.isDirty())
            return;

        const stored = await ExecutionMode.global(async () =>
            await table(UserEntity).filter(u => u.id == user.id).map(u => u.passwordHash).singleOrNull());

        if (sameHash(stored ?? null, user.passwordHash ?? null))
            return;

        await ExecutionMode.global(async () => {
            await table(UserTicketEntity).filter(ut => ut.user.is(user)).executeDelete();
        });
    }

    /** Null and empty are the same thing here. */
    function sameHash(a: Uint8Array | null, b: Uint8Array | null): boolean {
        const x = a ?? new Uint8Array(0);
        const y = b ?? new Uint8Array(0);
        return x.length === y.length && x.every((v, i) => v === y[i]);
    }

    /** Remember THIS device for the current user; returns the cookie text. */
    export function newTicket(device: string): Promise<string> {
        return ExecutionMode.global(() => Transaction.create(async () => {
            const current = UserHolder.current();
            if (current == null)
                throw new Error("UserTicketLogic.newTicket: there is no current user");

            const user = await Database.retrieve(UserEntity, current.user.id);

            await cleanExpiredTickets(user);
            AuthLogic.checkUserActive(user);

            const result = UserTicketEntity.create({
                user: user.toLite(),
                device: truncateDevice(device),
                connectionDate: Clock.now,
                ticket: randomUUID(),
            });
            await result.save();

            return result.stringTicket();
        }));
    }

    /**
     * Signum's UpdateTicket(device, ref ticket) — spend a ticket and hand back a fresh one plus the user
     * it belongs to. Throws when the text is not a ticket, or names one that does not exist.
     */
    export function updateTicket(device: string, ticket: string): Promise<{ user: UserEntity; ticket: string }> {
        return ExecutionMode.global(() => Transaction.create(async () => {
            const pair = parseTicket(ticket);

            const user = await Database.retrieve(UserEntity, pair.userId);

            await cleanExpiredTickets(user);
            AuthLogic.checkUserActive(user);

            // Captured in a const: the quoted lambda folds a free identifier by VALUE, and a property
            // access on `pair` inside the body would have no SQL translation.
            const secret = pair.ticket;
            const userTicket = await table(UserTicketEntity)
                .filter(ut => ut.user.is(user) && ut.ticket == secret)
                .singleOrNull() as UserTicketEntity | null;

            if (userTicket == null)
                throw new Error("User attempted to log-in with an invalid ticket");

            const result = UserTicketEntity.create({
                user: user.toLite(),
                device: truncateDevice(device),
                connectionDate: Clock.now,
                ticket: randomUUID(),
            });
            await result.save();

            return { user, ticket: result.stringTicket() };
        }));
    }

    /**
     * Drop this user's stale tickets, or ALL of them when the user is no
     * longer active. Returns how many rows went.
     */
    async function cleanExpiredTickets(user: UserEntity): Promise<number> {
        const removed = await removeTickets(user);
        if (removed != null)
            return removed;

        const min = Clock.now.subtract(expirationInterval);
        const expired = await table(UserTicketEntity)
            .filter(ut => ut.user.is(user) && Temporal.PlainDateTime.compare(ut.connectionDate, min) < 0)
            .executeDelete();

        // Signum writes this as `.OrderByDescending(t => t.ConnectionDate).Skip(MaxTicketsPerUser)
        // .UnsafeDelete()` — a DELETE whose row set is an ORDER BY + OFFSET. altea's bulk-DML terminal
        // builds a command from the query expression and has no such form, so the ids are selected first
        // and deleted by id: one extra round trip, over a set bounded by maxTicketsPerUser.
        const surplus = await table(UserTicketEntity)
            .filter(ut => ut.user.is(user))
            .orderByDescending(ut => ut.connectionDate)
            .skip(maxTicketsPerUser)
            .map(ut => ut.id)
            .toArray();

        if (surplus.length > 0)
            await Database.deleteRowsByIds(UserTicketEntity, surplus);

        return expired + surplus.length;
    }

    /**
     * Every ticket of a user who is not Active, else null meaning "nothing
     * to do, this user may still log in". `cleanExpiredTickets` reads that null/number distinction to
     * decide whether the finer sweeps are still worth running.
     */
    export async function removeTickets(user: UserEntity): Promise<number | null> {
        if (user.state === UserState.Active)
            return null;

        return await ExecutionMode.global(async () =>
            await table(UserTicketEntity).filter(ut => ut.user.is(user)).executeDelete());
    }

    // A 200-char column, and a User-Agent can exceed it where the IP address Signum stores never would.
    // altea passes the User-Agent when there is nothing better (see UserTicketServer), which does NOT
    // always fit — and a validator failure here would turn "remember me" into a failed login.
    function truncateDevice(device: string): string {
        return device.length <= 200 ? device : device.substring(0, 197) + "...";
    }
}
