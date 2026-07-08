import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { Temporal } from "@altea/altea/entities/basics";
import { hasDb, start } from "./setup";
import { NoteWithDateEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/NewDateTimeTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .OrderBy(...) → .orderBy(...)
//   .Select(...)         → .map(...)           .ToList()     → await .toArray()
//   new DateTime(...)    → Temporal.PlainDateTime.from(...)  new DateOnly(...) → Temporal.PlainDate.from(...)
//   new TimeOnly(...)    → Temporal.PlainTime.from(...)      new TimeSpan(...) → Temporal.Duration.from(...)
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Every method here constructs a date/time literal inside an orderBy lambda and
// the query runs live. CAVEAT: ordering by a *constant* key is a no-op, so the
// translator folds the ORDER BY away — the emitted SQL is just `SELECT id FROM …`
// and the constructed literal never reaches SQL. So these confirm the construction
// is accepted, but its SQL RENDERING stays untested (kept as a TODO per test — a
// date/time literal in a non-constant position, e.g. compared to a column, is the
// gap). The `.length > 0` assertion holds because the query degenerates to a plain
// select over the (non-empty) table.

describe("NewDateTimeTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1)).Select(n => n.Id).ToList();
    // TODO(api): render a date/time literal to SQL — here the constant orderBy is folded away, so the PlainDateTime literal is not emitted (untested in a non-constant position).
    test("NewDateTime", async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: 2020, month: 1, day: 1 }))
            .map(n => n.id)
            .toArray();
        assert.ok(list.length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1, 12, 30, 0)).Select(n => n.Id).ToList();
    // TODO(api): render a date/time literal to SQL — here the constant orderBy is folded away, so the PlainDateTime literal is not emitted (untested in a non-constant position).
    test("NewDateTimeHMS", async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: 2020, month: 1, day: 1, hour: 12, minute: 30, second: 0 }))
            .map(n => n.id)
            .toArray();
        assert.ok(list.length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1, 12, 30, 0, 500)).Select(n => n.Id).ToList();
    // TODO(api): render a date/time literal to SQL — here the constant orderBy is folded away, so the PlainDateTime literal is not emitted (untested in a non-constant position).
    test("NewDateTimeHMSMS", async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: 2020, month: 1, day: 1, hour: 12, minute: 30, second: 0, millisecond: 500 }))
            .map(n => n.id)
            .toArray();
        assert.ok(list.length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateOnly(2020, 1, 1)).Select(n => n.Id).ToList();
    // TODO(api): render a date literal to SQL — the constant orderBy is folded away, so the PlainDate literal is not emitted (untested in a non-constant position).
    test("NewDateOnly", async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDate.from({ year: 2020, month: 1, day: 1 }))
            .map(n => n.id)
            .toArray();
        assert.ok(list.length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new TimeOnly(12, 30, 0)).Select(n => n.Id).ToList();
    // TODO(api): render a time literal to SQL — the constant orderBy is folded away, so the PlainTime literal is not emitted (untested in a non-constant position).
    test("NewTimeOnly", async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainTime.from({ hour: 12, minute: 30, second: 0 }))
            .map(n => n.id)
            .toArray();
        assert.ok(list.length > 0);
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new TimeSpan(12, 30, 0)).Select(n => n.Id).ToList();
    // TODO(api): render a duration literal to SQL — the constant orderBy is folded away, so the Duration literal is not emitted (untested in a non-constant position).
    test("NewTimeSpan", async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.Duration.from({ hours: 12, minutes: 30, seconds: 0 }))
            .map(n => n.id)
            .toArray();
        assert.ok(list.length > 0);
    });
});
