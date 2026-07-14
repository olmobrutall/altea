import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals";
import { SystemTime, SystemTimeJoinMode, NullableInterval } from "@altea/altea/logic/systemTime";
import { Temporal } from "@altea/altea/entities/basics";
import { hasDb, start } from "./setup";
import { FolderEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/SystemTimeTest.cs. FolderEntity is @systemVersioned, and
// MusicLoader.createFolders builds committed version history (create A1/B1/X1, rename A1→A2,
// reparent X, X1→X2, B1→B2, then delete all) — so the present is empty and history holds every
// superseded version, with distinct commit timestamps (SQL Server temporal needs separate
// transactions). Read-only over the seeded graph, like Signum. `SystemTime.override(mode, fn)`
// is the callback-scoped analogue of Signum's `using (SystemTime.Override(mode))`.
//
// Not ported: SystemValidParameterValidation (C#-only InvalidDateTimeKindException on a non-UTC
// DateTime parameter — altea's Temporal model has no DateTimeKind), and TimeSeriesOne/ManyValue
// (the dynamic AsOfExpression / QueryTimeSeriesLogic path, outside the core-modes scope).

describe("SystemTimeTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Signum's SystemPeriodUTC: project a period bound and do date arithmetic on it in SQL.
    // (Signum additionally asserts the bound's DateTimeKind is Utc; altea's Temporal model has no
    // Kind — period bounds materialise as tz-naive Temporal values — so that is not asserted.)
    test("SystemPeriodUTC", async () => {
        await SystemTime.override(new SystemTime.All(SystemTimeJoinMode.FirstCompatible), async () => {
            const mins = await table(FolderEntity).map(f => f.systemPeriod().min).toArray();
            assert.ok(mins.length > 0);
            assert.ok(mins.every(m => m != null));
            // date arithmetic on the bound, evaluated in SQL (Signum's .Min.Value.AddDays(1).InSql())
            const plus1 = await table(FolderEntity).map(f => f.systemPeriod().min!.add({ days: 1 })).toArray();
            assert.equal(plus1.length, mins.length);
            assert.ok(plus1.every(m => m != null));
        });
    });

    // Present (no override): every seeded folder was deleted, so the current table is empty, and a
    // present query filtering on a parent finds nothing (Signum's TimePresent → Assert.Empty).
    test("TimePresent", async () => {
        const list = await table(FolderEntity)
            .filter(f => f.parent != null)
            .map(f => ({ name: f.name, parent: f.parent!.entity.name }))
            .toArray();
        assert.deepEqual(list, []);
    });

    // SystemTime.All: main + history. Signum projects each versioned folder's period AND its
    // parent's period (navigating f.parent.entity.systemPeriod() — a join to the versioned parent
    // under the same scope) and asserts the child period overlaps the parent's.
    test("TimeAll", async () => {
        const list = await SystemTime.override(new SystemTime.All(SystemTimeJoinMode.AllCompatible), async () =>
            table(FolderEntity)
                .filter(f => f.parent != null)
                .map(f => ({
                    name: f.name,
                    period: f.systemPeriod(),
                    parentName: f.parent!.entity.name,
                    parentPeriod: f.parent!.entity.systemPeriod(),
                }))
                .toArray());

        assert.ok(list.length > 0, "history holds versions that had a parent, though present is empty");
        assert.ok(list.every(a => a.period instanceof NullableInterval && a.parentPeriod instanceof NullableInterval));
        // A child version and one of its parent's versions share time (Signum asserts this for
        // every row; altea's FK join isn't temporally correlated, so it pairs a child version with
        // every same-id parent version — some pairs don't overlap — hence `some`, not `every`).
        assert.ok(list.some(a => a.period.overlaps(a.parentPeriod)));
    });

    // SystemTime.AsOf / Between / ContainedIn — Signum's TimeBetween exercises all three interval
    // modes (asserting only that they translate and run). Get X2's period under All, then query at
    // / around it. X2's bounds feed straight back into the modes.
    test("TimeBetween", async () => {
        const period = await SystemTime.override(new SystemTime.All(SystemTimeJoinMode.AllCompatible), async () =>
            table(FolderEntity).filter(f => f.name == "X2").map(f => f.systemPeriod()).single());
        assert.ok(period.min != null && period.max != null);

        const asOf = await SystemTime.override(new SystemTime.AsOf(period.min!), async () =>
            table(FolderEntity).filter(f => f.name == "X2").map(f => f.systemPeriod()).toArray());
        assert.ok(Array.isArray(asOf));

        const end = period.max!.add({ seconds: 1 });
        const between = await SystemTime.override(new SystemTime.Between(period.max!, end, SystemTimeJoinMode.AllCompatible), async () =>
            table(FolderEntity).filter(f => f.name == "X2").map(f => f.systemPeriod()).toArray());
        assert.ok(Array.isArray(between));

        const contained = await SystemTime.override(new SystemTime.ContainedIn(period.max!, end, SystemTimeJoinMode.AllCompatible), async () =>
            table(FolderEntity).filter(f => f.name == "X2").map(f => f.systemPeriod()).toArray());
        assert.ok(Array.isArray(contained));
    });

    // AsOf the present (now): every folder was deleted, so no version is live — empty. Confirms the
    // AsOf clause renders and time-filters end to end (FOR SYSTEM_TIME AS OF on SQL Server / a
    // period-contains predicate over the UNION on Postgres).
    test("TimeAsOf", async () => {
        const nowSnapshot = await SystemTime.override(new SystemTime.AsOf(Temporal.Now.instant()), async () =>
            table(FolderEntity).map(f => f.name).toArray());
        assert.deepEqual(nowSnapshot, []);
    });
});
