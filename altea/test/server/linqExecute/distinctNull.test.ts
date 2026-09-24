import { test, beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { distinctNull } from "@altea/altea/data/linqHints";
import { hasDb, start } from "../setup";
import { ArtistEntity, Status } from "../../data/music";

// Signum's LinqHints.DistinctNull: null counts as a value, in memory and in SQL alike.

describe("distinctNull", () => {
    test("in memory", () => {
        assert.equal(distinctNull(null, null), false);
        assert.equal(distinctNull(null, 3), true);
        assert.equal(distinctNull(3, null), true);
        assert.equal(distinctNull(3, 3), false);
        assert.equal(distinctNull(3, 4), true);
    });
});

describe.skipIf(!hasDb)("distinctNull in SQL", () => {
    beforeAll(async () => { await start(); });

    test("answers every row as it does in memory, NULL included", async () => {
        const artists = await table(ArtistEntity).toArray() as ArtistEntity[];
        assert.ok(artists.some(a => a.status == null) && artists.some(a => a.status != null), "the fixture has both");

        for (const other of [null, Status.Married]) {
            const inSql = await table(ArtistEntity).filter(a => distinctNull(a.status, other)).map(a => a.name).toArray();
            const inMemory = artists.filter(a => distinctNull(a.status, other)).map(a => a.name);
            assert.deepEqual([...inSql].sort(), [...inMemory].sort(), `against ${other}`);
        }
    });
});
