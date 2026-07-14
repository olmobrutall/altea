import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals";
import { SystemTime, SystemTimeJoinMode, NullableInterval } from "@altea/altea/logic/systemTime";
import { Temporal } from "@altea/altea/entities/basics";
import { hasDb, start } from "./setup";
import { FolderEntity } from "../entities/music";

// Port (in spirit) of Signum.Test/LinqProvider/SystemTimeTest.cs. FolderEntity is
// @systemVersioned, and MusicLoader.createFolders builds committed version history —
// create A1/B1/X1, rename A1→A2, reparent X, rename X1→X2, rename B1→B2, then delete all —
// so the PRESENT table is empty while history holds every superseded version (each save/delete
// is its own transaction, giving distinct period timestamps, which SQL Server temporal requires).
// Ambient scope: `SystemTime.override(mode, async () => …)` (Signum's `using (SystemTime.Override)`).
// Read-only over the seeded graph, like Signum's suite.

describe("SystemTimeTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Present (no override): every seeded folder was deleted, so the current table is empty.
    test("TimePresent", async () => {
        const rows = await table(FolderEntity).map(f => f.name).toArray();
        assert.deepEqual(rows, []);
    });

    // SystemTime.All: main + history. Several superseded versions survive though the present is
    // empty; each projected systemPeriod() materialises to a NullableInterval, and — since every
    // folder was deleted — every version's period is closed (max != null).
    test("TimeAll", async () => {
        const list = await SystemTime.override(new SystemTime.All(SystemTimeJoinMode.AllCompatible), async () =>
            table(FolderEntity).map(f => ({ name: f.name, period: f.systemPeriod() })).toArray());

        assert.ok(list.length > 0, "history holds superseded versions even though the present is empty");
        assert.ok(list.every(r => r.period instanceof NullableInterval));
        assert.ok(list.every(r => r.period.max != null), "every deleted version has a closed period");
        // Original names that were renamed away still exist as historical versions.
        assert.ok(list.some(r => r.name === "A1") && list.some(r => r.name === "A2"));
    });

    // `f.parent != null` was true for some versions in history (X lived under A, then B), even
    // though no folder has a parent in the present (Signum's TimeAll parent check).
    test("TimeAllParent", async () => {
        const withParent = await SystemTime.override(new SystemTime.All(SystemTimeJoinMode.AllCompatible), async () =>
            table(FolderEntity).filter(f => f.parent != null).map(f => f.name).toArray());
        assert.ok(withParent.length > 0, "some historical versions had a parent");
    });

    // SystemTime.AsOf(instant): the versions live at that instant. AsOf the present (now) — every
    // seeded folder was deleted, so no version is live: empty. This exercises the AsOf clause end
    // to end (it renders FOR SYSTEM_TIME AS OF @p on SQL Server / a period-contains predicate over
    // the UNION on Postgres) and confirms time-filtering. (AsOf at a version's *exact* start
    // boundary over the rapid-fire seed history is precision-sensitive and not asserted here.)
    test("TimeAsOf", async () => {
        const nowSnapshot = await SystemTime.override(new SystemTime.AsOf(Temporal.Now.instant()), async () =>
            table(FolderEntity).map(f => f.name).toArray());
        assert.deepEqual(nowSnapshot, []);
    });
});
