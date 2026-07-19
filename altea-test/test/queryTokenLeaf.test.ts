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
import { ClassType, ArrayType, LiteralType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { ColumnDescription } from "@altea/altea/logic/dynamicQuery/queryDescription";
import { BuildExpressionContext, ExpressionBox, SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { ColumnToken } from "@altea/altea/logic/dynamicQuery/tokens/columnToken";
import "@altea/altea/logic/dynamicQuery/tokens/factories"; // registers token factories
import { MusicLogic } from "../logic/MusicLogic";
import { AlbumEntity } from "../entities/music";

// Phase-3a DynamicQuery port: leaf tokens (HasValue, EntityToString, NetPropertyToken/StringTokens,
// AsType). Extends Phase 2's ColumnToken + EntityPropertyToken navigation.

const O = SubTokensOptionsAll;

function entityToken(): ColumnToken {
    const col = new ColumnDescription("Entity", new ClassType(AlbumEntity), "Album");
    col.implementations = Implementations.by(AlbumEntity);
    return new ColumnToken(col, AlbumEntity);
}
function contextFor() {
    const param = new ParameterExpression("e", new ClassType(AlbumEntity));
    const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
    return { param, ctx };
}
// Navigate a dotted token path from the Entity column.
function tok(path: string) {
    let t: any = entityToken();
    for (const step of path.split("."))
        t = t.subToken(step, O);
    return t;
}

describe("leaf sub-tokens exist where Signum puts them", () => {
    test("string field → Length + HasValue", () => {
        const keys = tok("name").subTokens(O).map((t: any) => t.key);
        assert.ok(keys.includes("length"));
        assert.ok(keys.includes("HasValue"));
    });

    test("entity → ToString + HasValue alongside id/fields", () => {
        const keys = entityToken().subTokens(O).map(t => t.key);
        assert.ok(keys.includes("ToString"));
        assert.ok(keys.includes("HasValue"));
        assert.ok(keys.includes("id"));
    });

    test("polymorphic reference → one AsType token per implementation", () => {
        const keys = tok("author").subTokens(O).map((t: any) => t.key);
        assert.deepEqual(new Set(keys), new Set(["(Artist)", "(Band)"]));
    });
});

describe("leaf BuildExpression retarget", () => {
    test("String.Length → .length", () => {
        const { ctx } = contextFor();
        assert.equal(tok("name.length").buildExpression(ctx).toString(), "e.name.length");
    });

    test("HasValue on a value → != null", () => {
        const { ctx } = contextFor();
        assert.equal(tok("name.HasValue").buildExpression(ctx).toString(), "((e.name != null) && (e.name != ))");
    });

    test("entity ToString → .toString()", () => {
        const { ctx } = contextFor();
        assert.equal(tok("label.ToString").buildExpression(ctx).toString(), "e.label.toString()");
    });

    test("AsType → cast + toLite; navigating a member unwraps the cast", () => {
        const { ctx } = contextFor();
        // author is a polymorphic (@implementedBy) reference; (Artist) casts it.
        assert.equal(tok("author.(Artist)").buildExpression(ctx).toString(), "((e.author as ClassType)).toLite()");
        assert.equal(tok("author.(Artist).name").buildExpression(ctx).toString(), "((e.author as ClassType)).name");
    });
});

describe("leaf tokens bind to SQL end-to-end", () => {
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

    function bindToken(path: string): string {
        const q = table(AlbumEntity);
        const param = new ParameterExpression("e", new ClassType(AlbumEntity));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        let token: any = entityToken();
        for (const step of path.split("."))
            token = token.subToken(step, O);
        const body = token.buildExpression(ctx);
        const lambda = new LambdaExpression([param], body);
        const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [lambda], new ArrayType(body.type));
        return Connector.withConnector(fake, () => {
            const proj = bindAndOptimize(mapCall, sb.schema, false, true) as ProjectionExpression;
            assert.ok(proj instanceof ProjectionExpression);
            return QueryFormatter.format(proj.select, false).sql;
        });
    }

    test("Entity.name.Length binds to a length function over the name column", () => {
        const sql = bindToken("name.length").toLowerCase();
        assert.match(sql, /len\(|length\(/); // LEN (SQL Server) / LENGTH
        assert.match(sql, /name/);
    });

    test("Entity.author.(Artist).Name casts the polymorphic reference and reads Artist.name", () => {
        const sql = bindToken("author.(Artist).name").toLowerCase();
        assert.match(sql, /artist/);
        assert.match(sql, /name/);
    });
});
