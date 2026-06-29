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
// Every method here constructs a date/time literal inside an orderBy lambda. The
// altea query layer has no date/time-construction API yet (no way to translate a
// `new DateTime(...)` literal to SQL), so each test is written in its most
// natural Temporal-based form, marked `{ skip: true }`, and flagged with a
// `// TODO(api): …` comment.

describe("NewDateTimeTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1)).Select(n => n.Id).ToList();
    // TODO(api): new DateTime(...) literal (PlainDateTime construction) in a query orderBy
    test("NewDateTime", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: 2020, month: 1, day: 1 }))
            .map(n => n.id)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1, 12, 30, 0)).Select(n => n.Id).ToList();
    // TODO(api): new DateTime(...) literal (PlainDateTime construction) in a query orderBy
    test("NewDateTimeHMS", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: 2020, month: 1, day: 1, hour: 12, minute: 30, second: 0 }))
            .map(n => n.id)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateTime(2020, 1, 1, 12, 30, 0, 500)).Select(n => n.Id).ToList();
    // TODO(api): new DateTime(...) literal (PlainDateTime construction) in a query orderBy
    test("NewDateTimeHMSMS", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDateTime.from({ year: 2020, month: 1, day: 1, hour: 12, minute: 30, second: 0, millisecond: 500 }))
            .map(n => n.id)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new DateOnly(2020, 1, 1)).Select(n => n.Id).ToList();
    // TODO(api): new DateOnly(...) literal (PlainDate construction) in a query orderBy
    test("NewDateOnly", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainDate.from({ year: 2020, month: 1, day: 1 }))
            .map(n => n.id)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new TimeOnly(12, 30, 0)).Select(n => n.Id).ToList();
    // TODO(api): new TimeOnly(...) literal (PlainTime construction) in a query orderBy
    test("NewTimeOnly", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.PlainTime.from({ hour: 12, minute: 30, second: 0 }))
            .map(n => n.id)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().OrderBy(n => new TimeSpan(12, 30, 0)).Select(n => n.Id).ToList();
    // TODO(api): new TimeSpan(...) literal (Duration construction) in a query orderBy
    test("NewTimeSpan", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .orderBy(n => Temporal.Duration.from({ hours: 12, minutes: 30, seconds: 0 }))
            .map(n => n.id)
            .toArray();
        assert.ok(Array.isArray(list));
    });
});
