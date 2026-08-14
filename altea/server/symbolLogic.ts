import type { Entity, PrimaryKey, Type } from "../data/entity";
import { Symbol } from "../data/symbol";
import { declaredSymbolsForType } from "../data/registration";
import { ResetLazy } from "../data/resetLazy";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import type { Schema } from "./schema/schema";
import type { Table } from "./schema/table";
import { Connector } from "./connection/connector";
import { SqlPreCommand, Spacing } from "./sync/sqlPreCommand";
import { Synchronizer, Replacements } from "./sync/synchronizer";
import { insertSqlSyncGenerated, updateSqlSync, deleteSqlSync, rowImage } from "./save";
import { existsTable, readObjectName } from "./sync/syncTableRead";
import type { ObjectName } from "./schema/objectName";

// Port of Signum's SymbolLogic<T> (Signum/Basics/SymbolLogic.cs).
//
// TS has no generic static classes, so Signum's `static class SymbolLogic<T>` — whose static fields hold
// one cache per closed T — becomes a `SymbolLogic` namespace whose per-T state lives in a Map keyed by the
// concrete Symbol constructor, and whose methods are generic functions taking that ctor as their first arg.
//
// Faithful to Signum: the ids are DB-assigned (IDENTITY PK) and READ BACK, exactly as TypeLogic does for
// TypeEntity — NOT assigned deterministically in memory. Each concrete symbol table's `key → symbol` cache
// lives behind a `ResetLazy`: generation seeds the declared symbols WITHOUT ids (the DB assigns them),
// `load()` reads them back and STAMPS the id onto the shared `init()` instances, and the sync keeps the
// persisted id for a matched key (so a member added/removed never re-ids the survivors — a positional
// scheme would drift and corrupt every stored FK to the symbol). The read methods are SYNCHRONOUS (symbols
// are read all over the auth/operation hot path), so they read the WARMED box or throw — production warms
// it in `schema.initialize()` (the `initializing` hook below), like TypeLogic. The read runs in
// ExecutionMode.global so the type-read gate (altea-auth) never fires on the symbol-table query.
//
// Signum bits intentionally deferred: the `Saved` guard (forbid saving a symbol) and `Retrieved`/FieldInfo
// attachment need entity events altea does not have yet.

interface SymbolTypeLogic {
    ctor: Type<Symbol>;
    getSymbols: () => Symbol[];
    // Signum's `lazy` cache: key -> symbol (its id read back from the DB). Behind a ResetLazy, loaded from
    // the persisted rows (or empty before generation), reset + reloaded by `load()` after gen/sync.
    lazy: ResetLazy<Map<string, Symbol>>;
}

// One entry per concrete Symbol type — the analogue of Signum's per-closed-T static fields. Module-global
// (like Signum's statics), keyed by the symbol constructor. The `lazy` reads the ACTIVE connector's DB;
// the shared symbol instances are process-global, so a single entry per ctor serves the process (as the
// deterministic scheme did — and a single DB per process is the norm; the offline dialect tests seed
// consistently).
const byCtor = new Map<Function, SymbolTypeLogic>();

// Per-schema idempotency (Signum's per-schema AlreadyDefined): altea builds several schemas per process
// (e.g. one per dialect in the offline tests), each of which must still include the table and push its own
// generate/sync/initialize steps — so the guard is keyed by schema, NOT globally by ctor.
const startedBySchema = new WeakMap<Schema, Set<Function>>();

// True WHILE a symbol lazy is loading (its `table(ctor)` read is in flight) — a guard for any re-entrant
// symbol lookup (there is none today: reading a symbol table needs no symbol id), mirroring TypeLogic.isLoading.
let loading = false;

export namespace SymbolLogic {
    export function isLoading(): boolean { return loading; }

    // Signum's SymbolLogic<T>.Start. Includes the concrete symbol table, installs the read-back ResetLazy,
    // and registers the generate + sync + initialize steps. Idempotent per schema. `getSymbols` defaults to
    // every declared symbol of this type (Signum passes a narrower set, e.g. OperationLogic.RegisteredOperations).
    export function start<T extends Symbol>(
        sb: SchemaBuilder,
        ctor: Type<T>,
        getSymbols: () => T[] = () => declaredSymbolsForType(ctor) as unknown as T[],
    ): void {
        let started = startedBySchema.get(sb.schema);
        if (started == null)
            startedBySchema.set(sb.schema, started = new Set());
        if (started.has(ctor))
            return;
        started.add(ctor);

        sb.include(ctor);

        if (!byCtor.has(ctor)) {
            const stl: SymbolTypeLogic = {
                ctor,
                getSymbols: getSymbols as () => Symbol[],
                lazy: new ResetLazy<Map<string, Symbol>>(() => buildCache(ctor)),
            };
            byCtor.set(ctor, stl);
        }

        sb.schema.generating.push(schema => seedSymbols(schema, ctor));
        sb.schema.synchronizing.push(replacements => synchronizeSymbols(replacements, ctor));
        // Signum's Schema.Initializing → lazy.Load: read the persisted ids back after the connector is
        // bound and the table exists (server startup, and after gen/sync). Tolerant of a not-yet-created
        // table (buildCache returns empty). Runs after TypeLogic.load (symbols are pushed after types).
        sb.schema.initializing.push(() => load(ctor));
    }

