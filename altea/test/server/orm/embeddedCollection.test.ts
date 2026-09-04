import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { Serializer } from "@altea/altea/data/serializer";
import { cleanModified } from "@altea/altea/data/changes";
import { hasDb, start, txTest } from "../setup";
import {
    ConfigEntity, ConfigEntity_Award, EmbeddedConfigEmbedded, GrammyAwardEntity,
} from "../../data/music";

// A COLLECTION DECLARED INSIDE AN EMBEDDED, end to end. Signum's EmbeddedConfigEmbedded.Awards
// (MList<Lite<GrammyAwardEntity>>) is exactly this, and the fixture now mirrors it.
//
// The embedded is FLATTENED onto ConfigEntity's row, so it has no id of its own — which is why
// ConfigEntity_Award's @backReference names ConfigEntity. Everything the saver and the LINQ
// provider do for a top-level collection has to reach one member deeper: wiring the back
// reference and the row order, sweeping orphans, eager-loading on retrieve, and correlating in
// SQL. The schema half is pinned DB-free in server/schema/embeddedCollection.test.ts.

describe("EmbeddedCollectionTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // The seeded config (MusicLoader) has one award inside its embedded.
    txTest("Retrieve eager-loads a collection declared inside an embedded", async () => {
        const config = await table(ConfigEntity).orderBy(c => c.id).first();
        assert.ok(config.embeddedConfig != null, "the embedded was read");
        assert.equal(config.embeddedConfig!.awards.length, 1);
        assert.ok(config.embeddedConfig!.awards[0].award != null);
        // The row points back at the CONFIG, which is the whole point.
        assert.equal(config.embeddedConfig!.awards[0].config.id, config.id);
    });

    txTest("Insert wires each row's back reference to the entity, and its order", async () => {
        const ga = await table(GrammyAwardEntity).first();

        const c = ConfigEntity.create({
            embeddedConfig: EmbeddedConfigEmbedded.create({
                defaultLabel: null,
                awards: [
                    ConfigEntity_Award.create({ award: ga.toLite() }),
                    ConfigEntity_Award.create({ award: ga.toLite() }),
                ],
            }),
        });
        await c.save();

        const back = await retrieve(ConfigEntity, c.id);
        const rows = back.embeddedConfig!.awards;
        assert.equal(rows.length, 2);
        assert.ok(rows.every(r => r.award.id === ga.id));
        assert.ok(rows.every(r => r.config.id === c.id), "every row points at the config");
    });

    txTest("Removing an element deletes its row (the orphan sweep reaches into the embedded)", async () => {
        const ga = await table(GrammyAwardEntity).first();

        const c = ConfigEntity.create({
            embeddedConfig: EmbeddedConfigEmbedded.create({
                defaultLabel: null,
                awards: [
                    ConfigEntity_Award.create({ award: ga.toLite() }),
                    ConfigEntity_Award.create({ award: ga.toLite() }),
                ],
            }),
        });
        await c.save();
        const droppedId = c.embeddedConfig!.awards[1].id;

        c.embeddedConfig!.awards = [c.embeddedConfig!.awards[0]];
        await c.save();

        const back = await retrieve(ConfigEntity, c.id);
        assert.equal(back.embeddedConfig!.awards.length, 1);
        const orphan = await table(ConfigEntity_Award).count(r => r.id == droppedId);
        assert.equal(orphan, 0, "the dropped row was deleted, not left orphaned");
    });

    // Clearing the embedded takes its rows with it: the embedded and its collection are one unit
    // (Signum deletes an MList table's rows when the owner's MList is emptied).
    txTest("Clearing the embedded deletes the rows it held", async () => {
        const ga = await table(GrammyAwardEntity).first();

        const c = ConfigEntity.create({
            embeddedConfig: EmbeddedConfigEmbedded.create({
                defaultLabel: null,
                awards: [ConfigEntity_Award.create({ award: ga.toLite() })],
            }),
        });
        await c.save();
        const rowId = c.embeddedConfig!.awards[0].id;

        c.embeddedConfig = null;
        await c.save();

        const back = await retrieve(ConfigEntity, c.id);
        assert.equal(back.embeddedConfig, null);
        const orphan = await table(ConfigEntity_Award).count(r => r.id == rowId);
        assert.equal(orphan, 0, "the embedded's rows went with it");
    });

    // The collection correlates on the OWNER's id, so it is navigable in SQL like any other.
    txTest("The collection is queryable through the embedded", async () => {
        const counts = await table(ConfigEntity)
            .map(c => ({ id: c.id, awards: c.embeddedConfig!.awards.length }))
            .toArray();
        assert.ok(counts.length > 0);
        assert.ok(counts.some(x => x.awards > 0), JSON.stringify(counts));
    });
});

// The wire half needs no database: a collection element omits its @backReference (it is
// recoverable) and the codec fills it back in on the way in. The owner it must recover is the
// nearest ENTITY ancestor — before this, the immediate container was used, and an embedded has
// no toLite().
describe("EmbeddedCollectionSerialization", () => {

    test("a collection element inside an embedded recovers a back reference to the ENTITY", () => {
        const config = ConfigEntity.create({ embeddedConfig: null });
        config.id = 7 as any; config.isNew = false; config.ticks = 1;
        cleanModified(config);

        const json = {
            $type: "Config",
            id: 7,
            ticks: 1,
            embeddedConfig: {
                defaultLabel: null,
                // no `config` key: the back reference is omitted on the wire and recovered here
                awards: [{ award: { $lite: "GrammyAward", id: 3, toStr: "Grammy" } }],
            },
        };

        const parsed = Serializer.parse(JSON.stringify(json)) as ConfigEntity;
        const row = parsed.embeddedConfig!.awards[0];
        assert.ok(row.config != null, "the back reference was recovered");
        assert.equal(row.config.id, 7);
        assert.equal(row.config.entityType, ConfigEntity);
    });
});
