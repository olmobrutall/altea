import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { TypeReference } from "@altea/altea/data/reflection";
import {
    tryGetFilterType, getKey, getNiceName, type FilterType,
} from "@altea/altea/data/dynamicQuery/queryUtils";
import {
    AlbumEntity, AlbumEntity_Song, LabelEntity, ArtistEntity,
} from "../music";

// Phase-1 DynamicQuery port: QueryUtils (FilterType + keys). DB-free — classifies types read off
// PropertyRoute (Phase 0).

describe("QueryUtils.tryGetFilterType", () => {
    const ft = (root: Function, path: string) => tryGetFilterType(PropertyRoute.parse(root, path).type);

    test("scalars", () => {
        assert.equal(ft(LabelEntity, "name"), "String");
        assert.equal(ft(AlbumEntity, "year"), "Integer");
        assert.equal(ft(ArtistEntity, "dead"), "Boolean");
        assert.equal(ft(ArtistEntity, "sex"), "Enum");
    });

    test("temporal", () => {
        assert.equal(ft(AlbumEntity_Song, "duration"), "Time"); // Duration
    });

    test("references map to Lite (entity, lite, and polymorphic)", () => {
        assert.equal(ft(LabelEntity, "country"), "Lite"); // plain entity ref
        assert.equal(ft(LabelEntity, "owner"), "Lite");   // Lite<LabelEntity>
        assert.equal(ft(AlbumEntity, "author"), "Lite");  // @implementedBy
    });

    test("embedded", () => {
        assert.equal(ft(AlbumEntity, "bonusTrack"), "Embedded");
    });

    // A COLLECTION has no filter type (Signum: MList<T> matches none of TryGetFilterType's cases), so it is
    // not filterable / orderable / GROUPABLE — you navigate it (.Any / .Element) instead. altea has to test
    // the array facet FIRST, since an array TypeReference also carries its element type (a `Lite<T>[]` would
    // otherwise read as "Lite").
    test("collections have no filter type", () => {
        assert.equal(ft(AlbumEntity, "songs"), undefined);
    });

    test("Integer/Decimal split via typeName + subTypeName", () => {
        assert.equal(tryGetFilterType(new TypeReference({ typeName: "Decimal" })), "Decimal");
        assert.equal(tryGetFilterType(new TypeReference({ typeName: "Number", subTypeName: "decimal" })), "Decimal");
        assert.equal(tryGetFilterType(new TypeReference({ typeName: "Number" })), "Integer");
        assert.equal(tryGetFilterType(new TypeReference({ typeName: "String" })), "String");
    });
});

describe("QueryUtils keys", () => {
    test("getKey", () => {
        assert.equal(getKey(AlbumEntity), "Album");
        assert.equal(getKey("Music.CustomQuery"), "Music.CustomQuery");
    });

    test("getNiceName returns a non-empty display string", () => {
        assert.ok(getNiceName(AlbumEntity).length > 0);
        assert.equal(getNiceName("Custom"), "Custom");
    });
});