    // Warm/reload a ctor's cache from the DB (Signum's lazy.Load): reset + resolve. Call after generation /
    // synchronization mutate the table. An async boundary — subsequent SYNCHRONOUS `symbols`/`toSymbol`
    // reads then hit the warm box.
    export async function load<T extends Symbol>(ctor: Type<T>): Promise<void> {
        const stl = byCtor.get(ctor);
        if (stl == null) return;
        stl.lazy.reset();
        await stl.lazy.value();
    }

    export async function ready<T extends Symbol>(ctor: Type<T>): Promise<void> {
        await byCtor.get(ctor)?.lazy.value();
    }

    // Signum's SymbolLogic<T>.Symbols / TryToSymbol / ToSymbol / AllUniqueKeys — SYNCHRONOUS readers of the
    // WARMED cache (like TypeLogic's typeToId). Throw if the load hasn't run yet (production warms it in
    // schema.initialize()); no deterministic id is ever fabricated.
    export function symbols<T extends Symbol>(ctor: Type<T>): T[] {
        return [...cache(ctor).values()] as T[];
    }
    export function tryToSymbol<T extends Symbol>(ctor: Type<T>, key: string): T | undefined {
        return cache(ctor).get(key) as T | undefined;
    }
    export function toSymbol<T extends Symbol>(ctor: Type<T>, key: string): T {
        const s = cache(ctor).get(key);
        if (s == null)
            throw new Error(`Symbol '${key}' is not registered for ${ctor.name}.`);
        return s as T;
    }
    export function allUniqueKeys<T extends Symbol>(ctor: Type<T>): Set<string> {
        return new Set(cache(ctor).keys());
    }
}

function assertStarted(ctor: Function): SymbolTypeLogic {
    const stl = byCtor.get(ctor);
    if (stl == null)
        throw new Error(`SymbolLogic has not been started for ${ctor.name}. Call SymbolLogic.start(sb, ${ctor.name}) first.`);
    return stl;
}

// The warmed key→symbol cache, or THROW (Signum's lazy.Value; TypeLogic.caches does the same). Never
// fabricates ids — the async load (schema.initialize()'s SymbolLogic.load) must have completed.
function cache(ctor: Function): Map<string, Symbol> {
    const stl = assertStarted(ctor);
    const c = stl.lazy.valueOrUndefined;
    if (c == null)
        throw new Error(`SymbolLogic cache for ${ctor.name} is not loaded — symbol id resolution needs the async load (SymbolLogic.load(${ctor.name}), run by schema.initialize()) to have completed.`);
    return c;
}

// The ResetLazy factory (Signum's lazy factory): read the persisted rows and STAMP each id onto the shared
// declared symbol instance (matched by key). A DB row whose key is no longer declared is skipped (relaxed
// join); a declared symbol with no row yet has no id until the next sync inserts it and load() re-reads.
// EMPTY before generation. Runs in ExecutionMode.global so altea-auth's type-read gate never fires on the
// symbol-table read.
async function buildCache(ctor: Type<Symbol>): Promise<Map<string, Symbol>> {
    loading = true;
    try {
        const byKey = new Map<string, Symbol>();
        const declared = new Map(byCtor.get(ctor)!.getSymbols().map(s => [s.key, s]));
        for (const { key, id } of await readSymbolRows(ctor)) {
            const sym = declared.get(key);
            if (sym == null)
                continue; // a persisted symbol no longer declared — skip (Signum's relaxed join)
            (sym as { id: PrimaryKey }).id = id;
            sym.isNew = false;
            byKey.set(key, sym);
        }
        return byKey;
    } finally {
        loading = false;
    }
}

// Read (id, key) for every persisted row via a RAW SELECT (not the ORM) — no projector/type-cache
// dependency, and it bypasses the Retriever, so altea-auth's type-read gate never fires on this internal
// read. EMPTY when the table doesn't exist yet (fresh DB before generation, or an offline / fake connector):
// generation seeds from the declared set (not the cache), and a later load() fills the ids once populated.
async function readSymbolRows(ctor: Type<Symbol>): Promise<{ key: string; id: PrimaryKey }[]> {
    const connector = Connector.current();
    const table = connector.schema.tryTable(ctor);
    if (table == null)
        return [];
    let exists = false;
    try { exists = await existsTable(table.name); } catch { return []; }
    if (!exists)
        return [];
    const sqlBuilder = connector.sqlBuilder;
    const keyCol = table.fields["key"].field.columns()[0].name;
    const pkCol = table.primaryKey.column.name;
    const rows = await connector.executeQuery(
        `SELECT ${sqlBuilder.sqlEscape(pkCol)}, ${sqlBuilder.sqlEscape(keyCol)} FROM ${sqlBuilder.objectName(table.name)}`,
    ) as Record<string, unknown>[];
    return rows.map(r => ({ key: String(r[keyCol]), id: r[pkCol] as PrimaryKey }));
}

