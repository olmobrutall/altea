import { test, beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { Vector } from "@altea/altea/data/vector";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SmartSearchLogic } from "@altea/altea/server/dynamicQuery/smartSearch";
import {
    Column, FilterCondition, FilterOperationKeys, Order, OrderTypeKeys, QueryRequest,
} from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { hasDb, start, txTest } from "../setup";
import { NoteWithDateEntity, SimplePassageEntity } from "../../data/music";
import { table } from "@altea/altea/server/table";

// The SERVER half of FilterOperation.SmartSearch, end to end through the dynamic query: prose →
// embedding (the SmartSearchLogic seam) → the dialect's distance expression → rows ordered by it.
// Runs on BOTH providers — Signum gates its SmartSearch rewrite to SQL Server, altea builds the inline
// distance on either (see port/TranslationGaps.md).

const O = SubTokensOptionsAll;
const pad768 = (head: number[]): Vector => new Vector([...head, ...Array(768 - head.length).fill(0)]);

describe.skipIf(!hasDb)("SmartSearch (dynamic query)", () => {
    beforeAll(async () => {
        await start();
        // Stand in for @altea/altea-agent's LanguageModelLogic: the words the test searches by map to
        // the same embeddings it seeds, so the expected ORDER is known without calling a real model.
        SmartSearchLogic.registerGetEmbedding(async (_token, text) =>
            text === "like A" ? pad768([1, 0, 0]) : pad768([0, 1, 0]));
    });

    const embedding = () => QueryLogic.getRootToken(SimplePassageEntity).subToken("embedding", O)!;
    const distance = () => embedding().subToken("Distance", O)!;
    const chunk = () => QueryLogic.getRootToken(SimplePassageEntity).subToken("chunk", O)!;

    async function seedThree(): Promise<void> {
        const note = (await table(NoteWithDateEntity).firstOrNull())!;
        const seed = async (ch: string, head: number[]): Promise<void> => {
            await SimplePassageEntity.create({ note: note.toLite(), isTitle: false, chunk: ch, embedding: pad768(head) }).save();
        };
        await seed("ss-A", [1, 0, 0]);
        await seed("ss-C", [0.9, 0.1, 0]);
        await seed("ss-B", [0, 1, 0]);
    }

    /** The `chunk` column of every row this test seeded, in the order the request returned them. */
    function seededChunks(rt: { columns: { values: unknown[] }[] }, slot: number): string[] {
        return rt.columns[slot].values.map(v => String(v)).filter(c => c.startsWith("ss-"));
    }

    txTest("prose becomes an embedding and orders the rows by similarity", async () => {
        await seedThree();

        const request = new QueryRequest(
            SimplePassageEntity,
            [new FilterCondition(embedding(), FilterOperationKeys.SmartSearch, "like A")],
            [new Order(distance(), OrderTypeKeys.Ascending)],
            [new Column(chunk()), new Column(distance())]);

        const rt = await QueryLogic.queries.executeQueryAsync(request);
        // The implicit row-entity column is split out as ResultTable.entityColumn, so the requested
        // columns keep their own positions: chunk, then Distance.
        assert.deepEqual(seededChunks(rt as any, 0), ["ss-A", "ss-C", "ss-B"], "closest first, orthogonal last");

        // The Distance column really is a number, and the identical vector scores ~0.
        const distances = (rt as any).columns[1].values as number[];
        assert.ok(distances.every(d => d == null || typeof d === "number"));
        assert.ok(Math.abs(Number(distances[0])) < 1e-4, `the identical embedding is at distance ≈ 0 (got ${distances[0]})`);
    });

    txTest("a different question ranks a different row first", async () => {
        await seedThree();
        const request = new QueryRequest(
            SimplePassageEntity,
            [new FilterCondition(embedding(), FilterOperationKeys.SmartSearch, "like B")],
            [new Order(distance(), OrderTypeKeys.Ascending)],
            [new Column(chunk()), new Column(distance())]);

        const rt = await QueryLogic.queries.executeQueryAsync(request);
        assert.equal(seededChunks(rt as any, 0)[0], "ss-B");
    });

    txTest("the SmartSearch filter narrows NOTHING — every row is still returned", async () => {
        await seedThree();
        const withFilter = new QueryRequest(
            SimplePassageEntity,
            [new FilterCondition(embedding(), FilterOperationKeys.SmartSearch, "like A")],
            [], [new Column(chunk())]);
        const withoutFilter = new QueryRequest(SimplePassageEntity, [], [], [new Column(chunk())]);

        const a = await QueryLogic.queries.executeQueryAsync(withFilter);
        const b = await QueryLogic.queries.executeQueryAsync(withoutFilter);
        assert.equal((a as any).rows.length, (b as any).rows.length);
    });

    test("a Distance column with no SmartSearch filter selects null, not a broken query", async () => {
        const request = new QueryRequest(SimplePassageEntity, [], [], [new Column(distance())]);
        const rt = await QueryLogic.queries.executeQueryAsync(request);
        assert.ok((rt as any).columns[0].values.every((v: unknown) => v == null));
    });
});
