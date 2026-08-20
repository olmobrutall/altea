import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { PgVectorSearch } from "@altea/altea/server/vectorSearch";
import { Vector } from "@altea/altea/data/vector";
import { hasDb, start, txTest } from "../setup";
import { NoteWithDateEntity, SimplePassageEntity } from "../../data/music";

// A 768-dim vector (the SimplePassage.embedding column width) whose leading components are `head`.
const pad768 = (head: number[]): Vector => new Vector([...head, ...Array(768 - head.length).fill(0)]);

// Port of Signum.Test/LinqProvider/VectorSearchTest.Postgres.cs (the data-free cases). C# → altea:
//   Database.Query<T>().Select(n => PgVectorSearch.Distance(metric, v1, v2).InSql()).First()
//     → table(T).map(n => PgVectorSearch.distance(metric, v1, v2)).first()   (__avoidEager replaces InSql)
//   new Vector(new float[]{…})  → new Vector([…])   PGVectorDistanceMetric.Cosine → "Cosine"
// Postgres-only (pgvector); skipped on SQL Server. Vector_Search (nearest-neighbour over loaded
// embeddings) is validated separately — altea-test doesn't seed SimplePassage embeddings.
const isPostgres = (process.env.ALTEA_TEST_DB ?? "").toLowerCase().startsWith("postgres");

describe("VectorSearchTest_Postgres", { skip: !hasDb || !isPostgres }, () => {
    before(async () => { await start(); });

    test("Distance", async () => {
        const v1 = new Vector([1, 0, 0]);
        const v2 = new Vector([0, 1, 0]);
        const cosine = await table(NoteWithDateEntity).map(n => PgVectorSearch.distance("Cosine", v1, v2)).first();
        const l2 = await table(NoteWithDateEntity).map(n => PgVectorSearch.distance("L2", v1, v2)).first();
        const innerProduct = await table(NoteWithDateEntity).map(n => PgVectorSearch.distance("InnerProduct", v1, v2)).first();
        assert.ok(cosine > 0, "cosine distance of orthogonal vectors > 0");
        assert.ok(l2 > 0, "L2 distance of orthogonal vectors > 0");
        assert.ok(Math.abs(innerProduct) < 1e-4, `inner product of orthogonal vectors ≈ 0 (got ${innerProduct})`);
    });

    test("Normalize", async () => {
        const v = new Vector([2, 3, 6]); // L2 norm 7 → [0.286, 0.429, 0.857]
        const normalizedText = await table(NoteWithDateEntity).map(n => PgVectorSearch.normalize(v)).first();
        const normalized = Vector.parse(String(normalizedText));
        assert.equal(normalized.dimensions, 3);
        for (const a of normalized.values)
            assert.ok(a > 0 && a <= 1.0, `component ${a} in (0, 1]`);
    });

    // Seeded nearest-neighbour search (Signum's Vector_Search) over controlled embeddings inserted in
    // a rolled-back transaction: order passages by cosine distance to a query vector and assert the
    // closest come first. Also checks that a vector column reads back as a Vector (materialization).
    txTest("Vector_Search orders by cosine distance + materialises the embedding", async () => {
        const note = (await table(NoteWithDateEntity).firstOrNull())!;
        const seed = async (chunk: string, head: number[]): Promise<void> => {
            await SimplePassageEntity.create({ note: note.toLite(), isTitle: false, chunk, embedding: pad768(head) }).save();
        };
        await seed("vt-A", [1, 0, 0]);        // identical to the query
        await seed("vt-C", [0.9, 0.1, 0]);    // close to the query
        await seed("vt-B", [0, 1, 0]);        // orthogonal to the query

        const q = pad768([1, 0, 0]);
        const ordered = await table(SimplePassageEntity)
            .orderBy(a => PgVectorSearch.distance("Cosine", a.embedding!, q))
            .map(a => a.chunk)
            .toArray();
        const mine = ordered.filter(ch => ch === "vt-A" || ch === "vt-B" || ch === "vt-C");
        assert.deepEqual(mine, ["vt-A", "vt-C", "vt-B"], "closest (identical) first, orthogonal last");

        // Read-path materialization: the vector column comes back as a Vector, not raw `[…]` text.
        const readA = await table(SimplePassageEntity).filter(a => a.chunk == "vt-A").map(a => a.embedding).firstOrNull();
        assert.ok(readA instanceof Vector, "embedding materialised as a Vector");
        assert.equal(readA.dimensions, 768);
        assert.equal(readA.values[0], 1);
    });
});
