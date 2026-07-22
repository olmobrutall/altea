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
import { BuildExpressionContext, ExpressionBox, SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/logic/dynamicQuery/tokens/rootToken";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity } from "../../entities/music";

// Phase-3d DynamicQuery port: collection sub-tokens (Count + CollectionElementToken) and the
// DQueryable-style expansion (flatMap) that seeds an element token's expression.

const O = SubTokensOptionsAll;

function entityToken(): RootToken {
    return new RootToken(AlbumEntity);
}
function tok(path: string) {
    let t: any = entityToken();
    for (const step of path.split("."))
        t = t.subToken(step, O);
    return t;
}

describe("collection sub-tokens", () => {
    test("a collection exposes Count + Element/Element2/Element3", () => {
        const keys = tok("songs").subTokens(O).map((t: any) => t.key);
        for (const k of ["Count", "Element", "Element2", "Element3"])
            assert.ok(keys.includes(k), `missing ${k}`);
    });

    test("the element exposes the element entity's own properties", () => {
        const keys = tok("songs.Element").subTokens(O).map((t: any) => t.key);
        assert.ok(keys.includes("name"));
        assert.ok(keys.includes("duration"));
        assert.ok(keys.includes("id"));
    });

    test("CollectionElementToken.buildExpression throws without expansion", () => {
        const { ctx } = withCtx();
        assert.throws(() => tok("songs.Element").buildExpression(ctx), /should have a replacement/);
    });
});

function withCtx() {
    const param = new ParameterExpression("e", new ClassType(AlbumEntity));
    return { param, ctx: new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]])) };
}

describe("collection tokens bind to SQL", () => {
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
    const fmt = (proj: ProjectionExpression) =>
        (QueryFormatter.format(proj.select, false).sql + " ~~ " + String(proj.projector)).toLowerCase();

    test("Count → col.count() (self-contained, no expansion)", () => {
        const { param, ctx } = withCtx();
        const body = tok("songs.Count").buildExpression(ctx);
        assert.match(body.toString(), /\.count\(\)/);
        const q = table(AlbumEntity);
        const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [new LambdaExpression([param], body)], new ArrayType(body.type));
        const sql = Connector.withConnector(fake, () => fmt(bindAndOptimize(mapCall, sb.schema, false, true) as ProjectionExpression));
        assert.match(sql, /count/);
    });

    test("songs.Element.Name → DQueryable.selectMany joins the songs table and reads name", () => {
        const elementToken = tok("songs.Element");
        const nameToken = tok("songs.Element.name");
        const q = table(AlbumEntity);

        const sql = Connector.withConnector(fake, () => {
            // The DQueryable pipeline: seed the Entity column, expand the collection, project the name.
            const dq = DQueryable.fromEntity(q.elementType, q.expression)
                .selectMany([elementToken as any])
                .select([nameToken]);
            return fmt(dq.bindProjection());
        });
        assert.match(sql, /song/);  // AlbumEntity_Songs table
        assert.match(sql, /name/);
    });
});
