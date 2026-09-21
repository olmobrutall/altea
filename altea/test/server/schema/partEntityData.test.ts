import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { getTypeInfo } from "@altea/altea/data/reflection"; // also the transformer's @field-injection anchor
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, part, backReference, overrideImplementedBy } from "@altea/altea/data/decorators";
import { SchemaBuilder } from "@altea/altea/server/schema";

// A `@part` takes NO EntityData: it is reached and saved through the entity that owns it, so its data is
// the OWNER's by construction — which is Signum's own rule for an MList table. `@part("Master")` is not a
// second form, it is a compile error; sixty declarations used to restate a value that is derived, which is
// how the two drift the moment an owner changes.
//
// DB-free: builds the schema in memory and reads the effective TypeInfo back.

@entity("Main", "Transactional")
class PdOwner extends Entity {
    name: string;
    lines: PdOwner_Line[];
    settings: PdSettings;
}

@part
class PdOwner_Line extends Entity {
    @backReference
    owner: Lite<PdOwner>;
    label: string;
}

// A part reached through a SINGLE field, and one reached through a chain of parts: both inherit, the
// second transitively.
@part
class PdSettings extends Entity {
    @backReference
    owner: Lite<PdOwner>;
    inner: PdSettings_Inner;
}

@part
class PdSettings_Inner extends Entity {
    @backReference
    owner: Lite<PdSettings>;
    value: string;
}

// The case `include` cannot see: the owner declares `@implementedBy(() => [])` and the APP widens it, by
// which time the owner's table is complete — so nothing ever included the part with the owner's data in
// hand. `complete()` propagates it from the whole model instead.
@entity("Main", "Master")
class PdWidenedOwner extends Entity {
    content: Entity;
}

@part
class PdWidenedPart extends Entity {
    @backReference
    owner: Lite<PdWidenedOwner>;
    text: string;
}

// And a part NOTHING references — Signum has two of these (HelpImage, UserTreePart) and declares both
// Master, because there is no owner to ask.
@part
class PdOrphan extends Entity {
    text: string;
}

// What the application's EntityOverrides does — AFTER the owner's own module would have run.
overrideImplementedBy<any>(PdWidenedOwner as any, (o: any) => o.content, () => [PdWidenedPart as any]);

describe("a @part's EntityData comes from its owner", () => {
    test("through a collection, a single reference, and a chain of parts", () => {
        const sb = new SchemaBuilder();
        sb.include(PdOwner);
        sb.include(PdWidenedOwner);
        sb.include(PdOrphan);
        sb.complete();

        assert.equal(getTypeInfo(PdOwner_Line)!.entityData, "Transactional");
        assert.equal(getTypeInfo(PdSettings)!.entityData, "Transactional");
        assert.equal(getTypeInfo(PdSettings_Inner)!.entityData, "Transactional");

        // The widened @implementedBy: an app names the part after the owner's table is complete, so this
        // one is filled by the whole-model pass in `complete`, not by `include`.
        assert.equal(getTypeInfo(PdWidenedPart)!.entityData, "Master");

        // No owner at all → "Master", which is what Signum declares for both of its ownerless parts
        // (HelpImage, UserTreePart).
        assert.equal(getTypeInfo(PdOrphan)!.entityData, "Master");
    });
});

