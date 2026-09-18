import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { UserHolder } from "@altea/altea/server/userHolder";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import type { Lite } from "@altea/altea/data/lite";
import { SessionLogEntity, SessionLogPermission, SessionLogMessage } from "../data/SessionLog";
import type { RoleEntity } from "../data/Role";
import type { UserEntity } from "../data/User";
import { AuthLogic } from "./AuthLogic";
import { PermissionAuthLogic } from "./PermissionAuthLogic";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";

// Port of Signum.Authorization's SessionLog/SessionLogLogic.cs — see port/Auth.md.
//
// Open a row when a tracked user logs in, close it when they log out. Both paths run with authorization
// DISABLED (
// `ExecutionMode.global`): the log is the framework's own bookkeeping, not something the logging-in user
// needs rights to write.
//
// altea divergences, documented inline:
//  - **`sessionEnd` is actually WIRED.** In Signum `SessionLogLogic.SessionEnd` is DEAD CODE — nothing in
//    the framework or in Southwind calls it — so every row it writes keeps `sessionEnd` null,
//    `sessionTimeOut` false and its `Duration` expression null forever. Three of the entity's six fields
//    (and its one expression, and two of its default query columns) are therefore inert there. altea has
//    the hook Signum lacks a call from, `AuthServer.userLoggingOut`, so the port keeps the method and
//    adds the missing call.
//  - `PermissionLogic.RegisterPermissions` has no counterpart (a declared `init()` symbol is picked up by
//    the symbol synchronizer), and `PermissionAuthLogic.isAuthorizedForRole` is ASYNC here, which makes
//    `roleTracked` / `sessionStart` / `sessionEnd` async too.
//  - `.OrderByDescending(…).Take(1).Where(…).UnsafeUpdate()` — an UPDATE whose row set is an ORDER BY +
//    TOP — has no altea form, so the row is selected first and updated by id (the accommodation
//    UserTicketLogic's per-user sweep makes for the same reason).
//  - both dates are truncated where they are assigned (the `truncSeconds` below: there is no
//    altea counterpart — see data/SessionLog.ts).

export namespace SessionLogLogic {
    let started = false;
    export function isStarted(): boolean { return started; }

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        PermissionLogic.registerPermissions(SessionLogPermission.TrackSession);

        // The default columns are a CLIENT setting, so the
        // server registration takes none (no QueryDescription), so those are CLIENT default columns — see
        // client/admin/AuthAdminClient.
        sb.include(SessionLogEntity).withQuery();

        // The session's length, so the search page can order by it. Signum gets this from the
        // `[AutoExpressionField]` member itself; altea registers the token explicitly.
        QueryLogic.expressions.register(SessionLogEntity, e => e.durationSeconds(),
            SessionLogMessage.Duration);

        // Signum's `ExceptionLogic.DeleteLogs += ExceptionLogic_DeleteLogs`. One pass only: a session log
        // has no exception column, so there is no second cut-off to apply.
        ExceptionLogic.registerDeleteLogs(async (parameters, ctx) => {
            const dateLimit = parameters.getDateLimitDelete(SessionLogEntity.toTypeEntity());
            if (dateLimit != null)
                await ExceptionLogic.deleteChunksLog(SessionLogEntity, table(SessionLogEntity)
                    .filter(s => Temporal.PlainDateTime.compare(s.sessionStart, dateLimit) < 0), parameters, ctx);
        });
    }

    /**
     * Is this role granted `TrackSession`? A role that is not is not logged at all,
     * which is the module's whole privacy story: installing it tracks nobody until someone says so.
     */
    async function roleTracked(role: Lite<RoleEntity> | null): Promise<boolean> {
        if (role == null)
            return false;
        return await PermissionAuthLogic.isAuthorizedForRole(SessionLogPermission.TrackSession, role.key());
    }

    /** Open a row for the user now logging in. */
    export async function sessionStart(userHostAddress: string | null, userAgent: string | null): Promise<void> {
        const user = UserHolder.currentUserLite() as Lite<UserEntity> | null;
        if (user == null || !await roleTracked(AuthLogic.currentRoleLite()))
            return;

        await ExecutionMode.global(async () => {
            await SessionLogEntity.create({
                user,
                sessionStart: truncSeconds(Clock.now),
                userHostAddress,
                userAgent,
            }).save();
        });
    }

    /**
     * Close this user's most recent OPEN row.
     *
     * `timeOut` non-null means the session did not end when we noticed but that long ago, so the recorded
     * end is backdated and the row is flagged as a timeout. A logout passes null.
     */
    export async function sessionEnd(user: UserEntity, timeOut: Temporal.DurationLike | null): Promise<void> {
        if (!await roleTracked(user.role))
            return;

        await ExecutionMode.global(async () => {
            const end = truncSeconds(timeOut == null ? Clock.now : Clock.now.subtract(timeOut));

            // Signum narrows with `.OrderByDescending(SessionStart).Take(1).Where(SessionEnd == null)`,
            // i.e. "the latest row, and only if it is still open" — deliberately NOT "the latest open
            // row", so a user whose last session already closed gets nothing reopened. Kept exactly,
            // which is why the ordering and the null check stay separate steps here too.
            //
            // The `thenByDescending(id)` is an altea addition, and it is not cosmetic: `sessionStart` is
            // truncated to SECONDS, so two logins in the same second are indistinguishable by it and
            // and a single-key ordering then picks between them arbitrarily. Observed: the second
            // session was left permanently open because the tie resolved to the first, already-closed
            // row. Within one second the higher id IS the later row, so this makes "the latest row" mean
            // what it says.
            const latest = await table(SessionLogEntity)
                .filter(sl => sl.user.is(user))
                .orderByDescending(sl => sl.sessionStart)
                .thenByDescending(sl => sl.id)
                .map(sl => ({ id: sl.id, sessionEnd: sl.sessionEnd }))
                .firstOrNull();

            if (latest == null || latest.sessionEnd != null)
                return;

            const id = latest.id;
            await table(SessionLogEntity)
                .filter(sl => sl.id == id)
                .executeUpdate(sl => ({ sessionEnd: end, sessionTimeOut: timeOut != null }));
        });
    }

    /** What satisfies the `@dateTimePrecisionValidator(Seconds)` both dates now carry. */
    function truncSeconds(d: Temporal.PlainDateTime): Temporal.PlainDateTime {
        return d.with({ millisecond: 0, microsecond: 0, nanosecond: 0 });
    }
}
