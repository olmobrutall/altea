import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SymbolLogic } from "@altea/altea/logic/symbolLogic";
import { OperationSymbol } from "@altea/altea/entities/operations";
import { Replacements } from "@altea/altea/logic/sync/synchronizer";
import type { SqlPreCommand } from "@altea/altea/logic/sync/sqlPreCommand";
import "../entities/testOperations"; // declares the ArtistOperation.* symbols via init()

// Phase 2 — SymbolLogic. Offline (no DB): build a schema that includes OperationSymbol
// via SymbolLogic.start, then drive generation + the symbol sync step through a fake
// connector that returns canned rows (the binder.test.ts pattern).
class FakeConnector extends Connector {
    constructor(schema: any, public rows: unknown[] = [], isPostgres = false) { super(schema, isPostgres, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve(this.rows); }
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

describe("SymbolLogic", () => {
    test("assigns deterministic sorted-by-key ids and caches the symbols", () => {
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
