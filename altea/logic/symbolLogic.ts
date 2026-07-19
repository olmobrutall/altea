import type { Entity, PrimaryKey } from "../entities/entity";
import { Symbol } from "../entities/symbol";
import { declaredSymbolsForType } from "../entities/registration";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import type { Schema } from "./schema/schema";
import type { Table } from "./schema/table";
import { Connector } from "./connection/connector";
import { SqlPreCommand, Spacing } from "./sync/sqlPreCommand";
import { Synchronizer, Replacements } from "./sync/synchronizer";
import { insertSqlSync, updateSqlSync, deleteSqlSync, rowImage } from "./save";

// Port of Signum's SymbolLogic<T> (Signum/Basics/SymbolLogic.cs).
//
// TS has no generic static classes, so Signum's `static class SymbolLogic<T> where
// T : Symbol` — whose static fields hold one cache per closed T — becomes a
// `SymbolLogic` namespace whose per-T state lives in a Map keyed by the concrete
// Symbol constructor, and whose methods are generic functions taking that ctor as
// their first argument: the runtime stand-in for the `<T>` type parameter. This is
// the same translation the rest of altea uses for C# generic statics (TypeLogic keeps
// its per-schema caches on the Schema; here the natural key is the symbol ctor).
//
// altea divergences (as in TypeLogic, because there is no GlobalLazy / read-back):
//  - ids are assigned DETERMINISTICALLY in memory (declared symbols sorted by key,
//    1..N) instead of read back from an identity column. Generation and runtime agree
//    because the assignment is reproducible; the concrete symbol table is therefore a
//    seeded, non-identity-PK table (see schemaBuilder isSeeded / isSymbolType).
//  - because in-memory ids ARE the DB ids, the sync's merge re-ids a row whose id
//    drifted (a member added/removed shifts positional ids) rather than Signum's
//    "keep the DB id, just update the key". Phase 2 has no incoming FKs, so re-id is a
//    plain delete+insert; when OperationLogEntity FKs land, switch to
//    insert + moveReferences + delete (see synchronizeEnumsScript) — or move to
//    identity + read-back, the fully faithful model.
//
// Signum bits intentionally deferred: the `Saved` guard (forbid saving a symbol) and
// `Retrieved`/FieldInfo attachment need entity events altea does not have yet; the
// GlobalLazy + Schema.Initializing load is unnecessary under deterministic ids.

interface SymbolTypeLogic {
    ctor: new () => Symbol;
    getSymbols: () => Symbol[];
    byKey: Map<string, Symbol>; // Signum's `lazy` cache: key -> symbol (id assigned)
}

// One entry per concrete Symbol type — the analogue of Signum's per-closed-T static
// fields. Module-global (like Signum's statics); keyed by the symbol constructor. The
// cache/ids are schema-independent (a symbol's id is derived from its own key set, not
// from the schema's other tables — unlike TypeEntity), so a single global entry serves
// every schema in the process.
const byCtor = new Map<Function, SymbolTypeLogic>();

// Per-schema idempotency (Signum's per-schema AlreadyDefined). altea builds several
// schemas per process (e.g. one per dialect in the offline tests), each of which must
// still include the table and push its own generate/sync steps — so the guard is keyed
// by schema, NOT globally by ctor.
const startedBySchema = new WeakMap<Schema, Set<Function>>();

export namespace SymbolLogic {
    // Signum's SymbolLogic<T>.Start. Includes the concrete symbol table, assigns
    // deterministic ids to the declared symbols, and registers the generate + sync
    // steps. Idempotent per schema (Signum's AlreadyDefined guard). `getSymbols` defaults
    // to every declared symbol of this type (Signum passes a narrower set, e.g.
    // OperationLogic.RegisteredOperations — which OperationLogic.start overrides it with).
    export function start<T extends Symbol>(
        sb: SchemaBuilder,
        ctor: new () => T,
        getSymbols: () => T[] = () => declaredSymbolsForType(ctor) as unknown as T[],
    ): void {
        let started = startedBySchema.get(sb.schema);
        if (started == null)
            startedBySchema.set(sb.schema, started = new Set());
        if (started.has(ctor))
            return;
        started.add(ctor);

        sb.include(ctor);

        // Build (or refresh) the global cache. Re-running for another schema recomputes
        // the same ids (assignIds is a pure function of the declared key set), so the
        // shared symbol instances stay consistent across schemas.
        const stl: SymbolTypeLogic = {
            ctor,
            getSymbols: getSymbols as () => Symbol[],
            byKey: new Map(),
        };
        byCtor.set(ctor, stl);

        assignIds(stl);

        sb.schema.generating.push(schema => seedSymbols(schema, ctor));
        sb.schema.synchronizing.push(replacements => synchronizeSymbols(replacements, ctor));
    }

