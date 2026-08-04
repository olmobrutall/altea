import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import "@altea/altea/data/globals"; // String.toTsQuery* (SQL-mappable full-text builders)
import { hasDb, start } from "../setup";
import { NoteWithDateEntity } from "../../data/music";

// Port of Signum.Test/LinqProvider/FullTextSearchTest.Postgres.cs. C# → altea idiom:
//   Database.Query<T>()                     → table(T)
//   .Where(n => ...).Select(n => n.Id)      → .filter(n => ...).map(n => n.id)
//   .ToList()                               → await .toArray()
//   note.GetTsVectorColumn().Matches(q)     → note.getTsVectorColumn().matches(q)
//   "...".ToTsQuery() / _Plain/_Phrase/_WebSearch → "...".toTsQuery() / _Plain/_Phrase/_WebSearch
// Postgres-only (getTsVectorColumn lowers to the generated tsvector column + `@@`), so the suite is
// skipped on SQL Server, which has its own CONTAINS/FREETEXT test. Requires the @fullTextIndex on
// NoteWithDateEntity (Title, Text) and the GIN index — both created by gen:postgres.
const isPostgres = (process.env.ALTEA_TEST_DB ?? "").toLowerCase().startsWith("postgres");

describe("FullTextSearchTest_Postgres", { skip: !hasDb || !isPostgres }, () => {
    before(async () => { await start(); });

    test("ToTsQuery", async () => {
        const res = await table(NoteWithDateEntity)
            .filter(n => n.getTsVectorColumn().matches("american & band".toTsQuery()))
            .map(n => n.id)
            .toArray();
        assert.equal(res.length, 1);
    });

    test("ToTsQuery_Plain", async () => {
        const res = await table(NoteWithDateEntity)
            .filter(n => n.getTsVectorColumn().matches("american band".toTsQuery_Plain()))
            .map(n => n.id)
            .toArray();
        assert.equal(res.length, 1);
    });

    test("ToTsQuery_Phrase", async () => {
        const res = await table(NoteWithDateEntity)
            .filter(n => n.getTsVectorColumn().matches("american alternative".toTsQuery_Phrase()))
            .map(n => n.id)
            .toArray();
        assert.equal(res.length, 1);

        const wrongOrder = await table(NoteWithDateEntity)
            .filter(n => n.getTsVectorColumn().matches("alternative american".toTsQuery_Phrase())) // wrong order
            .map(n => n.id)
            .toArray();
        assert.equal(wrongOrder.length, 0);

        const farAway = await table(NoteWithDateEntity)
            .filter(n => n.getTsVectorColumn().matches("american band".toTsQuery_Phrase())) // not adjacent
            .map(n => n.id)
            .toArray();
        assert.equal(farAway.length, 0);
    });

    test("ToTsQuery_WebSearch", async () => {
        const res = await table(NoteWithDateEntity)
            .filter(n => n.getTsVectorColumn().matches("\"american alternative\"".toTsQuery_WebSearch()))
            .map(n => n.id)
            .toArray();
        assert.equal(res.length, 1);

        const excludeBand = await table(NoteWithDateEntity)
            .filter(n => n.getTsVectorColumn().matches("\"american alternative\" -band".toTsQuery_WebSearch()))
            .map(n => n.id)
            .toArray();
        assert.equal(excludeBand.length, 0);
    });

    // Signum's ToTsQuery_Rank: matches + orderby rank descending. No count assertion — it just
    // exercises ts_rank and rank-ordered projection end to end.
    test("ToTsQuery_Rank", async () => {
        const res = await table(NoteWithDateEntity)
            .filter(n => n.getTsVectorColumn().matches("american & alternative".toTsQuery()))
            .orderByDescending(n => n.getTsVectorColumn().rank("american & alternative".toTsQuery()))
            .map(n => ({ id: n.id, rank: n.getTsVectorColumn().rank("american & alternative".toTsQuery()) }))
            .toArray();
        assert.ok(Array.isArray(res));
    });
});
