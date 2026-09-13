import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Serializer } from "@altea/altea/data/serializer";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { reflect } from "@altea/altea/data/reflection";
import { part } from "@altea/altea/data/decorators";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";

// A ModelEntity holding `@part` rows — a field and a collection. Signum's counterpart is an owned
// EmbeddedEntity and an `MList<TEmbedded>` on a ModelEntity, both of which it allows freely; altea's
// stand-in for either is a `@part`, so a model must be able to hold one or the whole family of
// "a model with a repeatable block" has no shape (altea-help's two import models had to fall back to
// plain EmbeddedEntity for exactly this).
//
// The two things that made it impossible are gone:
//  - a `@part` no longer RE-ROOTS, so `lines/label` is a route of the MODEL rather than of the row
//    (PropertyRoute.isPartType);
//  - the codec recovers the nearest ENTITY ancestor rather than the immediate container, so a model —
//    which is not an Entity and has no `toLite()` — yields NO owner instead of dying on one. A
//    model-held row is never persisted, so there is nothing for a `@backReference` to point at and
//    none is declared.
@part
class ModelProbeEntity_Line extends Entity {
    label: string;
    amount: number;
}

@reflect
class ModelProbeModel extends ModelEntity {
    title: string;
    lines: ModelProbeEntity_Line[];
    header: ModelProbeEntity_Line;
}

describe("a ModelEntity holding @part rows", () => {
    test("a @part collection and a @part field round-trip", () => {
        const m = ModelProbeModel.create({
            title: "Q3",
            lines: [
                ModelProbeEntity_Line.create({ label: "a", amount: 1 }),
                ModelProbeEntity_Line.create({ label: "b", amount: 2 }),
            ],
            header: ModelProbeEntity_Line.create({ label: "h", amount: 0 }),
        });

        const json = Serializer.stringify(m);
        const back = Serializer.parse(json) as ModelProbeModel;

        assert.equal(back.title, "Q3");
        assert.equal(back.lines.length, 2);
        assert.deepEqual(back.lines.map(l => l.label), ["a", "b"]);
        assert.equal(back.header.label, "h");
        // No owner to recover: a model is not an Entity, so nothing is stamped and nothing throws.
        assert.equal((back.lines[0] as unknown as Record<string, unknown>).order, undefined);
        assert.equal(Serializer.stringify(back), json);   // idempotent
    });

    test("its routes are the MODEL's, not the row's", () => {
        const root = PropertyRoute.root(ModelProbeModel);
        assert.equal(root.add("lines").add("Item").add("label").propertyString(), "lines/label");
        assert.equal(root.add("header").add("label").propertyString(), "header.label");

        const paths = PropertyRoute.generateRoutes(ModelProbeModel, true).map(r => r.propertyString());
        assert.ok(paths.includes("lines/label"), paths.join(", "));
        assert.ok(paths.includes("header.amount"), paths.join(", "));
    });
});
