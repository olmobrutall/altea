import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { SqlVectorSearch } from "@altea/altea/server/vectorSearch";
import { Vector } from "@altea/altea/data/vector";
import { hasDb, start } from "../setup";
import { NoteWithDateEntity } from "../../data/music";

// Port of Signum.Test/LinqProvider/VectorSearchTest.SqlServer.cs. C# → altea:
//   SqlVectorSearch.Vector_Distance(metric, v1, v2) → SqlVectorSearch.vectorDistance(metric, v1, v2)
//   SqlVectorSearch.Vector_Norm(v, normType)        → SqlVectorSearch.vectorNorm(v, normType)
//   SqlVectorSearch.Vector_Normalize(v, normType)   → SqlVectorSearch.vectorNormalize(v, normType)
// A constant Vector argument is cast to VECTOR(dim) (SQL Server rejects an untyped varchar and the
// cast needs an explicit dimension). SQL Server 2025-only (native VECTOR); skipped on Postgres.
const isPostgres = (process.env.ALTEA_TEST_DB ?? "").toLowerCase().startsWith("postgres");

describe("VectorSearchTest_SqlServer", { skip: !hasDb || isPostgres }, () => {
    before(async () => { await start(); });

    test("Vector_Distance", async () => {
        const v1 = new Vector([1, 0, 0]);
        const v2 = new Vector([0, 1, 0]);
        const cosine = await table(NoteWithDateEntity).map(n => SqlVectorSearch.vectorDistance("Cosine", v1, v2)).first();
        const euclidean = await table(NoteWithDateEntity).map(n => SqlVectorSearch.vectorDistance("Euclidean", v1, v2)).first();
        const dot = await table(NoteWithDateEntity).map(n => SqlVectorSearch.vectorDistance("DotProduct", v1, v2)).first();
        assert.ok(cosine > 0, "cosine distance of orthogonal vectors > 0");
        assert.ok(euclidean > 0, "euclidean distance of orthogonal vectors > 0");
        // The 'dot' distance of orthogonal vectors is 0 — but SQL Server may return -0, which
        // Object.is (assert.equal) rejects; compare within an epsilon (Signum's C# `== 0` accepts -0).
        assert.ok(Math.abs(dot) < 1e-4, `dot-product distance of orthogonal vectors ≈ 0 (got ${dot})`);
    });

    test("Vector_Norm", async () => {
        const v = new Vector([2, 3, 6]); // L2 norm = sqrt(4+9+36) = 7
        const norm = await table(NoteWithDateEntity).map(n => SqlVectorSearch.vectorNorm(v, "Norm2")).first();
        assert.ok(Math.abs(norm - 7) < 1e-4, `L2 norm ≈ 7 (got ${norm})`);
    });

    test("Vector_Normalize", async () => {
        const v = new Vector([2, 3, 6]);
        const normalizedText = await table(NoteWithDateEntity).map(n => SqlVectorSearch.vectorNormalize(v, "Norm2")).first();
        const normalized = Vector.parse(String(normalizedText));
        assert.equal(normalized.dimensions, 3);
        for (const a of normalized.values)
            assert.ok(a > 0 && a <= 1.0, `component ${a} in (0, 1]`);
    });
});
