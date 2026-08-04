import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { PgVectorSearch } from "@altea/altea/server/vectorSearch";
import { Vector } from "@altea/altea/data/vector";
import { hasDb, start } from "../setup";
import { NoteWithDateEntity } from "../../data/music";

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

    test("nearest-neighbour orders by distance (shape)", async () => {
        const q = new Vector([1, 0, 0]);
        // Ordering a table by the distance from its vector column to a query vector — the
        // nearest-neighbour shape (Signum's Vector_Search). Runs even with no seeded embeddings.
        const { SimplePassageEntity } = await import("../../data/music");
        const rows = await table(SimplePassageEntity)
            .orderBy(a => PgVectorSearch.distance("Cosine", a.embedding!, q))
            .map(a => a.chunk)
            .toArray();
        assert.ok(Array.isArray(rows));
    });
});
