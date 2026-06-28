import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, startAndLoad } from "./setup";
import { CountryEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/ExpandTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Select(...) → .map(...)
//   .ToList()/.ToArray() → await .toArray()    a.ToLite()   → a.toLite()
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Every method here uses ExpandLite(...) / ExpandEntity(...) — query hints that
// control whether a Lite's model (ToString) or full entity is eager-loaded,
// lazy-loaded, or left null. altea has no equivalent hint API yet, so each test
// is written in its most natural form, marked `{ skip: true }`, with the body
// commented out and flagged with a `// TODO(api): …` comment. (The
// `ExpandLite`/`ExpandEntity` enums are not modelled, so the bodies stay
// commented so those symbols never have to compile.)

describe("ExpandTest", { skip: !hasDb }, () => {
    before(async () => { await startAndLoad(); });

    // Database.Query<CountryEntity>().Select(a => a.ToLite()).ExpandLite(a => a, ExpandLite.ModelNull).ToList();
    // TODO(api): ExpandLite (Lite model eager/lazy/null load hint) on a query
    test("ExpandToStringNull", { skip: true }, async () => {
        // const list = await table(CountryEntity)
        //     .map(a => a.toLite())
        //     .expandLite(a => a, ExpandLite.ModelNull)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<CountryEntity>().Select(a => a.ToLite()).ExpandLite(a => a, ExpandLite.ModelLazy).ToList();
    // TODO(api): ExpandLite (Lite model eager/lazy/null load hint) on a query
    test("ExpandToStringLazy", { skip: true }, async () => {
        // const list = await table(CountryEntity)
        //     .map(a => a.toLite())
        //     .expandLite(a => a, ExpandLite.ModelLazy)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<CountryEntity>().Select(a => a.ToLite()).ExpandLite(a => a, ExpandLite.ModelEager).ToList();
    // TODO(api): ExpandLite (Lite model eager/lazy/null load hint) on a query
    test("ExpandToStringEager", { skip: true }, async () => {
        // const list = await table(CountryEntity)
        //     .map(a => a.toLite())
        //     .expandLite(a => a, ExpandLite.ModelEager)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // var list = Database.Query<CountryEntity>().Select(a => a.ToLite()).ExpandLite(a => a, ExpandLite.EntityEager).ToList();
    // TODO(api): ExpandLite (Lite entity eager-load hint) on a query
    test("ExpandEntityEager", { skip: true }, async () => {
        // const list = await table(CountryEntity)
        //     .map(a => a.toLite())
        //     .expandLite(a => a, ExpandLite.EntityEager)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // var list = Database.Query<CountryEntity>().ExpandEntity(a => a, ExpandEntity.LazyEntity).ToList();
    // TODO(api): ExpandEntity (entity lazy-load hint) on a query
    test("ExpandLazyEntity", { skip: true }, async () => {
        // const list = await table(CountryEntity)
        //     .expandEntity(a => a, ExpandEntity.LazyEntity)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });
});
