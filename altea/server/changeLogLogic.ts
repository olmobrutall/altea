import "./fluentOperations"; // FluentInclude.withDelete
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "./schema";
import { table } from "./table";
import { ExecutionMode } from "./executionMode";
import { UserHolder } from "./userHolder";
import { Clock } from "../data/utils/clock";
import { Temporal } from "../data/basics";
import { ChangeLogViewLogEntity, ChangeLogViewLogOperation } from "../data/changeLog";

// Port of Signum's Basics/ChangeLogLogic.cs — the stored half of the change log: one row per user saying
// when they last read it, which is all the badge count needs (see data/changeLog for the design).
//
// `ExecutionMode.global` on both calls, as Signum does: the row belongs to the user reading it, and
// requiring them to hold read/write permission on a bookkeeping table would make "have I seen the change
// log" a privilege.
//
// altea divergences:
//  - `Database.Query<T>().SingleOrDefault(...)` becomes `table(T).filter(...).singleOrNull()`, and the
//    "create it if absent" branch uses `ChangeLogViewLogEntity.create(...)` — a mixin's field initializers
//    only run in the factory, never in `new` (see CLAUDE.md).
//  - both calls answer NOTHING for an anonymous caller rather than throwing on a null user. Signum reads
//    `UserHolder.Current.User` unguarded, which is safe there only because its controller sits behind
//    global authentication; altea's login screen is served by the same client, and the navbar renders
//    before anyone is logged in.
export namespace ChangeLogLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(ChangeLogViewLogEntity)
            .withDelete(ChangeLogViewLogOperation.Delete)
            .withQuery();
    }

    /** Signum's `GetLastDate` — when the current user last read the change log, or null if never. */
    export async function getLastDate(): Promise<Temporal.PlainDateTime | undefined> {
        const user = UserHolder.currentUserLite();
        if (user == null)
            return undefined;

        return await ExecutionMode.global(async () => {
            const row = await table(ChangeLogViewLogEntity).filter(cl => cl.user.is(user)).singleOrNull();
            return row?.lastDate;
        });
    }

    /** Signum's `UpdateLastDate` — the user has just read it; stamp now. */
    export async function updateLastDate(): Promise<void> {
        const user = UserHolder.currentUserLite();
        if (user == null)
            return;

        await ExecutionMode.global(async () => {
            const row = await table(ChangeLogViewLogEntity).filter(cl => cl.user.is(user)).singleOrNull()
                ?? ChangeLogViewLogEntity.create({ user });

            row.lastDate = Clock.now;
            await row.save();
        });
    }
}
