import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // collection .some on a part-entity collection
import { hasDb, start } from "./setup";
import { AlbumEntity, BandEntity } from "../entities/music";
import { Temporal } from "@altea/altea/entities/basics";

// A short-circuit helper (Signum's Throw<T>()) — the right side of a ?? / || / && the
// optimiser proves unreachable. Not SQL-mappable; the in-memory body just throws.
function Throw<T>(): T {
    throw new Error("Throw<T>() is a query-only short-circuit helper with no in-memory body");
}


// A `string | null` constant for the `?? Throw()` short-circuit: casting the literal
// `"Hola"` doesn't help (TS proves the literal non-null via control flow and still
// flags the `??` right operand unreachable), so capture it as a nullable-typed const.
const holaOrNull: string | null = "Hola";

// Port of Signum.Test/LinqProvider/SelectSortCirtuitTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Where(...) → .filter(...)
//   .Select(...)         → .map(...)           .ToList()   → await .toArray()
//   b.ToLite()           → b.toLite()          b.Members.Any(p) → b.members.some(p)
//   a.Name == "A"        → a.member.name == "A" (navigate the lite)
// These tests assert the SQL translator SHORT-CIRCUITS: the `Throw<T>()` helper
// throws if evaluated, so each must compile to SQL that never executes the
// throwing branch (?? / ?: / |/|| / &/&& constant folding). altea proves the
// throwing branch unreachable at translation time — the query runs (the helper is
// never invoked), which is exactly what these bodies verify. The assertions check
// the folded predicate's truth value (empty vs. whole-table result).
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("SelectSortCircuitTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Query<AlbumEntity>().Where(a => ("Hola" ?? Throw<string>()) == null).Select(a => a.Year).ToList();
    test("SortCircuitCoalesce", async () => {
        // ("Hola" ?? throw) == null folds to false → no rows (throw never evaluated).
        const list = await table(AlbumEntity)
            .filter(a => (holaOrNull ?? Throw<string>()) == null)
            .map(a => a.year)
            .toArray();
        assert.equal(list.length, 0);
    });

    // Where(a => (((DateTime?)DateTime.Now) ?? Throw<DateTime>()) == DateTime.Today).Select(a => a.Year).ToList();
    // `Temporal.Now.plainDateISO()` partial-evaluates to a client date constant — like Signum's
    // Clock.Now / DateTime.Now (the SqlFunctions doc claims GETDATE(), but the provider folds it
    // client-side; there is no GETDATE translation). So `?? Throw()` short-circuits over the
    // non-null constant and the Throw is never built. The two independent now-reads are separate
    // constants, so the count isn't asserted (as in the C#, which just .ToList()s).
    test("SortCircuitCoalesceNullable", async () => {
        const list = await table(AlbumEntity)
            .filter(a => (Temporal.Now.plainDateISO() ?? Throw<Temporal.PlainDate>()) == Temporal.Now.plainDateISO())
            .map(a => a.year)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => "Hola" == "Hola" ? true : Throw<bool>()).Select(a => a.Year).ToList();
    test("SortCircuitConditionalIf", async () => {
        // "Hola" == "Hola" ? true : throw folds to true → all rows (throw never evaluated).
        const total = await table(AlbumEntity).count();
        const list = await table(AlbumEntity)
            .filter(a => "Hola" == "Hola" ? true : Throw<boolean>())
            .map(a => a.year)
            .toArray();
        assert.equal(list.length, total);
    });

    // Where(b => b.Name == "Olmo" ? b.Members.Any(a => a.Name == "A") : true).Select(b => b.ToLite()).ToList();
    test("NonSortCircuitCondicional", async () => {
        const list = await table(BandEntity)
            .filter(b => b.name == "Olmo" ? b.members.some(a => a.member.name == "A") : true)
            .map(b => b.toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => true | Throw<bool>()).Select(a => a.Year).ToList();
    test("SortCircuitOr", async () => {
        // true || throw folds to true → all rows (throw never evaluated).
        const total = await table(AlbumEntity).count();
        const list = await table(AlbumEntity)
            .filter(a => true || Throw<boolean>())
            .map(a => a.year)
            .toArray();
        assert.equal(list.length, total);
    });

    // Where(a => true || Throw<bool>()).Select(a => a.Year).ToList();
    test("SortCircuitOrElse", async () => {
        const total = await table(AlbumEntity).count();
        const list = await table(AlbumEntity)
            .filter(a => true || Throw<boolean>())
            .map(a => a.year)
            .toArray();
        assert.equal(list.length, total);
    });

    // Where(a => false & Throw<bool>()).Select(a => a.Year).ToList();
    test("SortCircuitAnd", async () => {
        // false && throw folds to false → no rows (throw never evaluated).
        const list = await table(AlbumEntity)
            .filter(a => false && Throw<boolean>())
            .map(a => a.year)
            .toArray();
        assert.equal(list.length, 0);
    });

    // Where(a => false && Throw<bool>()).Select(a => a.Year).ToList();
    test("SortCircuitAndAlso", async () => {
        const list = await table(AlbumEntity)
            .filter(a => false && Throw<boolean>())
            .map(a => a.year)
            .toArray();
        assert.equal(list.length, 0);
    });

    // Where(a => true == (a.Year == 1900)).Select(a => a.Year).ToList();
    test("SortEqualsTrue", async () => {
        const list = await table(AlbumEntity)
            .filter(a => true == (a.year == 1900))
            .map(a => a.year)
            .toArray();
        assert.ok(list.every(y => y == 1900));
    });

    // Where(a => false == (a.Year == 1900)).Select(a => a.Year).ToList();
    test("SortEqualsFalse", async () => {
        const list = await table(AlbumEntity)
            .filter(a => false == (a.year == 1900))
            .map(a => a.year)
            .toArray();
        assert.ok(list.every(y => y != 1900));
    });
});
