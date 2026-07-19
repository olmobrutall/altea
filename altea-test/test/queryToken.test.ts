import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table, bindAndOptimize } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { ProjectionExpression } from "@altea/altea/logic/linq/expressions.sql";
import {
    ParameterExpression, LambdaExpression, CallExpression, PropertyExpression,
} from "@altea/altea/logic/linq/expressions";
import { ClassType, ArrayType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { ColumnDescription } from "@altea/altea/logic/dynamicQuery/queryDescription";
import { BuildExpressionContext, ExpressionBox, SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { ColumnToken } from "@altea/altea/logic/dynamicQuery/tokens/columnToken";
import "@altea/altea/logic/dynamicQuery/tokens/factories"; // registers token factories
import { MusicLogic } from "../logic/MusicLogic";
import { AlbumEntity } from "../entities/music";

// Phase-2 DynamicQuery port: QueryToken base + ColumnToken + EntityPropertyToken. The core is the
// BuildExpression retarget — a token tree hand-builds altea Expression nodes the Phase-D binder
// consumes (the retrieveByIdsProjection recipe).

const O = SubTokensOptionsAll;

// The root "Entity" column token for the Album query.
function entityToken(): ColumnToken {
    const col = new ColumnDescription("Entity", new ClassType(AlbumEntity), "Album");
    col.implementations = Implementations.by(AlbumEntity);
    return new ColumnToken(col, AlbumEntity);
}

// A BuildExpressionContext with the row parameter seeded as the "Entity" column (stands in for
// the QueryRequest/DQueryable layer, deferred).
function contextFor() {
    const param = new ParameterExpression("e", new ClassType(AlbumEntity));
    const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
    return { param, ctx };
}

describe("QueryToken — navigation", () => {
    test("the Entity column exposes id + the entity's fields", () => {
        const keys = entityToken().subTokens(O).map(t => t.key);
        assert.ok(keys.includes("id"));
        for (const f of ["name", "year", "author", "label", "state", "songs", "bonusTrack"])
            assert.ok(keys.includes(f), `missing sub-token ${f}`);
    });

    test("navigating a single-impl reference exposes its fields; polymorphic does not (yet)", () => {
        const label = entityToken().subToken("label", O)!;
        assert.ok(label);
        const labelKeys = label.subTokens(O).map(t => t.key);
        assert.ok(labelKeys.includes("name"));
        assert.ok(labelKeys.includes("country"));

        // author is @implementedBy [Artist, Band] → one AsType token per implementation (Phase 3).
        const author = entityToken().subToken("author", O)!;
        const asKeys = author.subTokens(O).map(t => t.key);
        assert.deepEqual(new Set(asKeys), new Set(["(Artist)", "(Band)"]));
    });

    test("fullKey chains the token path", () => {
        const name = entityToken().subToken("label", O)!.subToken("name", O)!;
        assert.equal(name.fullKey(), "Entity.label.name");
    });
});

describe("QueryToken — BuildExpression retarget", () => {
    test("value field → plain member access", () => {
        const { ctx } = contextFor();
        const year = entityToken().subToken("year", O)!;
        assert.equal(year.buildExpression(ctx).toString(), "e.year");
    });

    test("id → late-bound .id", () => {
        const { ctx } = contextFor();
        const id = entityToken().subToken("id", O)!;
        assert.equal(id.buildExpression(ctx).toString(), "e.id");
    });

    test("reference column projects a Lite (toLite)", () => {
        const { ctx } = contextFor();
        const label = entityToken().subToken("label", O)!;
        assert.equal(label.buildExpression(ctx).toString(), "e.label.toLite()");
    });

    test("navigating through a reference unwraps the toLite (clean member access)", () => {
        const { ctx } = contextFor();
        const name = entityToken().subToken("label", O)!.subToken("name", O)!;
        // ExtractEntity unwraps `e.label.toLite()` back to `e.label`, then `.name`.
        assert.equal(name.buildExpression(ctx).toString(), "e.label.name");
    });
});

describe("QueryToken — end-to-end bind to SQL", () => {
    // Offline schema + fake connector, mirroring binder.test.ts.
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = false;
    MusicLogic.start(sb);
    sb.complete();
    class FakeConnector extends Connector {
        constructor() { super(sb.schema, false, 128); }
        override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
        openConnection(): Promise<any> { throw new Error("not used"); }
        closeConnection(): Promise<void> { return Promise.resolve(); }
        cleanDatabase(): Promise<void> { return Promise.resolve(); }
    }
    const fake = new FakeConnector();

    // Bind `table(Album).map(e => <token>)` by hand (the retrieveByIdsProjection recipe).
    function bindToken(tokenPath: string[]): string {
        const q = table(AlbumEntity);
        const param = new ParameterExpression("e", new ClassType(AlbumEntity));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        let token = entityToken() as any;
        for (const step of tokenPath)
            token = token.subToken(step, O);
        const body = token.buildExpression(ctx);
        const lambda = new LambdaExpression([param], body);
        const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [lambda], new ArrayType(body.type));
        return Connector.withConnector(fake, () => {
            const proj = bindAndOptimize(mapCall, sb.schema, false, /* alreadySimplified */ true) as ProjectionExpression;
            assert.ok(proj instanceof ProjectionExpression);
            return QueryFormatter.format(proj.select, false).sql;
        });
    }

    test("Entity.year → SELECT of the year column off album", () => {
        const sql = bindToken(["year"]);
        assert.match(sql, /from\s+\w*\.?\[?album/i);
        assert.match(sql, /year/i);
    });

    test("Entity.label.Name → joins the label table and selects its name", () => {
        const sql = bindToken(["label", "name"]);
        assert.match(sql, /join\s+\w*\.?\[?label/i);
        assert.match(sql, /name/i);
    });
});
