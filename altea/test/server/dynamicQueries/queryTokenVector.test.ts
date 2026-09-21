import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { field } from "@altea/altea/data/reflection";
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { entity, column, vectorIndex } from "@altea/altea/data/decorators";
import { Vector } from "@altea/altea/data/vector";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { DQueryable } from "@altea/altea/server/dynamicQuery/dQueryable";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { FilterCondition, FilterGroup, FilterGroupOperationKeys, FilterOperationKeys } from "@altea/altea/server/dynamicQuery/requests";
import { SmartSearchLogic } from "@altea/altea/server/dynamicQuery/smartSearch";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { VectorDistanceToken } from "@altea/altea/data/dynamicQuery/tokens/vectorTokens";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { SimplePassageEntity } from "../../data/simplePassage";

// Signum's VectorColumnToken + VectorDistanceToken (the SERVER half of FilterOperation.SmartSearch) and
// the embedding seam its VectorDistanceToken calls. altea has no VectorColumnToken: `Distance` hangs off
// the vector PROPERTY's own token, and BOTH providers build a real distance expression.

const O = SubTokensOptionsAll;

@entity("Main", "Master")
// Metrics deliberately NOT the default on either dialect, so the expression is shown to read them.
@vectorIndex<VecProbeEntity>(a => a.indexed, { postgres: { metric: "L2" }, sqlServer: { metric: "Euclidean" } })
class VecProbeEntity extends Entity {
    @column({ pgDbType: "vector", sqlDbType: "vector", size: 3, nullable: true })
    indexed: Vector | null;
    // A vector column with NO @vectorIndex: filterable as a Vector, but there is no metric to measure by.
    @column({ pgDbType: "vector", sqlDbType: "vector", size: 3, nullable: true })
    unindexed: Vector | null;
}

@entity("Main", "Master")
@vectorIndex<BitVecProbeEntity>(a => a.bits, { postgres: { metric: "Hamming" } })
class BitVecProbeEntity extends Entity {
    @column({ pgDbType: "vector", sqlDbType: "vector", size: 3, nullable: true })
    bits: Vector | null;
}

function tokFrom(ctor: Type<BaseEntity>, path: string): any {
    let t: any = new RootToken(ctor);
    for (const step of path.split("."))
        t = t.subToken(step, O);
    return t;
}
const keysOf = (ctor: Type<BaseEntity>, path: string): string[] =>
    (tokFrom(ctor, path) as any).subTokens(O).map((t: any) => t.key);

function fakeConnectorFor(isPostgres: boolean): Connector {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    MusicLogic.start(sb);
    sb.include(VecProbeEntity);
    sb.include(BitVecProbeEntity);
    sb.complete();
    class FakeConnector extends Connector {
        constructor() { super(sb.schema, isPostgres, 128); }
        override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
        openConnection(): Promise<any> { throw new Error("not used"); }
        closeConnection(): Promise<void> { return Promise.resolve(); }
        cleanDatabase(): Promise<void> { return Promise.resolve(); }
    }
    return new FakeConnector();
}

// A query vector of the column's own dimension; the value only has to reach the SQL, never be meaningful.
const v3 = (): Vector => new Vector([1, 0, 0]);

describe("a Vector column is queryable at all", () => {
    test("its token's filterType is Vector — nothing produced that before", () => {
        assert.equal(tokFrom(SimplePassageEntity, "Embedding").filterType, "Vector");
        assert.equal(tokFrom(VecProbeEntity, "Unindexed").filterType, "Vector");
    });

    test("an INDEXED vector column offers Distance; an unindexed one offers nothing", () => {
        // (The Count-null / Count-not-null aggregates the base prepends for every filterable token are
        // there too, which is why this reads `includes` rather than an exact list.)
        assert.ok(keysOf(VecProbeEntity, "Indexed").includes("Distance"));
        assert.ok(!keysOf(VecProbeEntity, "Unindexed").includes("Distance"),
            "no @vectorIndex ⇒ no metric ⇒ no defensible distance (Signum mints its VectorColumnToken from the index too)");
        assert.ok(keysOf(SimplePassageEntity, "Embedding").includes("Distance"));
    });

    test("the Distance token's captions are localizable messages, and its format is Signum's", () => {
        const d = tokFrom(SimplePassageEntity, "Embedding.Distance") as VectorDistanceToken;
        assert.ok(d instanceof VectorDistanceToken);
        assert.equal(d.key, "Distance");
        assert.equal(d.toString(), "Distance");
        assert.equal(d.niceName(), "Distance for Embedding");
        assert.equal(d.format, "0.####");
        assert.equal(d.type.typeName, "Number");
        assert.equal(d.type.isNullable, true);
        // A computed score against THIS search: no route, no implementations (Signum returns null for both).
        assert.equal(d.getPropertyRoute(), undefined);
        assert.equal(d.getImplementations(), undefined);
    });

    test("a Vector names its own type in the token picker instead of showing blank", () => {
        assert.equal(tokFrom(SimplePassageEntity, "Embedding").niceTypeName(), "Vector");
    });

    // The path a STORED token string (a user query, a URL, the wire) actually takes.
    test("the token resolves from its string key, as the query routes resolve it", () => {
        const connector = fakeConnectorFor(true);
        Connector.withConnector(connector, () => {
            const t = QueryLogic.getToken(SimplePassageEntity, "Embedding.Distance", O);
            assert.ok(t instanceof VectorDistanceToken);
            assert.equal(t.fullKey(), "Embedding.Distance");
        });
    });
});

