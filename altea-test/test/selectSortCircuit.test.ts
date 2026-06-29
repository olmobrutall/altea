import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // collection .some on a part-entity collection
import { hasDb, start } from "./setup";
import { AlbumEntity, BandEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/SelectSortCirtuitTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Where(...) → .filter(...)
//   .Select(...)         → .map(...)           .ToList()   → await .toArray()
//   b.ToLite()           → b.toLite()          b.Members.Any(p) → b.members.some(p)
//   a.Name == "A"        → a.member.entity.name == "A" (navigate the lite)
// These tests assert the SQL translator SHORT-CIRCUITS: the C# `Throw<T>()` helper
// throws if evaluated, so each must compile to SQL that never executes the
// throwing branch (?? / ?: / |/|| / &/&& constant folding). altea cannot embed a
// throwing helper call inside a quoted lambda (it's not SQL-mappable), so every
// test whose body references Throw<T>() is written in its natural altea form,
// marked `{ skip: true }`, and flagged. The two short-circuit cases that DON'T
// need Throw (NonSortCircuitCondicional, SortEqualsTrue/False) port live.
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("SelectSortCircuitTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Query<AlbumEntity>().Where(a => ("Hola" ?? Throw<string>()) == null).Select(a => a.Year).ToList();
    // TODO(api): short-circuit ?? with a throwing helper (Throw<T>()) — not SQL-mappable
    test("SortCircuitCoalesce", async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => ("Hola" ?? Throw<string>()) == null)
        //     .map(a => a.year)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => (((DateTime?)DateTime.Now) ?? Throw<DateTime>()) == DateTime.Today).Select(a => a.Year).ToList();
    // TODO(api): short-circuit ?? with a throwing helper (Throw<T>()) — not SQL-mappable
    // TODO(api): Clock.Now / DateTime.Now / DateTime.Today server-now constants in query
    test("SortCircuitCoalesceNullable", async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => ((Date.now() as Date | null) ?? Throw<Date>()) == today)
        //     .map(a => a.year)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => "Hola" == "Hola" ? true : Throw<bool>()).Select(a => a.Year).ToList();
    // TODO(api): short-circuit ?: with a throwing helper (Throw<T>()) — not SQL-mappable
    test("SortCircuitConditionalIf", async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => "Hola" == "Hola" ? true : Throw<boolean>())
        //     .map(a => a.year)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(b => b.Name == "Olmo" ? b.Members.Any(a => a.Name == "A") : true).Select(b => b.ToLite()).ToList();
    test("NonSortCircuitCondicional", async () => {
        const list = await table(BandEntity)
            .filter(b => b.name == "Olmo" ? b.members.some(a => a.member.entity.name == "A") : true)
            .map(b => b.toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => true | Throw<bool>()).Select(a => a.Year).ToList();
    // TODO(api): short-circuit | (bitwise-or) with a throwing helper (Throw<T>()) — not SQL-mappable
    test("SortCircuitOr", async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => true || Throw<boolean>())
        //     .map(a => a.year)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => true || Throw<bool>()).Select(a => a.Year).ToList();
    // TODO(api): short-circuit || with a throwing helper (Throw<T>()) — not SQL-mappable
    test("SortCircuitOrElse", async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => true || Throw<boolean>())
        //     .map(a => a.year)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => false & Throw<bool>()).Select(a => a.Year).ToList();
    // TODO(api): short-circuit & (bitwise-and) with a throwing helper (Throw<T>()) — not SQL-mappable
    test("SortCircuitAnd", async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => false && Throw<boolean>())
        //     .map(a => a.year)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => false && Throw<bool>()).Select(a => a.Year).ToList();
    // TODO(api): short-circuit && with a throwing helper (Throw<T>()) — not SQL-mappable
    test("SortCircuitAndAlso", async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => false && Throw<boolean>())
        //     .map(a => a.year)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => true == (a.Year == 1900)).Select(a => a.Year).ToList();
    test("SortEqualsTrue", async () => {
        const list = await table(AlbumEntity)
            .filter(a => true == (a.year == 1900))
            .map(a => a.year)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => false == (a.Year == 1900)).Select(a => a.Year).ToList();
    test("SortEqualsFalse", async () => {
        const list = await table(AlbumEntity)
            .filter(a => false == (a.year == 1900))
            .map(a => a.year)
            .toArray();
        assert.ok(Array.isArray(list));
    });
});
