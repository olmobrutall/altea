import { before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { retrieve } from "@altea/altea/logic/Database";
import { hasDb, start, txTest } from "./setup";
import { CountryEntity, LabelEntity } from "../entities/music";

// Exercises the graph Saver's cycle handling (Signum's DirectedGraph.FeedbackEdgeSet +
// Forbidden deferred-FK). LabelEntity.owner is a NULLABLE self-reference, so two new
// labels that own each other form a save-time reference cycle: neither can be inserted
// with its owner FK filled because the other has no id yet. The Saver breaks the cycle by
// inserting one with owner = NULL (the feedback edge), then filling it with a deferred
// UPDATE once both ids exist. Before cycle handling landed, `.save()` threw here.
//
// txTest wraps the body in a rolled-back transaction, so the two rows never persist into
// the shared sample database (reads inside still see them — same connection).

describe("SaverTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Two new labels, each the other's owner (a 2-cycle through the nullable owner FK).
    txTest("SaveReferenceCycle", async () => {
        const usa = await table(CountryEntity).first();

        const a = LabelEntity.create({ name: "Cycle A", country: usa, owner: null });
        const b = LabelEntity.create({ name: "Cycle B", country: usa, owner: null });
        // Fat lites (a.k.a. toLiteFat): the owner FK reads the target's *live* id, which is
        // filled once that target is inserted — the whole point of the deferred FK pass.
        a.owner = b.toLite(true);
        b.owner = a.toLite(true);

        await a.save(); // saves the whole reachable graph → both labels, in one transaction

        assert.ok(a.id != null && !a.isNew, "A was inserted");
        assert.ok(b.id != null && !b.isNew, "B was inserted");

        // Read the rows back from the database to prove the cyclic FKs were persisted (not
        // left NULL from the first insert): each label's stored owner points at the other.
        const dbA = await retrieve(LabelEntity, a.id);
        const dbB = await retrieve(LabelEntity, b.id);
        assert.equal(dbA.owner?.id, b.id, "A.owner persisted as B");
        assert.equal(dbB.owner?.id, a.id, "B.owner persisted as A");
    });

    // A self-owning label (a 1-cycle: owner points at itself). The single feedback edge is
    // the entity's own back-reference; it inserts with owner = NULL, then the deferred pass
    // sets owner = its own id.
    txTest("SaveSelfReferenceCycle", async () => {
        const usa = await table(CountryEntity).first();
        const self = LabelEntity.create({ name: "Cycle Self", country: usa, owner: null });
        self.owner = self.toLite(true);

        await self.save();

        assert.ok(self.id != null && !self.isNew);
        const dbSelf = await retrieve(LabelEntity, self.id);
        assert.equal(dbSelf.owner?.id, self.id, "self.owner persisted as itself");
    });
});
