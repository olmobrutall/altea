import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { isPartType } from "@altea/altea/data/propertyRoute";
import { tryGetTypeInfo } from "@altea/altea/data/reflection";
import { AlbumEntity, AlbumEntity_Song } from "../../data/music";
import { CastProbeTextPartEntity } from "../../data/castProbe";

// `TypeEntity.isPart` — NEW here, Signum has no such column. It exists so a type PICKER can filter
// SERVER-side (`isPart == false` in the query request) instead of hiding rows a page already fetched,
// which would lie about the total count. DB-free: the column shape comes off the built schema, and the
// VALUE is `isPartType` — the one predicate the route rules and the token layer also go through, so the
// row and the model cannot disagree about what a part is.

describe("TypeEntity.isPart", () => {

    test("the column exists, is a NOT NULL boolean", () => {
        const table = new SchemaBuilder().include(TypeEntity).table;
        const column = table.columns["IsPart"];
        assert.ok(column != undefined, Object.keys(table.columns).join(", "));
        assert.equal(column.nullable, "No");
        assert.equal(table.fields["isPart"].fieldInfo.typeName, "Boolean");
    });

    test("its value is isPartType, so a part is true and an ordinary entity is false", () => {
        assert.equal(isPartType(AlbumEntity_Song), true);          // a collection element
        assert.equal(isPartType(CastProbeTextPartEntity), true);   // a polymorphic reference's content
        assert.equal(isPartType(AlbumEntity), false);
        assert.equal(isPartType(TypeEntity), false);
    });

    test("SharedPart is NOT a part here — it stands alone, so it stays pickable", () => {
        // `isPartType` tests for the "Part" kind exactly; `SharedPart` is the kind Signum gives a row
        // with SEVERAL owners, and re-rooting is the only unambiguous thing to do for one.
        assert.notEqual(tryGetTypeInfo(AlbumEntity_Song)?.entityKind, "SharedPart");
        assert.equal(isPartType(TypeEntity), false);
    });
});
