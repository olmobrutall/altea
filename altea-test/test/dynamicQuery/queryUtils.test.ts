import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { PropertyRoute } from "@altea/altea/entities/propertyRoute";
import { TypeReference } from "@altea/altea/entities/reflection";
import {
    tryGetFilterType, getKey, getNiceName, type FilterType,
} from "@altea/altea/entities/dynamicQuery/queryUtils";
import {
    AlbumEntity, AlbumEntity_Songs, LabelEntity, ArtistEntity,
} from "../../entities/music";

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
        assert.equal(ft(AlbumEntity_Songs, "duration"), "Time"); // Duration
    });

    test("references map to Lite (entity, lite, and polymorphic)", () => {
        assert.equal(ft(LabelEntity, "country"), "Lite"); // plain entity ref
        assert.equal(ft(LabelEntity, "owner"), "Lite");   // Lite<LabelEntity>
        assert.equal(ft(AlbumEntity, "author"), "Lite");  // @implementedBy
    });

    test("embedded", () => {
        assert.equal(ft(AlbumEntity, "bonusTrack"), "Embedded");
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

