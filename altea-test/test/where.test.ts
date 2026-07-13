import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / startsWith / … (SQL-mappable)
import { hasDb, start } from "./setup";
import { ArtistEntity, AlbumEntity, Sex } from "../entities/music";

// Port of Signum.Test/LinqProvider/WhereTest.cs (Tier-1 subset — the patterns
// the current Query<T> API already expresses cleanly). C# → altea idiom:
//   Database.Query<T>()  → table(T)
//   .Where(...)          → .filter(...)        .Select(...) → .map(...)
//   .ToList()/.ToArray() → await .toArray()    .Any()       → await .some()
//   .Count(pred)         → await .count(pred)  .SingleEx()  → await .single()
//   .SingleOrDefaultEx() → await .singleOrNull()  new { X = .. } → { x: .. }
//   a.ToLite()           → a.toLite()          Sex.Male     → Sex.Male
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("WhereTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().Where(a => a.Year < 1995).ToList();
    test("Where", async () => {
        const list = await table(AlbumEntity).filter(a => a.year < 1995).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().Where(a => a.Dead).ToList();
    test("WhereBool", async () => {
        const list = await table(ArtistEntity).filter(a => a.dead).toArray();
        assert.ok(list.length > 0); // michael
    });

    // Database.Query<ArtistEntity>().Where(a => a.LastAward != null).ToList();
    test("WhereNotNull", async () => {
        await table(ArtistEntity).filter(a => a.lastAward != null).toArray();
    });

    // .Where(a => a.Year < 1995).Select(a => new { a.Year, Author = a.Author.ToLite(), a.Name })
    test("WhereSelect", async () => {
        const list = await table(AlbumEntity)
            .filter(a => a.year < 1995)
            .map(a => ({ year: a.year, author: a.author.toLite(), name: a.name }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // a.Dead ? a.Name.Contains("Michael") : a.Name.Contains("Billy")
    test("WhereCase", async () => {
        await table(ArtistEntity)
            .filter(a => a.dead ? a.name.contains("Michael") : a.name.contains("Billy"))
            .toArray();
    });

    // Count(a => a.Sex == Sex.Female) == Count(a => a.Sex.ToString() == "Female")
    test("WhereEnum", async () => {
        const females = await table(ArtistEntity).count(a => a.sex == Sex.Female);
        assert.ok(females >= 1); // wretzky
    });

    // artists.SingleEx(a => a.Dead) — exactly one (michael); SingleOrDefault of impossible → null
    test("SingleFirst", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        assert.ok(michael != null);
        const none = await table(ArtistEntity).singleOrNull(a => a.dead && !a.dead);
        assert.equal(none, null);
        const someMale = await table(ArtistEntity).firstOrNull(a => a.sex == Sex.Male);
        assert.ok(someMale != null);
    });

    // contains/startsWith/endsWith translate to CHARINDEX/strpos (Signum's TryCharIndex), so the
    // search value may be any expression — including a NON-CONSTANT column, not just a literal.
    // Using the column as its own search value is always true (position 1), so the filtered count
    // equals the total — proving a column search value translates and is semantically correct.
    test("WhereNonConstantSearch", async () => {
        const total = await table(ArtistEntity).count();
        assert.ok(total > 0);
        assert.equal(await table(ArtistEntity).count(a => a.name.contains(a.name)), total);
        assert.equal(await table(ArtistEntity).count(a => a.name.startsWith(a.name)), total);
        assert.equal(await table(ArtistEntity).count(a => a.name.endsWith(a.name)), total);
    });
});
