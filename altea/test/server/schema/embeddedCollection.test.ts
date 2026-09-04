import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, backReference, valueField, rowOrder, implementedBy, overrideImplementedBy } from "@altea/altea/data/decorators";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { IsNullable } from "@altea/altea/server/schema/dbType";
import { wireOwnedChildren } from "@altea/altea/server/saver";

// A COLLECTION DECLARED INSIDE AN EMBEDDED — Signum's `MList<T>` on an `EmbeddedEntity`
// (Signum.Test's own EmbeddedConfigEmbedded.Awards is exactly this shape).
//
// An embedded is FLATTENED onto its owner's row, so it has no id and no table of its own. A
// collection declared inside one therefore belongs to the entity that HOLDS the embedded: the row
// type's `@backReference` names that entity, never the embedded. This file pins the schema half —
// the physical naming in both modes, and the check that refuses a back reference pointing anywhere
// else. DB-free: builds the schema in memory.

@entity("Main", "Master")
class EcTag extends Entity {
    name: string;
}

@entity("Main", "Master")
class EcOwner extends Entity {
    title: string;
    // The embedded is NULLABLE, which is the ordinary case (and the one whose rows must be swept
    // when it is cleared — see the ORM suite).
    settings: EcSettings | null;
}

@reflect
class EcSettings extends EmbeddedEntity {
    label: string | null;
    // The collection, one level down. Its rows point back at EcOwner.
    tags: EcOwner_Tag[];
}

@entity("Part")
class EcOwner_Tag extends Entity {
    @backReference
    owner: Lite<EcOwner>;

    // Signum's [PreserveOrder]: the row's index in the collection, wired by the save cascade.
    @rowOrder
    order: number;

    @valueField
    tag: Lite<EcTag>;
}

// A second embedded, nested inside the first — the collection is then two members deep.
@entity("Main", "Master")
class EcDeepOwner extends Entity {
    outer: EcOuter | null;
}

@reflect
class EcOuter extends EmbeddedEntity {
    inner: EcInner | null;
}

@reflect
class EcInner extends EmbeddedEntity {
    tags: EcDeepOwner_Tag[];
}

@entity("Part")
class EcDeepOwner_Tag extends Entity {
    @backReference
    owner: Lite<EcDeepOwner>;

    @valueField
    tag: Lite<EcTag>;
}

// The refusal case: the row points at the EMBEDDED (which has no table) instead of the entity.
@entity("Main", "Master")
class EcBadOwner extends Entity {
    settings: EcBadSettings | null;
}

@reflect
class EcBadSettings extends EmbeddedEntity {
    tags: EcBad_Tag[];
}

@entity("Part")
class EcBad_Tag extends Entity {
    // Wrong on purpose: an embedded is not a table, so nothing can reference it.
    @backReference
    owner: Lite<EcTag>;
}

// The CROSS-PACKAGE shape: a row type declared where the owning entity cannot be named (a framework
// package whose owner is an application entity), so its back reference is an empty @implementedBy the
// application widens with overrideImplementedBy. This is how the three directory configurations reach
// eastwind's ApplicationConfigurationEntity.
@entity("Main", "Master")
class EcAppOwner extends Entity {
    settings: EcAppSettings | null;
}

@reflect
class EcAppSettings extends EmbeddedEntity {
    tags: EcApp_Tag[];
}

@entity("Part")
class EcApp_Tag extends Entity {
    @backReference @implementedBy(() => []) owner: Lite<Entity>;

    @valueField
    tag: Lite<EcTag>;
}

// What the application's EntityOverrides does.
overrideImplementedBy<any>(EcApp_Tag as any, "owner", () => [EcAppOwner as any]);

function build(configure?: (sb: SchemaBuilder) => void): SchemaBuilder {
    const sb = new SchemaBuilder();
    configure?.(sb);
    return sb;
}

