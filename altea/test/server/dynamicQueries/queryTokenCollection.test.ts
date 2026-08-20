import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table, bindAndOptimize } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { ProjectionExpression } from "@altea/altea/server/linq/expressions.sql";
import {
    ParameterExpression, LambdaExpression, CallExpression, PropertyExpression,
} from "@altea/altea/server/linq/expressions";
import { ClassType, ArrayType } from "@altea/altea/server/runtimeTypes";
import { Implementations } from "@altea/altea/data/implementations";
import { SubTokensOptions, SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { BuildExpressionContext, ExpressionBox } from "@altea/altea/server/dynamicQuery/tokenExpressions";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { DQueryable } from "@altea/altea/server/dynamicQuery/dQueryable";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { AlbumEntity } from "../../data/music";

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

    test("a collection exposes the CollectionToArray string-aggregation tokens", () => {
        const keys = tok("songs").subTokens(O).map((t: any) => t.key);
        for (const k of ["SeparatedByComma", "SeparatedByCommaDistinct", "SeparatedByNewLine", "SeparatedByNewLineDistinct"])
            assert.ok(keys.includes(k), `missing ToArray token ${k}`);
        // …and it navigates the element's properties (songs.SeparatedByComma.name).
        assert.ok(tok("songs.SeparatedByComma").subTokens(O).map((t: any) => t.key).includes("name"));
    });

    test("CollectionElementToken.buildExpression throws without expansion", () => {
        const { ctx } = withCtx();
        assert.throws(() => tok("songs.Element").buildExpression(ctx), /should have a replacement/);
    });
});

describe("aggregate sub-tokens (CanAggregate)", () => {
    // Regression: "group by this column" resolves the query root's "Count" token; without root
    // AggregateTokens it threw "Token with key 'Count' not found on query 'Album'".
    test("the query root exposes Count when CanAggregate is set", () => {
        const keys = entityToken().subTokens(O).map((t: any) => t.key);
        assert.ok(keys.includes("Count"), "root missing Count aggregate");
        const count = entityToken().subToken("Count", O);
        assert.ok(count?.isAggregate(), "Count should be an aggregate token");
        assert.equal(count!.fullKey(), "Count");
    });

    test("the query root omits Count when CanAggregate is NOT set", () => {
        const noAgg = O & ~SubTokensOptions.CanAggregate;
        const keys = entityToken().subTokens(noAgg).map((t: any) => t.key);
        assert.ok(!keys.includes("Count"), "root should not expose Count without CanAggregate");
    });

    test("a numeric value token exposes Sum/Average/Min/Max", () => {
        const keys = tok("year").subTokens(O).map((t: any) => t.key);
        for (const k of ["Sum", "Average", "Min", "Max"])
            assert.ok(keys.includes(k), `numeric token missing ${k}`);
    });

    // The QueryTokenBuilder chip shows toString() (Signum's `toStr`); the column header shows
    // niceName(). An aggregate's chip must be just the function ("Sum"), NOT "Sum of Year".
    test("Sum: toString() is 'Sum' (builder chip); niceName() is 'Sum of <parent>' (column header)", () => {
        const sum = tok("year").subToken("Sum", O);
        assert.equal(sum.toString(), "Sum");
        assert.equal(sum.niceName(), "Sum of Year");
    });

    test("root Count: both toString() and niceName() are 'Count'", () => {
        const count = entityToken().subToken("Count", O)!;
        assert.equal(count.toString(), "Count");
        assert.equal(count.niceName(), "Count");
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
            const dq = q.toDQueryable()
                .selectMany([elementToken as any])
                .select([nameToken]);
            return fmt(dq.bindProjection());
        });
        assert.match(sql, /song/);  // AlbumEntity_Song table
        assert.match(sql, /name/);
    });

    test("songs.SeparatedByComma.name → STRING_AGG of the song names over the album's songs", () => {
        const nameToArray = tok("songs.SeparatedByComma.name");
        const q = table(AlbumEntity);
        const sql = Connector.withConnector(fake, () => {
            const dq = q.toDQueryable().select([nameToArray]);
            return fmt(dq.bindProjection());
        });
        assert.match(sql, /string_agg/); // collapsed to one delimited-string cell
        assert.match(sql, /song/);
    });
});
