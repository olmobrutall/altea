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
import { QueryLogic } from "@altea/altea/logic/dynamicQuery/queryLogic"; // side-effect: wires the byAll provider
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../../logic/MusicLogic";
import { ArtistEntity, AlbumEntity, LabelEntity } from "../../entities/music";

// Phase-4 DynamicQuery port: QueryLogic core (query-name registry + the @implementedByAll token
// source). The byAll navigation needs the Schema, so those tests run inside a connector context.

const O = SubTokensOptionsAll;

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

function entityToken(ctor: Function): RootToken {
    return new RootToken(ctor);
}

describe("QueryLogic — query name registry", () => {
    test("register / getKey / toQueryName round-trip", () => {
        QueryLogic.registerQuery(AlbumEntity);
        QueryLogic.registerQuery("Custom.Report");
        assert.equal(QueryLogic.toQueryName("Album"), AlbumEntity);
        assert.equal(QueryLogic.toQueryName("Custom.Report"), "Custom.Report");
        assert.equal(QueryLogic.tryToQueryName("Nope"), undefined);
        assert.throws(() => QueryLogic.toQueryName("Nope"), /not found/);
    });

    test("isSystemVersioned / hasPartitionId", () => {
        assert.equal(QueryLogic.isSystemVersioned(AlbumEntity), false);
        assert.equal(QueryLogic.hasPartitionId(AlbumEntity), false);
    });
});

describe("QueryLogic — @implementedByAll sub-tokens", () => {
    test("getImplementedByAllTypes returns mapped entity types (Schema-backed)", () => {
        const names = Connector.withConnector(fake, () =>
            QueryLogic.getImplementedByAllTypes(LabelEntity).map(t => t.name));
        // Only LabelEntity is assignable to LabelEntity.
        assert.deepEqual(names, ["LabelEntity"]);
    });

    test("navigating an @implementedByAll reference yields an AsType token per mapped type", () => {
        // ArtistEntity.lastAward is `@implementedByAll Entity` → every mapped entity type.
        Connector.withConnector(fake, () => {
            const keys = entityToken(ArtistEntity).subToken("lastAward", O)!.subTokens(O).map(t => t.key);
            assert.ok(keys.includes("(Album)"));
            assert.ok(keys.includes("(Artist)"));
            assert.ok(keys.includes("(Label)"));
            assert.ok(keys.every(k => k.startsWith("(")), "all byAll sub-tokens are AsType casts");
        });
    });

    // (The graceful "no connector → []" path in getImplementedByAllTypes can't be tested reliably
    // under --test-isolation=none, since a sibling suite leaves Connector.default set.)

    test("byAll cast binds to SQL: lastAward.(Album).Name", () => {
        const q = table(ArtistEntity);
        const param = new ParameterExpression("e", new ClassType(ArtistEntity));
        const ctx = new BuildExpressionContext(param.type, param, new Map([["Entity", new ExpressionBox(param)]]));
        const sql = Connector.withConnector(fake, () => {
            const token = entityToken(ArtistEntity).subToken("lastAward", O)!.subToken("(Album)", O)!.subToken("name", O)!;
            const body = token.buildExpression(ctx);
            const lambda = new LambdaExpression([param], body);
            const mapCall = new CallExpression(new PropertyExpression(q.expression, "map"), [lambda], new ArrayType(body.type));
            const proj = bindAndOptimize(mapCall, sb.schema, false, true) as ProjectionExpression;
            assert.ok(proj instanceof ProjectionExpression);
            return (QueryFormatter.format(proj.select, false).sql + " ~~ " + String(proj.projector)).toLowerCase();
        });
        assert.match(sql, /album/);
        assert.match(sql, /name/);
    });
});
