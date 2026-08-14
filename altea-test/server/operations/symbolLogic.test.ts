import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { Connector } from "@altea/altea/server/connection/connector";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { OperationSymbol } from "@altea/altea/data/operations";
import { declaredSymbolsForType } from "@altea/altea/data/registration";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import type { SqlPreCommand } from "@altea/altea/server/sync/sqlPreCommand";
import "../../data/music"; // declares the ArtistOperation.* symbols via init()

// Phase 2 — SymbolLogic. Offline (no DB): build a schema that includes OperationSymbol
// via SymbolLogic.start, then drive generation + the symbol sync step through a fake
// connector that returns canned rows (the binder.test.ts pattern).
//
// The ids are DB-assigned (identity PK) and read back by SymbolLogic.load — so the
// synchronous readers (symbols/toSymbol/…) need the cache WARMED first. Offline, we warm
// it from canned rows keyed by (pk, key): the fake answers the existsTable probe with a
// non-null row so load() proceeds, then returns the canned symbol rows for the read-back
// SELECT. Every other query (retrieveRows during sync) also gets the canned rows.
class FakeConnector extends Connector {
    constructor(schema: any, public rows: unknown[] = [], isPostgres = false) { super(schema, isPostgres, 128); }
    override executeQuery(sql?: string): Promise<unknown[]> {
        // existsTable's probe (`SELECT OBJECT_ID(...) AS r` / `to_regclass(...) AS r`) — answer
        // "the table exists" so load()/sync read the canned rows instead of bailing on a missing table.
        if (sql && /OBJECT_ID|to_regclass/i.test(sql))
            return Promise.resolve([{ r: 1 }]);
        return Promise.resolve(this.rows);
    }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
// Capture the sync step SymbolLogic.start pushes, so it can be driven in isolation
// (calling the whole synchronizationScript would also run the catalog reader, which
// would misread our canned symbol rows).
const syncBefore = sb.schema.synchronizing.length;
SymbolLogic.start(sb, OperationSymbol);
const symbolSync = sb.schema.synchronizing[syncBefore];
sb.complete();

const table = sb.schema.table(OperationSymbol);
const pkCol = table.primaryKey.column.name;
const keyCol = table.fields["key"].field.columns()[0].name;

function withFake<T>(rows: unknown[], fn: () => T): T {
    return Connector.withConnector(new FakeConnector(sb.schema, rows, false), fn);
}
function noPromptReplacements(): Replacements {
    const r = new Replacements();
    r.interactive = false; // a needed rename throws instead of prompting
    return r;
}

// Canned persisted rows: one per declared symbol, ids assigned in sorted-by-key order (the
// order generation seeds them, so a fresh DB's identity ids come out this way). Warming
// SymbolLogic.load from these mirrors reading the ids back after generation. Computed inside
// `before` (not at module top-level): with --test-isolation=none other test files load into the
// same process and declare more OperationSymbols, so the full declared set is only settled once
// every file's top-level has run — i.e. by the time this hook fires, not at this module's eval.
describe("SymbolLogic", () => {
    // Warm the read-back cache once (identity ids read back from the "DB"). The synchronous
    // readers below then hit the warm box, exactly as they do in production after schema.initialize().
    before(() => {
        const seededRows = [...declaredSymbolsForType(OperationSymbol)]
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .map((s, i) => ({ [pkCol]: i + 1, [keyCol]: s.key }));
        return withFake(seededRows, () => SymbolLogic.load(OperationSymbol));
    });

    test("reads back sorted-by-key ids from the DB and caches the symbols", () => {
        const create = SymbolLogic.toSymbol(OperationSymbol, "ArtistOperation.Create");
        const del = SymbolLogic.toSymbol(OperationSymbol, "ArtistOperation.Delete");
        const save = SymbolLogic.toSymbol(OperationSymbol, "ArtistOperation.Save");

        // ids are positive and follow the alphabetical key order (Create < Delete < Save),
        // robust to any other Operation symbols another suite might declare.
        assert.ok((create.id as number) > 0);
        assert.ok((create.id as number) < (del.id as number));
        assert.ok((del.id as number) < (save.id as number));
        assert.equal(save.isNew, false);

        const keys = SymbolLogic.allUniqueKeys(OperationSymbol);
        assert.ok(keys.has("ArtistOperation.Create"));
        assert.ok(keys.has("ArtistOperation.Delete"));
        assert.ok(keys.has("ArtistOperation.Save"));
        assert.ok(SymbolLogic.symbols(OperationSymbol).length >= 3);
    });

    test("toSymbol throws for an unknown key", () => {
        assert.throws(() => SymbolLogic.toSymbol(OperationSymbol, "ArtistOperation.Nope"), /not registered/);
    });

    test("generation seeds one INSERT per declared symbol", () => {
        const cmd = withFake([], () => sb.schema.generationScript())!;
        // Seeded through the sync saver (parameterized), so the keys ride in each INSERT's
        // parameters — assert one INSERT per symbol and that the keys are the seeded values.
        const inserts = cmd.leaves().filter(l => /INSERT INTO/i.test(l.sql) && /OperationSymbol/i.test(l.sql));
        assert.ok(inserts.length >= 3, `expected an INSERT per symbol, got ${inserts.length}`);
        const seeded = inserts.flatMap(l => l.paramValues() ?? []);
        assert.ok(seeded.includes("ArtistOperation.Save"));
        assert.ok(seeded.includes("ArtistOperation.Create"));
        assert.ok(seeded.includes("ArtistOperation.Delete"));
    });

    test("sync against an empty DB inserts every symbol", async () => {
        const cmd = await withFake([], () => symbolSync(noPromptReplacements())) as SqlPreCommand | undefined;
        assert.ok(cmd != null, "expected inserts for a fresh symbol table");
        // The sync uses the parameterized insertSqlSync (one INSERT per row), so the key
        // literals ride in parameters, not the SQL text — assert one INSERT per symbol.
        const inserts = cmd!.plainSql().match(/INSERT/gi) ?? [];
        assert.ok(inserts.length >= 3, `expected an INSERT per declared symbol, got ${inserts.length}`);
    });

    test("sync against a matching DB is a no-op", async () => {
        const current = SymbolLogic.symbols(OperationSymbol).map(s => ({ [pkCol]: s.id, [keyCol]: s.key }));
        const cmd = await withFake(current, () => symbolSync(noPromptReplacements())) as SqlPreCommand | undefined;
        assert.equal(cmd, undefined, "a DB that already matches needs no migration");
    });

    test("sync deletes a symbol present in the DB but no longer declared", async () => {
        const current = [
            ...SymbolLogic.symbols(OperationSymbol).map(s => ({ [pkCol]: s.id, [keyCol]: s.key })),
            { [pkCol]: 999, [keyCol]: "ArtistOperation.Removed" },
        ];
        const cmd = await withFake(current, () => symbolSync(noPromptReplacements())) as SqlPreCommand | undefined;
        assert.ok(cmd != null, "expected a delete for the stale row");
        assert.match(cmd!.plainSql(), /DELETE/i);
    });
});
