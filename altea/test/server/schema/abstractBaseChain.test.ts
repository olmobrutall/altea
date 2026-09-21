import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";
import { SchemaBuilder } from "@altea/altea/server/schema";

// A chain of ABSTRACT `@reflect` bases, each contributing fields, with concrete entities joining at
// different depths. DB-free: builds the schema in memory and inspects table.columns.
//
// This is the shape the stored filter rows use — QueryFilterBaseEntity, then
// QueryFilterPinnedBaseEntity adding the two members only a SearchControl-backed owner has, then one
// concrete `@part` row per owner joining at whichever level fits. A concrete row joining at the TOP
// must not acquire the middle's columns, and one joining at the middle must get BOTH levels'.

@reflect
class ChainNote extends EmbeddedEntity {
    label: string | null;
}

@reflect
abstract class ChainBase extends Entity {
    common: string | null;
}

@reflect
abstract class ChainMiddle extends ChainBase {
    extra: string | null;
    note: ChainNote | null;
}

/** Joins at the TOP — must have the base's fields and none of the middle's. */
@entity("Main", "Transactional")
class ChainShallow extends ChainBase {
    ownName: string | null;
}

/** Joins at the MIDDLE — must have BOTH levels' fields. */
@entity("Main", "Transactional")
class ChainDeep extends ChainMiddle {
    ownName: string | null;
}

function columnsOf(ctor: any): string[] {
    return Object.keys(new SchemaBuilder().include(ctor).table.columns);
}

describe("a chain of abstract bases", () => {

    test("a concrete entity joining at the TOP gets the base's fields only", () => {
        const cols = columnsOf(ChainShallow);
        assert.ok(cols.includes("Common"), cols.join(", "));
        assert.ok(cols.includes("OwnName"), cols.join(", "));
        // the whole point of the split: the middle's fields are NOT here
        assert.ok(!cols.includes("Extra"), cols.join(", "));
        assert.ok(!cols.some(c => c.startsWith("Note_")), cols.join(", "));
    });

    test("a concrete entity joining at the MIDDLE gets BOTH levels' fields", () => {
        const cols = columnsOf(ChainDeep);
        assert.ok(cols.includes("Common"), cols.join(", "));
        assert.ok(cols.includes("Extra"), cols.join(", "));
        assert.ok(cols.includes("Note_Label"), cols.join(", "));
        assert.ok(cols.includes("OwnName"), cols.join(", "));
    });

    test("the two concrete tables differ by exactly the middle's contribution", () => {
        const shallow = new Set(columnsOf(ChainShallow));
        const onlyDeep = columnsOf(ChainDeep).filter(c => !shallow.has(c));
        // `Note_HasValue` is the null marker a NULLABLE embedded carries beside its members.
        assert.deepEqual(onlyDeep.sort(), ["Extra", "Note_HasValue", "Note_Label"]);
    });
});
