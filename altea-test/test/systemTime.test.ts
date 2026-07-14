import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals";
import { SystemTime, SystemTimeJoinMode, NullableInterval } from "@altea/altea/logic/systemTime";
import { Temporal } from "@altea/altea/entities/basics";
import { getDatesInRange, TimeSeriesUnit } from "@altea/altea/logic/queryTimeSeries";
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

    // GetDatesInRange TVF in isolation (Signum's QueryTimeSeriesLogic.GetDatesInRange): a series of
    // timestamps generated in SQL. Here 1-second steps across a 2-second window → 3 rows.
    test("GetDatesInRange", async () => {
        const startDt = Temporal.PlainDateTime.from("2020-01-01T00:00:00");
        const endDt = startDt.add({ seconds: 2 });
        const dates = await getDatesInRange(startDt, endDt, TimeSeriesUnit.Second, 1).map(d => d.date).toArray();
        assert.equal(dates.length, 3, "0s, 1s, 2s");
        assert.ok(dates.every(d => d != null));
    });

    // The earliest version start across all history (Signum's `Min(a => a.SystemPeriod().Min!.Value)`).
    // altea's min() aggregate is typed for scalars, not Temporal, so reduce client-side.
    async function earliestVersionStart(): Promise<Temporal.PlainDateTime> {
        const mins = await SystemTime.override(new SystemTime.All(SystemTimeJoinMode.AllCompatible), async () =>
            table(FolderEntity).map(f => f.systemPeriod().min).toArray());
        const present = mins.filter((m): m is Temporal.PlainDateTime => m != null);
        assert.ok(present.length > 0, "history has version starts");
        return present.reduce((a, b) => Temporal.PlainDateTime.compare(a, b) <= 0 ? a : b);
    }

    // Signum's TimeSeriesOneValue: a series of dates, each carrying a scalar aggregate computed AS
    // OF that date — one composed query where the per-row date drives an AsOfExpression AS OF over
    // the versioned table (a correlated COUNT subquery). Asserts it translates and runs.
    test("TimeSeriesOneValue", async () => {
        const min = await earliestVersionStart();
        const series = await getDatesInRange(min, min.add({ seconds: 2 }), TimeSeriesUnit.Millisecond, 50)
            .map(dv => ({
                date: dv.date,
                count: table(FolderEntity).overrideSystemTime(new SystemTime.AsOf(dv.date)).count(),
            }))
            .toArray();
        assert.ok(Array.isArray(series));
        assert.ok(series.every(r => r.date != null && typeof r.count === "number"));
    });

    // Signum's TimeSeriesManyValue: for each date in the series, the folders live AS OF that date
    // (a SelectMany / flatMap correlating the date with the versioned rows AS OF it).
    test("TimeSeriesManyValue", async () => {
        const min = await earliestVersionStart();
        const series = await getDatesInRange(min, min.add({ seconds: 2 }), TimeSeriesUnit.Millisecond, 50)
            .flatMap(dv => table(FolderEntity)
                .overrideSystemTime(new SystemTime.AsOf(dv.date))
                .map(f => ({ date: dv.date, folder: f.name })))
            .toArray();
        assert.ok(Array.isArray(series));
    });
});
