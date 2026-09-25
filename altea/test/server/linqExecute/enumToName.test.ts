import { test, beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { Enum } from "@altea/altea/data/enum";
import { hasDb, start } from "../setup";
import { ArtistEntity, Sex } from "../../data/music";

// Enum.toName(E, value) in a query: Signum's enum ToString(), a join with the enum's table and its name
// column — so a `@quoted toString` can name an enum member the same way in memory and in SQL.

describe.skipIf(!hasDb)("Enum.toName", () => {
    beforeAll(async () => { await start(); });

    test("projects the member name", async () => {
        const rows = await table(ArtistEntity).map(a => ({ sex: a.sex, name: Enum.toName(Sex, a.sex) })).toArray();
        assert.ok(rows.length > 0);
        for (const r of rows)
            assert.equal(r.name, Enum.toName(Sex, r.sex));
    });

    test("joins the enum table, no CASE", () => {
        const sql = table(ArtistEntity).map(a => Enum.toName(Sex, a.sex)).queryTextForDebug();
        assert.match(sql, /JOIN/i);
        assert.doesNotMatch(sql, /CASE/i);
    });

    test("filters on the member name", async () => {
        const byName = await table(ArtistEntity).filter(a => Enum.toName(Sex, a.sex) == "Female").map(a => a.id).toArray();
        const byValue = await table(ArtistEntity).filter(a => a.sex == Sex.Female).map(a => a.id).toArray();
        assert.deepEqual([...byName].sort(), [...byValue].sort());
        assert.ok(byValue.length > 0);
    });

    test("inside a template string", async () => {
        const rows = await table(ArtistEntity).map(a => ({ text: `${Enum.toName(Sex, a.sex)} ${a.name}`, sex: a.sex, name: a.name })).toArray();
        for (const r of rows)
            assert.equal(r.text, `${Enum.toName(Sex, r.sex)} ${r.name}`);
    });
});
