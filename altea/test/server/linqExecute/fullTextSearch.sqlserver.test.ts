import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { SqlFullTextSearch } from "@altea/altea/server/fullTextSearch";
import { hasDb, start } from "../setup";
import { NoteWithDateEntity } from "../../data/music";

// Port of Signum.Test/LinqProvider/FullTextSearchTest.SqlServer.cs (the single-table cases). C# →
// altea idiom:
//   Database.Query<T>().Where(n => ...).Select(n => n.Id)  → table(T).filter(n => ...).map(n => n.id)
//   SqlFullTextSearch.Contains(new[]{ note.Title }, "…")   → SqlFullTextSearch.contains(note.title, "…")
//   SqlFullTextSearch.Contains(note, "…")                  → SqlFullTextSearch.contains(note, "…")  (all cols)
//   SqlFullTextSearch.FreeText(new[]{ note.Title }, "…")   → SqlFullTextSearch.freeText(note.title, "…")
// altea takes a single column or an entity rather than a column array, so the multi-column /
// two-table cases and the CONTAINSTABLE / FREETEXTTABLE (rank) table-valued forms are not ported
// yet. SQL Server-only (CONTAINS/FREETEXT); skipped on Postgres, which has its own tsvector test.
const isPostgres = (process.env.ALTEA_TEST_DB ?? "").toLowerCase().startsWith("postgres");

describe("FullTextSearchTest_SqlServer", { skip: !hasDb || isPostgres }, () => {
    before(async () => { await start(); });

    test("Contains", async () => {
        const res = await table(NoteWithDateEntity)
            .filter(n => SqlFullTextSearch.contains(n.title, "american AND band"))
            .map(n => n.id)
            .toArray();
        assert.equal(res.length, 1);
    });

    test("Contains_AllColumns", async () => {
        const res = await table(NoteWithDateEntity)
            .filter(n => SqlFullTextSearch.contains(n, "american AND band"))
            .map(n => n.id)
            .toArray();
        assert.equal(res.length, 1);
    });

    test("FreeText", async () => {
        const res = await table(NoteWithDateEntity)
            .filter(n => SqlFullTextSearch.freeText(n.title, "American band"))
            .map(n => n.id)
            .toArray();
        assert.equal(res.length, 2);
    });
});
