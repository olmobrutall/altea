import { beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { moveAllForeignKeys } from "@altea/altea/server/Administrator";
import { hasDb, start, txTest } from "../setup";
import { AlbumEntity, CountryEntity, LabelEntity } from "../../data/music";

// Signum's Administrator.MoveAllForeignKeys: every column that references the row now references another
// one. Here the labels' albums (album.label) and sub-labels (label.owner) move from one label to another.

describe.skipIf(!hasDb)("MoveAllForeignKeys", () => {
    beforeAll(async () => { await start(); });

    txTest("MovesEveryReferencingColumn", async () => {
        const country = await table(CountryEntity).first();
        const from = await table(AlbumEntity).map(a => a.label).first() as LabelEntity;
        const to = await LabelEntity.create({ name: "Move target", country, owner: null }).save();
        const sub = await LabelEntity.create({ name: "Sub label", country, owner: from.toLite() }).save();

        const albums = await table(AlbumEntity).count(a => a.label.is(from));
        assert.ok(albums > 0, "the source label has albums");

        await moveAllForeignKeys(from.toLite(), to.toLite());

        assert.equal(await table(AlbumEntity).count(a => a.label.is(from)), 0);
        assert.equal(await table(AlbumEntity).count(a => a.label.is(to)), albums);
        assert.equal((await table(LabelEntity).single(l => l.id == sub.id)).owner?.id, to.id);
    });

    txTest("RefusesTheSameRow", async () => {
        const label = await table(LabelEntity).first();
        await assert.rejects(() => moveAllForeignKeys(label.toLite(), label.toLite()), /should not be the same/);
    });
});