// Generation (Signum's SymbolLogic<T>.Schema_Generating): INSERT one row per DECLARED symbol WITHOUT an id
// (the IDENTITY PK is DB-assigned — insertSqlSyncGenerated omits it), in a deterministic sorted-by-key
// order so the DB-assigned ids are reproducible across a fresh generate. Per-row statements (not one
// multi-row VALUES) so the identity ids increment in that order (as TypeLogic seeds TypeEntity).
function seedSymbols(schema: Schema, ctor: Type<Symbol>): SqlPreCommand | undefined {
    const stl = byCtor.get(ctor);
    const table = schema.tryTable(ctor);
    if (stl == null || table == null)
        return undefined;
    const sorted = [...stl.getSymbols()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (sorted.length === 0)
        return undefined;
    const cmds = sorted.map(sym => insertSqlSyncGenerated(table, sym as unknown as Entity));
    return SqlPreCommand.combine(Spacing.Simple, ...cmds);
}

// Synchronization (Signum's SymbolLogic<T>.Schema_Synchronizing): diff the declared symbols (should) vs the
// live rows (current) BY KEY. A new key is INSERTed (DB assigns the id); a removed key is DELETEd; a matched
// key KEEPS its persisted id and is only UPDATEd if other columns drifted — never re-id'd (the id is an FK
// target across the database). Key renames are asked through Replacements and land in mergeBoth. Mirrors
// synchronizeTypes.
async function synchronizeSymbols(replacements: Replacements, ctor: Type<Symbol>): Promise<SqlPreCommand | undefined> {
    const connector = Connector.current();
    const schema = connector.schema;
    const stl = byCtor.get(ctor);
    const table = schema.tryTable(ctor);
    if (stl == null || table == null)
        return undefined;

    const keyCol = table.fields["key"].field.columns()[0].name;
    const pkCol = table.primaryKey.column.name;

    type Current = { id: PrimaryKey; image: Map<string, unknown> };
    const current = new Map<string, Current>();
    // Read current rows from the table's OLD name if it was renamed this run (readObjectName). A not-yet-
    // created table (the first sync introducing this symbol type) yields no current rows, so every symbol
    // becomes an INSERT that runs after the CREATE emitted earlier in this same script. Any OTHER read
    // failure propagates to Schema.synchronizationScript, which comments it out (so the error surfaces).
    const readName = readObjectName(table, replacements);
    if (await existsTable(readName)) {
        for (const row of await retrieveRows(table, readName))
            current.set(String(row.get(keyCol)), { id: row.get(pkCol) as PrimaryKey, image: row });
    }

    // `should` is keyed by key; the symbol INSTANCE carries its (persisted, after load) id for a matched
    // key — for a NEW key it is id-less, so insertSqlSyncGenerated omits the id (DB assigns).
    const should = new Map<string, Symbol>(stl.getSymbols().map(s => [s.key, s]));

    return Synchronizer.synchronizeScriptReplacing<Symbol, Current>(
        replacements,
        Replacements.keyEnumsForTable(table.name.name), // reuse the seeded-table rename bucket
        Spacing.Double,
        should,
        current,
        (_k, s) => insertSqlSyncGenerated(table, s as Entity), // new symbol: no id, DB assigns
        (_k, c) => deleteSqlSync(table, bareSymbol(ctor, c.id)),
        (_k, s, c) => {
            // Matched by key: KEEP the persisted id (stamp it on the instance so the row image + any UPDATE
            // target the real row), never re-id. Update only if a non-id column drifted.
            (s as { id: PrimaryKey }).id = c.id;
            s.isNew = false;
            return imageEquals(rowImage(table, s as Entity), c.image) ? undefined : updateSqlSync(table, s as Entity);
        },
    );
}

// A bare symbol carrying just an id, for building a DELETE (deleteSqlSync reads only id).
function bareSymbol(ctor: Type<Symbol>, id: PrimaryKey): Entity {
    const s = new ctor();
    (s as { id: PrimaryKey }).id = id;
    return s as Entity;
}

// Reads every row of a symbol table as Map<physicalColumn, value>. A symbol table has a fixed shape
// (id + key), so unlike retrieveEnumRows this needs no column-rename tolerance.
async function retrieveRows(table: Table, readName: ObjectName): Promise<Map<string, unknown>[]> {
    const connector = Connector.current();
    const sqlBuilder = connector.sqlBuilder;
    const columns = Object.values(table.columns);
    const select = columns.map(c => sqlBuilder.sqlEscape(c.name)).join(", ");
    const rows = await connector.executeQuery(`SELECT ${select} FROM ${sqlBuilder.objectName(readName)}`) as Record<string, unknown>[];
    return rows.map(r => new Map(columns.map(c => [c.name, r[c.name]])));
}

function imageEquals(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
    if (a.size !== b.size)
        return false;
    for (const [k, v] of a)
        if (norm(v) !== norm(b.get(k)))
            return false;
    return true;
}
function norm(v: unknown): string {
    return v == null ? "" : String(v);
}
