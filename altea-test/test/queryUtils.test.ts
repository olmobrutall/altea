import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { PropertyRoute } from "@altea/altea/entities/propertyRoute";
import { LiteralType } from "@altea/altea/entities/runtimeTypes";
import {
    FilterType, tryGetFilterType, tryGetFilterTypeFromTypeName, getKey, getNiceName,
} from "@altea/altea/logic/dynamicQuery/queryUtils";
import { QueryDescription, ColumnDescription } from "@altea/altea/logic/dynamicQuery/queryDescription";
import {
    AlbumEntity, AlbumEntity_Songs, LabelEntity, ArtistEntity,
} from "../entities/music";

// Phase-1 DynamicQuery port: QueryUtils (FilterType + keys) + QueryDescription/ColumnDescription.
// DB-free — classifies types read off PropertyRoute (Phase 0).

describe("QueryUtils.tryGetFilterType", () => {
    const ft = (root: Function, path: string) => tryGetFilterType(PropertyRoute.parse(root, path).type);

    test("scalars", () => {
        assert.equal(ft(LabelEntity, "name"), FilterType.String);
        assert.equal(ft(AlbumEntity, "year"), FilterType.Integer);
        assert.equal(ft(ArtistEntity, "dead"), FilterType.Boolean);
        assert.equal(ft(ArtistEntity, "sex"), FilterType.Enum);
    });

    test("temporal", () => {
        assert.equal(ft(AlbumEntity_Songs, "duration"), FilterType.Time); // Duration
    });

    test("references map to Lite (entity, lite, and polymorphic)", () => {
        assert.equal(ft(LabelEntity, "country"), FilterType.Lite); // plain entity ref
        assert.equal(ft(LabelEntity, "owner"), FilterType.Lite);   // Lite<LabelEntity>
        assert.equal(ft(AlbumEntity, "author"), FilterType.Lite);  // @implementedBy
    });

    test("embedded", () => {
        assert.equal(ft(AlbumEntity, "bonusTrack"), FilterType.Embedded);
    });

    test("Integer/Decimal split via typeName", () => {
        assert.equal(tryGetFilterTypeFromTypeName("Decimal", LiteralType.number), FilterType.Decimal);
        assert.equal(tryGetFilterTypeFromTypeName("Number", LiteralType.number), FilterType.Integer);
        assert.equal(tryGetFilterTypeFromTypeName("String", LiteralType.string), FilterType.String);
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

describe("QueryDescription / ColumnDescription", () => {
    test("the Entity column is flagged; others are not", () => {
        const entityCol = new ColumnDescription("Entity", LiteralType.null, "Album");
        const nameCol = new ColumnDescription("Name", LiteralType.string, "Name");
        assert.equal(entityCol.isEntity, true);
        assert.equal(nameCol.isEntity, false);
        assert.equal(entityCol.toString(), "Album");
    });

    test("QueryDescription holds name + columns", () => {
        const qd = new QueryDescription(AlbumEntity, [
            new ColumnDescription("Entity", LiteralType.null, "Album"),
            new ColumnDescription("Name", LiteralType.string, "Name"),
        ]);
        assert.equal(getKey(qd.queryName), "Album");
        assert.equal(qd.columns.length, 2);
        assert.equal(qd.columns[0].isEntity, true);
    });
});
