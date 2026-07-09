import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { Temporal } from "@altea/altea/entities/basics";
import { hasDb, start } from "./setup";
import { NoteWithDateEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/NewDateTimeTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .OrderBy(...) → .orderBy(...)
//   .Select(...)         → .map(...)           .ToList()     → await .toArray()
//   new DateTime(...)    → Temporal.PlainDateTime.from({...})  new DateOnly(...) → Temporal.PlainDate.from({...})
//   new TimeOnly(...)    → Temporal.PlainTime.from({...})      new TimeSpan(...) → Temporal.Duration.from({...})
//
// A date/time construction with ALL-constant components folds to a value (a param), and a
// constant ORDER BY over it is a no-op that's dropped — so to exercise SQL RENDERING these
// use a NON-constant component (a value pulled off the row, like `n.creationTime.year`), the
// altea analog of C#'s `new X()` never being a constant sub-expression. That forces a
// date-part constructor into SQL (Signum's DbExpressionNominator.VisitNew): MAKE_DATE /
// MAKE_TIMESTAMP / MAKE_TIME / MAKE_INTERVAL on Postgres, DATEFROMPARTS / DATETIMEFROMPARTS /
// TIMEFROMPARTS on SQL Server — so the ORDER BY survives. Each test asserts the ORDER BY renders.

describe("NewDateTimeTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1)).Select(n => n.Id).ToList();
    test("NewDateTime", async () => {
        const q = table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: n.creationTime.year, month: 1, day: 1 }))
            .map(n => n.title);
        assert.match(q.queryTextForDebug(), /ORDER BY/i);
        assert.ok((await q.toArray()).length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1, 12, 30, 0)).Select(n => n.Id).ToList();
    test("NewDateTimeHMS", async () => {
        const q = table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: n.creationTime.year, month: 1, day: 1, hour: 12, minute: 30, second: 0 }))
            .map(n => n.title);
        assert.match(q.queryTextForDebug(), /ORDER BY/i);
        assert.ok((await q.toArray()).length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1, 12, 30, 0, 500)).Select(n => n.Id).ToList();
    test("NewDateTimeHMSMS", async () => {
        const q = table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: n.creationTime.year, month: 1, day: 1, hour: 12, minute: 30, second: 0, millisecond: 500 }))
            .map(n => n.title);
        assert.match(q.queryTextForDebug(), /ORDER BY/i);
        assert.ok((await q.toArray()).length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateOnly(2020, 1, 1)).Select(n => n.Id).ToList();
    test("NewDateOnly", async () => {
        const q = table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDate.from({ year: n.creationTime.year, month: 1, day: 1 }))
            .map(n => n.title);
        assert.match(q.queryTextForDebug(), /ORDER BY/i);
        assert.ok((await q.toArray()).length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new TimeOnly(12, 30, 0)).Select(n => n.Id).ToList();
    test("NewTimeOnly", async () => {
        const q = table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainTime.from({ hour: n.creationTime.hour, minute: 30, second: 0 }))
            .map(n => n.title);
        assert.match(q.queryTextForDebug(), /ORDER BY/i);
        assert.ok((await q.toArray()).length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new TimeSpan(12, 30, 0)).Select(n => n.Id).ToList();
    test("NewTimeSpan", async () => {
        const q = table(NoteWithDateEntity)
            .orderBy(n => Temporal.Duration.from({ hours: n.creationTime.hour, minutes: 30, seconds: 0 }))
            .map(n => n.title);
        assert.match(q.queryTextForDebug(), /ORDER BY/i);
        assert.ok((await q.toArray()).length > 0);
    });
});
