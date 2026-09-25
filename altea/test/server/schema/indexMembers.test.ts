import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { field, reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity, EmbeddedEntity, MixinEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { entity, mixin, column } from "@altea/altea/data/decorators";
import { SchemaBuilder } from "@altea/altea/server/schema";
import type { Table } from "@altea/altea/server/schema/table";
import type { IColumn } from "@altea/altea/server/schema/column";

// Index keys and filtered-index predicates resolve their member paths the same way (Table.field over a FieldRoute,
// Signum's Schema.FindField): an own field, a mixin's through an explicit `mixin(M)` step, then embedded
// steps. A field NAME that two mixins share is ambiguous and must name its mixin. DB-free.

void field;

@reflect
class IdxMemAddressEmbedded extends EmbeddedEntity {
    city: string = "";
}

@entity("Main", "Master")
class IdxMemTarget extends Entity {
    name: string = "";
}

@reflect
class IdxMemMixinA extends MixinEntity {
    tag: string | null = null;
    flag: boolean = false;
}

@reflect
class IdxMemMixinB extends MixinEntity {
    @column({ columnName: "FlagB" }) // the same FIELD name as IdxMemMixinA's, on a column of its own
    flag: boolean = false;
}

@entity("Main", "Master")
@mixin(() => [IdxMemMixinA, IdxMemMixinB])
class IdxMemEntity extends Entity {
    code: string = "";
    address: IdxMemAddressEmbedded | null = null;
    target: Lite<IdxMemTarget> | null = null;
}

function build(): Table {
    const sb = new SchemaBuilder();
    sb.include(IdxMemTarget);
    return sb.include(IdxMemEntity).table;
}

const only = (cols: IColumn[]): string => { assert.equal(cols.length, 1); return cols[0].name; };

describe("Index member paths", () => {
    test("a key over a mixin field, named through its mixin", () => {
        const table = build();
        table.addIndex(e => e.mixin(IdxMemMixinA).tag);
        const tagColumn = only(table.mixins["IdxMemMixinA"].fields["tag"].field.columns());
        assert.ok(table.indexes.some(ix => ix.columns.length == 1 && ix.columns[0].name == tagColumn));
    });

    test("a filtered-index predicate over a mixin field and an embedded one", () => {
        const table = build();
        table.addIndex(e => e.code, e => e.mixin(IdxMemMixinB).flag && e.address.city == "x");
        const flagB = only(table.mixins["IdxMemMixinB"].fields["flag"].field.columns());
        const where = table.indexes.at(-1)!.where!;
        assert.match(where, new RegExp(flagB));
        assert.doesNotMatch(where, new RegExp(only(table.mixins["IdxMemMixinA"].fields["flag"].field.columns()) + "\\b"));
        assert.match(where, /city/i);
    });

    test("a lite's .entity names the lite's own column", () => {
        const table = build();
        table.addIndex(e => e.code, e => e.target.entity != null);
        assert.match(table.indexes.at(-1)!.where!, /target/i);
    });

    test("a field name two mixins share must name its mixin", () => {
        const table = build();
        assert.throws(() => table.columnsFromFields(["flag"]), /several mixins/);
        assert.equal(only(table.columnsFromFields(["tag"])), only(table.mixins["IdxMemMixinA"].fields["tag"].field.columns()));
    });

    test("a path that leaves the row is refused", () => {
        const table = build();
        assert.throws(() => table.addIndex(e => e.target.entity.name), /not an embedded field/);
        assert.throws(() => table.addIndex(e => e.code, e => e.target.entity.name == "x"), /not an embedded field/);
        assert.throws(() => table.addIndex(e => e.mixin(IdxMemMixinA).nope), /'nope' is not a field of/);
    });
});
