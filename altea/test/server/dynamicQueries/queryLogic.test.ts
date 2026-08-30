import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import type { BaseEntity, Type } from "@altea/altea/data/entity";
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
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic"; // side-effect: wires the byAll provider
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { seedTypeCachesForTest } from "../seedTypeCaches";
import { MusicLogic } from "../MusicLogic";
import { ArtistEntity, AlbumEntity, LabelEntity } from "../../data/music";

// Phase-4 DynamicQuery port: QueryLogic core (query-name registry + the @implementedByAll token
// source). The byAll navigation needs the Schema, so those tests run inside a connector context.

const O = SubTokensOptionsAll;

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();
seedTypeCachesForTest(sb.schema); // offline: deterministic type↔id cache for @implementedByAll binding
class FakeConnector extends Connector {
    constructor() { super(sb.schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const fake = new FakeConnector();

function entityToken(ctor: Type<BaseEntity>): RootToken {
    return new RootToken(ctor);
}

describe("QueryLogic — query name registry", () => {
    // There is ONE registry — the query container. A key resolves back to the TYPE it was registered
    // under (QueryName is Type<BaseEntity>), and a key nothing registered resolves to nothing. There
    // used to be a second, write-only `registerQuery` map beside it that nothing in the framework fed.
    test("register / getKey / toQueryName round-trip", () => {
        assert.equal(QueryLogic.toQueryName("Album"), AlbumEntity);
        assert.equal(QueryLogic.tryToQueryName("Album"), AlbumEntity);
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
            // Enumerate without CanAggregate so the reference exposes only its per-mapped-type AsType
            // casts (not the group-aggregate Count-null / Count-distinct tokens it gets under CanAggregate).
            const noAgg = O & ~SubTokensOptions.CanAggregate;
            const keys = entityToken(ArtistEntity).subToken("lastAward", noAgg)!.subTokens(noAgg).map(t => t.key);
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