describe("collections inside embeddeds", () => {

    test("the owner's table carries NO column for the collection (the rows live in the child table)", () => {
        const sb = build();
        const cols = Object.keys(sb.include(EcOwner as any).table.columns);
        assert.ok(cols.includes("Settings_Label"), cols.join(", "));      // the embedded IS flattened
        assert.ok(cols.includes("Settings_HasValue"), cols.join(", "));
        assert.ok(!cols.some(c => c.includes("Tags")), cols.join(", "));  // …but the collection is not
    });

    test("the child table's back reference points at the ENTITY that holds the embedded", () => {
        const sb = build();
        sb.include(EcOwner as any);
        const child = sb.include(EcOwner_Tag as any).table;
        const fk = child.fields["owner"].field.columns()[0];
        assert.equal(fk.name, "OwnerID");
        assert.equal(fk.referenceTable!.type, EcOwner as any);
    });

    test("a back reference that does NOT name the holding entity is refused at schema build", () => {
        const sb = build();
        sb.include(EcBadOwner as any);
        assert.throws(() => sb.complete(), (e: Error) => {
            // The message names the ROUTE through the embedded, not just the member.
            assert.match(e.message, /settings\.tags/);
            assert.match(e.message, /collection inside an embedded/);
            return true;
        });
    });

    test("normal mode names the child table after the ROW TYPE (altea's own rule, unchanged)", () => {
        const sb = build(sb => { sb.settings.isPostgres = true; });
        sb.include(EcOwner as any);
        assert.equal(sb.include(EcOwner_Tag as any).table.name.name, "ec_owner__tag");
    });

    test("legacy mode names it from the whole ROUTE, as Signum's NameSequence does", () => {
        const sb = build(sb => { sb.settings.isPostgres = true; sb.settings.legacyMode = true; });
        sb.include(EcOwner as any);
        // Signum: table.Name.Name + "_" + NameSequence("Settings" + "Tags")
        assert.equal(sb.include(EcOwner_Tag as any).table.name.name, "ec_owner_settings_tags");
    });

    test("legacy mode composes EVERY member of a nested route", () => {
        const sb = build(sb => { sb.settings.isPostgres = true; sb.settings.legacyMode = true; });
        sb.include(EcDeepOwner as any);
        assert.equal(sb.include(EcDeepOwner_Tag as any).table.name.name, "ec_deep_owner_outer_inner_tags");
    });

    // The save cascade's wiring half, which has to reach one member deeper than the entity's own
    // fields: each row is pointed at the ENTITY holding the embedded (an embedded has no id) and
    // numbered by its index.
    test("the save cascade wires each row to the holding ENTITY and numbers it", () => {
        const owner = EcOwner.create({
            title: "w",
            settings: EcSettings.create({
                label: null,
                tags: [EcOwner_Tag.create({ tag: null! }), EcOwner_Tag.create({ tag: null! })],
            }),
        });
        owner.id = 42 as any;
        owner.isNew = false;

        wireOwnedChildren(owner);

        const rows = owner.settings!.tags;
        assert.deepEqual(rows.map(r => r.order), [0, 1]);
        assert.ok(rows.every(r => (r.owner as any) === owner), "pointed at the entity, not the embedded");
    });

    // Option the application picks when the row type cannot name its owner.
    test("a back reference may be an @implementedBy the application widened", () => {
        const sb = build();
        sb.include(EcAppOwner as any);
        sb.complete();
        const child = sb.include(EcApp_Tag as any).table;
        const cols = child.fields["owner"].field.columns();
        assert.equal(cols.length, 1, "one implementation, one column");
        assert.equal(cols[0].referenceTable!.type, EcAppOwner as any);
        // A polymorphic column is normally nullable (only one of several is filled); a back reference
        // resolves to exactly one, so it carries the field's own nullability — Signum's ParentID is NOT NULL.
        assert.equal(cols[0].nullable, IsNullable.No);
    });

    test("legacy mode names that same column ParentID", () => {
        const sb = build(sb => { sb.settings.isPostgres = true; sb.settings.legacyMode = true; });
        sb.include(EcAppOwner as any);
        const cols = Object.keys(sb.include(EcApp_Tag as any).table.columns);
        assert.ok(cols.includes("parent_id"), cols.join(", "));
        assert.ok(!cols.some(c => c.startsWith("owner_id")), cols.join(", "));
    });

    test("legacy mode treats it as an MLIST table: no Ticks, and a ParentID back reference", () => {
        const sb = build(sb => { sb.settings.isPostgres = true; sb.settings.legacyMode = true; });
        sb.include(EcOwner as any);
        const cols = Object.keys(sb.include(EcOwner_Tag as any).table.columns);
        // An MList table is not an entity in Signum, so it has no concurrency stamp…
        assert.ok(!cols.some(c => /ticks/i.test(c)), cols.join(", "));
        // …its back reference is always ParentID, and its value column is named from the element
        // TYPE (EcTag), not from the `tag` field altea invented for the row.
        assert.ok(cols.includes("parent_id"), cols.join(", "));
        assert.ok(cols.includes("ec_tag_id"), cols.join(", "));
    });
});
