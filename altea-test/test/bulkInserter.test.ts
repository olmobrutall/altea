import { before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { retrieve } from "@altea/altea/logic/Database";
import { BulkInserter } from "@altea/altea/logic/bulkInserter";
import { hasDb, start, txTest } from "./setup";
import { CountryEntity, BandEntity, BandEntity_Members, ArtistEntity } from "../entities/music";

// Exercises the bulk inserter (port of Signum's BulkInserter): the bulk transport is a
// connector primitive (SqlBulkCopy on SQL Server, COPY FROM STDIN on Postgres), not the saver.
// All bodies run in a rolled-back transaction (txTest) so nothing persists.

describe("BulkInserterTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // bulkInsertTable on an identity table: rows are bulk-copied and the DB assigns ids, which
    // are NOT read back (that's what bulkInsert's key query-back is for). Verify via a DB count.
    txTest("BulkInsertTableIdentity", async () => {
        const countries = ["BulkCty_A", "BulkCty_B", "BulkCty_C", "BulkCty_D"]
            .map(name => CountryEntity.create({ name }));
        const n = await BulkInserter.bulkInsertTable(countries);

        assert.equal(n, 4);
        const found = await table(CountryEntity).filter(c => c.name.startsWith("BulkCty_")).toArray();
        assert.equal(found.length, 4, "all four rows were bulk-copied");
        assert.deepEqual(found.map(c => c.name).sort(), ["BulkCty_A", "BulkCty_B", "BulkCty_C", "BulkCty_D"]);
    });

    // bulkInsert of a full entity with a collection: bulk-copy the bands, query the new rows
    // back and assign ids by the unique key (name), then wire + bulk-copy the member rows with
    // each band's id as the back-reference FK.
    txTest("BulkInsertFullEntityWithCollections", async () => {
        const artists = (await table(ArtistEntity).orderBy(a => a.name).toArray()).slice(0, 2);
        assert.equal(artists.length, 2, "need 2 seeded artists");

        const bands = [1, 2, 3].map(i => BandEntity.create({
            name: `BulkBand_${i}`,
            members: artists.map(a => BandEntity_Members.create({ member: a })),
            lastAward: null,
            otherAwards: [],
        }));

        const n = await BulkInserter.bulkInsert(bands, b => b.name);

        assert.equal(n, 3);
        assert.ok(bands.every(b => b.id != null && !b.isNew), "band ids assigned via key query-back");
        assert.equal(new Set(bands.map(b => b.id)).size, 3, "distinct band ids");

        // Member ids aren't read back (bulk copy returns none), but the FK wiring must have
        // persisted: read a band back and its members eager-load, pointing at the right artists.
        const dbBand = await retrieve(BandEntity, bands[1].id);
        assert.equal(dbBand.members.length, 2, "both members persisted under the band");
        assert.deepEqual(
            [...dbBand.members.map(m => m.member.id)].sort(),
            [...artists.map(a => a.id)].sort(),
            "members reference the right artists");
    });
});