describe("SmartSearch → the Distance expression", () => {
    const tok = (ctor: Type<BaseEntity>, path: string) => tokFrom(ctor, path);

    function sqlFor(connector: Connector, ctor: Type<BaseEntity>, filters: any[], selectPath: string): string {
        return Connector.withConnector(connector, () => {
            const dq = (table(ctor as Type<any>).toDQueryable() as DQueryable)
                .where(filters)
                .select([tok(ctor, selectPath)]);
            return QueryFormatter.format(dq.bindProjection().select, connector.isPostgres).sql.toLowerCase();
        });
    }

    // The condition as the container hands it on: the prose already resolved to a Vector.
    function smartSearch(ctor: Type<BaseEntity>, path: string, vector: Vector): FilterCondition {
        const fc = new FilterCondition(tok(ctor, path), FilterOperationKeys.SmartSearch, "a question in prose");
        fc.resolvedVector = vector;
        return fc;
    }

    test("Postgres: the index's metric picks the pgvector distance function", () => {
        const sql = sqlFor(fakeConnectorFor(true), VecProbeEntity, [smartSearch(VecProbeEntity, "Indexed", v3())], "Indexed.Distance");
        assert.match(sql, /l2_distance\(/, "@vectorIndex declared postgres.metric = L2");
    });

    test("Postgres: no declared metric defaults to Cosine, as the index itself does", () => {
        const sql = sqlFor(fakeConnectorFor(true), SimplePassageEntity, [smartSearch(SimplePassageEntity, "Embedding", v3())], "Embedding.Distance");
        assert.match(sql, /cosine_distance\(/);
    });

    test("SQL Server: the same token becomes VECTOR_DISTANCE — Signum refuses this half on Postgres only", () => {
        const sql = sqlFor(fakeConnectorFor(false), VecProbeEntity, [smartSearch(VecProbeEntity, "Indexed", v3())], "Indexed.Distance");
        assert.match(sql, /vector_distance\(/);
        assert.match(sql, /'euclidean'/, "@vectorIndex declared sqlServer.metric = Euclidean");
    });

    test("a Vector value handed in directly needs no seam at all (Signum's second branch)", () => {
        for (const isPostgres of [true, false]) {
            const fc = new FilterCondition(tok(SimplePassageEntity, "Embedding"), FilterOperationKeys.SmartSearch, v3());
            const sql = sqlFor(fakeConnectorFor(isPostgres), SimplePassageEntity, [fc], "Embedding.Distance");
            assert.match(sql, isPostgres ? /cosine_distance\(/ : /vector_distance\(/);
        }
    });

    test("a SmartSearch inside a filter GROUP is found too", () => {
        const group = new FilterGroup(FilterGroupOperationKeys.Or, undefined, [smartSearch(SimplePassageEntity, "Embedding", v3())]);
        const sql = sqlFor(fakeConnectorFor(true), SimplePassageEntity, [group], "Embedding.Distance");
        assert.match(sql, /cosine_distance\(/);
    });

    test("no SmartSearch filter ⇒ a null constant, not a broken query (Signum's fallback)", () => {
        for (const isPostgres of [true, false]) {
            const sql = sqlFor(fakeConnectorFor(isPostgres), SimplePassageEntity, [], "Embedding.Distance");
            assert.doesNotMatch(sql, /cosine_distance\(|vector_distance\(/);
        }
    });

    test("a filter on a DIFFERENT vector column does not supply this one's query vector", () => {
        const sql = sqlFor(fakeConnectorFor(true), VecProbeEntity, [smartSearch(VecProbeEntity, "Unindexed", v3())], "Indexed.Distance");
        assert.doesNotMatch(sql, /l2_distance\(|cosine_distance\(/);
    });

    test("a bit metric is refused by name, never measured as cosine instead", () => {
        assert.throws(
            () => sqlFor(fakeConnectorFor(true), BitVecProbeEntity, [smartSearch(BitVecProbeEntity, "Bits", v3())], "Bits.Distance"),
            /Hamming[\s\S]*hamming_distance/);
    });

    // Signum's `Operation.IsSmartSearch() => Expression.Constant(true)`: the prose is the query VECTOR,
    // not a predicate. (Signum's SQL Server branch additionally rewrites the query into a VECTOR_SEARCH
    // table-valued-function join that keeps the 100 nearest rows; altea builds no TVF join — see
    // port/TranslationGaps.md.)
    test("the SmartSearch filter itself narrows nothing, on either provider", () => {
        for (const isPostgres of [true, false]) {
            const sql = sqlFor(fakeConnectorFor(isPostgres), SimplePassageEntity, [smartSearch(SimplePassageEntity, "Embedding", v3())], "Embedding");
            assert.doesNotMatch(sql, /\bwhere\b/, sql);
        }
    });
});

// NOTE: the seam is module-level state with no unregister (one process runs one application), so the
// UNCONFIGURED case has to be asserted before anything installs an implementation. vitest runs a file's
// tests in declaration order, and each file gets its own module registry.
describe("the embedding seam", () => {
    const tokenFor = () => tokFrom(SimplePassageEntity, "Embedding");

    test("with no implementation registered it THROWS, naming the seam and who installs it", async () => {
        assert.equal(SmartSearchLogic.isConfigured(), false);
        await assert.rejects(
            () => SmartSearchLogic.getEmbedding(tokenFor(), "prose"),
            /altea-agent[\s\S]*registerGetEmbedding/);
        // …and the same through the pass the container runs, so a misconfiguration surfaces at the query.
        await assert.rejects(
            () => SmartSearchLogic.resolveEmbeddings([new FilterCondition(tokenFor(), FilterOperationKeys.SmartSearch, "prose")]),
            /needs an embeddings provider/);
    });

    test("resolveEmbeddings turns the prose into a vector, leaving the prose itself intact", async () => {
        const seen: string[] = [];
        SmartSearchLogic.registerGetEmbedding(async (_token, text) => { seen.push(text); return new Vector([1, 2, 3]); });
        assert.equal(SmartSearchLogic.isConfigured(), true);

        const fc = new FilterCondition(tokenFor(), FilterOperationKeys.SmartSearch, "quiet acoustic songs");
        const group = new FilterGroup(FilterGroupOperationKeys.And, undefined, [
            new FilterCondition(tokenFor(), FilterOperationKeys.SmartSearch, "loud ones"),
        ]);
        await SmartSearchLogic.resolveEmbeddings([fc, group]);

        assert.deepEqual(seen, ["quiet acoustic songs", "loud ones"], "every condition, groups included");
        assert.deepEqual(fc.resolvedVector?.values, [1, 2, 3]);
        assert.equal(fc.value, "quiet acoustic songs", "the prose survives for the keyword / log passes");
        assert.deepEqual(fc.vectorFor(tokenFor())?.values, [1, 2, 3]);
    });

    test("a non-SmartSearch filter, and an empty search, never reach the seam", async () => {
        let calls = 0;
        SmartSearchLogic.registerGetEmbedding(async () => { calls++; return new Vector([0]); });
        await SmartSearchLogic.resolveEmbeddings([
            new FilterCondition(tokenFor(), FilterOperationKeys.EqualTo, "x"),
            new FilterCondition(tokenFor(), FilterOperationKeys.SmartSearch, ""),
        ]);
        assert.equal(calls, 0);
    });

    test("an already-resolved condition is not resolved twice", async () => {
        let calls = 0;
        SmartSearchLogic.registerGetEmbedding(async () => { calls++; return new Vector([9]); });
        const fc = new FilterCondition(tokenFor(), FilterOperationKeys.SmartSearch, "prose");
        fc.resolvedVector = new Vector([1]);
        await SmartSearchLogic.resolveEmbeddings([fc]);
        assert.equal(calls, 0);
        assert.deepEqual(fc.resolvedVector.values, [1]);
    });
});
