import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import { ExpandLite, ExpandEntity } from "@altea/altea/logic/query";
import { CountryEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/ExpandTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Select(...) → .map(...)
//   .ToList()/.ToArray() → await .toArray()    a.ToLite()   → a.toLite()
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Every method here uses expandLite(...) / expandEntity(...) — query hints that
// control whether a Lite's model (ToString) or full entity is eager-loaded,
// lazy-loaded, or left null. altea implements both (the ExpandLite / ExpandEntity
// enums live in logic/query), so each test issues the real hinted query.

describe("ExpandTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<CountryEntity>().Select(a => a.ToLite()).ExpandLite(a => a, ExpandLite.ModelNull).ToList();
    test("ExpandToStringNull", async () => {
        const list = await table(CountryEntity)
            .map(a => a.toLite())
            .expandLite(a => a, ExpandLite.ModelNull)
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(l => l.entityType === CountryEntity));
    });

    // Database.Query<CountryEntity>().Select(a => a.ToLite()).ExpandLite(a => a, ExpandLite.ModelLazy).ToList();
    test("ExpandToStringLazy", async () => {
        const list = await table(CountryEntity)
            .map(a => a.toLite())
            .expandLite(a => a, ExpandLite.ModelLazy)
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(l => l.entityType === CountryEntity));
    });

    // Database.Query<CountryEntity>().Select(a => a.ToLite()).ExpandLite(a => a, ExpandLite.ModelEager).ToList();
    test("ExpandToStringEager", async () => {
        const list = await table(CountryEntity)
            .map(a => a.toLite())
            .expandLite(a => a, ExpandLite.ModelEager)
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(l => l.entityType === CountryEntity && l.toString() != null));
    });

    // var list = Database.Query<CountryEntity>().Select(a => a.ToLite()).ExpandLite(a => a, ExpandLite.EntityEager).ToList();
    test("ExpandEntityEager", async () => {
        const list = await table(CountryEntity)
            .map(a => a.toLite())
            .expandLite(a => a, ExpandLite.EntityEager)
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(l => l.entityType === CountryEntity));
    });

    // var list = Database.Query<CountryEntity>().ExpandEntity(a => a, ExpandEntity.LazyEntity).ToList();
    test("ExpandLazyEntity", async () => {
        const list = await table(CountryEntity)
            .expandEntity(a => a, ExpandEntity.LazyEntity)
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(a => a instanceof CountryEntity));
    });
});