    // Signum's SymbolLogic<T>.Symbols / TryToSymbol / ToSymbol / AllUniqueKeys.
    export function symbols<T extends Symbol>(ctor: new () => T): T[] {
        return [...assertStarted(ctor).byKey.values()] as T[];
    }
    export function tryToSymbol<T extends Symbol>(ctor: new () => T, key: string): T | undefined {
        return assertStarted(ctor).byKey.get(key) as T | undefined;
    }
    export function toSymbol<T extends Symbol>(ctor: new () => T, key: string): T {
        const s = assertStarted(ctor).byKey.get(key);
        if (s == null)
            throw new Error(`Symbol '${key}' is not registered for ${ctor.name}.`);
        return s as T;
    }
    export function allUniqueKeys<T extends Symbol>(ctor: new () => T): Set<string> {
        return new Set(assertStarted(ctor).byKey.keys());
    }
}

function assertStarted(ctor: Function): SymbolTypeLogic {
    const stl = byCtor.get(ctor);
    if (stl == null)
        throw new Error(`SymbolLogic has not been started for ${ctor.name}. Call SymbolLogic.start(sb, ${ctor.name}) first.`);
    return stl;
}

// Deterministic, sorted-by-key ids (Signum's SetId, but reproducible instead of read
// from the DB). The declared symbols are the shared init() instances; stamping their
// id here is what makes them usable as real (non-new) rows.
function assignIds(stl: SymbolTypeLogic): void {
    stl.byKey.clear();
    const sorted = [...stl.getSymbols()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    sorted.forEach((sym, i) => {
        (sym as { id: PrimaryKey }).id = i + 1;
        sym.isNew = false;
        stl.byKey.set(sym.key, sym);
    });
}

// Generation (Signum's SymbolLogic<T>.Schema_Generating): INSERT one row per symbol
// with its assigned id, through the same sync saver the reconcile step uses
// (insertSqlSync — explicit PK + all columns). executeNonQuery runs each leaf with its
// own parameters, so combining them is safe.
function seedSymbols(schema: Schema, ctor: new () => Symbol): SqlPreCommand | undefined {
    const stl = byCtor.get(ctor);
    const table = schema.tryTable(ctor);
    if (stl == null || table == null || stl.byKey.size === 0)
        return undefined;
    const cmds = [...stl.byKey.values()].map(sym => insertSqlSync(table, sym as Entity));
    return SqlPreCommand.combine(Spacing.Simple, ...cmds);
}

// Synchronization (Signum's SymbolLogic<T>.Schema_Synchronizing): diff the declared
// symbols (should) against the live rows (current) by key, via
// Synchronizer.synchronizeScriptReplacing — the mirror of Signum's
// SynchronizeScriptReplacing. Rename (a key changed) is asked through Replacements and
// lands in mergeBoth; genuine add/remove hit createNew/removeOld.
async function synchronizeSymbols(replacements: Replacements, ctor: new () => Symbol): Promise<SqlPreCommand | undefined> {
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
    for (const row of await retrieveRows(table))
        current.set(String(row.get(keyCol)), { id: row.get(pkCol) as PrimaryKey, image: row });

    const should = stl.byKey; // key -> symbol (id assigned)

    return Synchronizer.synchronizeScriptReplacing<Symbol, Current>(
        replacements,
        Replacements.keyEnumsForTable(table.name.name), // reuse the seeded-table rename bucket
        Spacing.Double,
        should,
        current,
        (_k, s) => insertSqlSync(table, s as Entity),
        (_k, c) => deleteSqlSync(table, bareSymbol(ctor, c.id)),
        (_k, s, c) => {
            if (s.id === c.id)
                return imageEquals(rowImage(table, s as Entity), c.image)
                    ? undefined
                    : updateSqlSync(table, s as Entity);
            // Positional id drifted → re-id. No incoming FKs in Phase 2, so delete+insert
            // is sufficient (add moveReferences here once OperationLogEntity references it).
            return SqlPreCommand.combine(
                Spacing.Simple,
                deleteSqlSync(table, bareSymbol(ctor, c.id)),
                insertSqlSync(table, s as Entity),
            );
        },
    );
}

// A bare symbol carrying just an id, for building a DELETE (deleteSqlSync reads only id).
function bareSymbol(ctor: new () => Symbol, id: PrimaryKey): Entity {
    const s = new ctor();
    (s as { id: PrimaryKey }).id = id;
    return s as Entity;
}

// Reads every row of a symbol table as Map<physicalColumn, value> (no
// Administrator.retrieveAll in altea). A symbol table has a fixed shape (id + key), so
// unlike retrieveEnumRows this needs no column-rename tolerance.
async function retrieveRows(table: Table): Promise<Map<string, unknown>[]> {
    const connector = Connector.current();
    const sqlBuilder = connector.sqlBuilder;
    const columns = Object.values(table.columns);
    const select = columns.map(c => sqlBuilder.sqlEscape(c.name)).join(", ");
    const rows = await connector.executeQuery(`SELECT ${select} FROM ${sqlBuilder.objectName(table.name)}`) as Record<string, unknown>[];
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
