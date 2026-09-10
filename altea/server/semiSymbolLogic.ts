import "../data/globals"; // Array.prototype.toMap
import { joinRelaxed } from "../data/globals/joinRelaxed";
import type { Entity, PrimaryKey, Type } from "../data/entity";
import { SemiSymbol } from "../data/semiSymbol";
import { declaredSymbolsForType } from "../data/registration";
import { ResetLazy } from "../data/resetLazy";
import { StartParameters } from "../data/utils/startParameters";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import type { Schema, SynchronizingHandler } from "./schema/schema";
import { Connector } from "./connection/connector";
import { SqlPreCommand, Spacing } from "./sync/sqlPreCommand";
import { Synchronizer, Replacements } from "./sync/synchronizer";
import { insertSqlSyncGenerated, updateSqlSync, deleteSqlSync, copyRowFields } from "./save";
import { table } from "./table";
import { Administrator } from "./Administrator";

// Port of Signum's SemiSymbolLogic<T> (Signum/Basics/SemiSymbolLogic.cs) — SymbolLogic's sibling, and the
// difference is one line of its synchronization: a row whose KEY IS NULL is a row a USER created, so it is
// invisible to the diff and is never deleted. Signum spells that `current.Where(c => c.Key.HasText())`.
//
// That is the whole reason SemiSymbol exists: the declared ones are code, the rest are data, and a
// synchronizer that cannot tell them apart would delete somebody's rows.
//
// altea divergences: the ResetLazy read-back replaces Signum's GlobalLazy + `SetFromDatabase` +
// `CallRetrieved` plumbing (see the data header), and it is keyed by ctor exactly as SymbolLogic's is.

interface SemiSymbolTypeLogic<T extends SemiSymbol> {
    readonly ctor: Type<T>;
    readonly getSemiSymbols: () => T[];
    readonly lazy: ResetLazy<Map<string, T>>;
}

const byCtor = new Map<Function, SemiSymbolTypeLogic<SemiSymbol>>();
const startedBySchema = new WeakMap<Schema, Set<Function>>();

let loading = false;

export namespace SemiSymbolLogic {
    export function isLoading(): boolean { return loading; }

    /** Signum's `SemiSymbolLogic<T>.Start(sb, getSemiSymbols)`. The include is the CALLER's — a SemiSymbol
     *  table is user-writable, so its module opens it with its own Save operation and query. */
    export function start<T extends SemiSymbol>(
        sb: SchemaBuilder,
        ctor: Type<T>,
        getSemiSymbols: () => T[] = () => declaredSymbolsForType(ctor as never) as unknown as T[],
    ): void {
        let started = startedBySchema.get(sb.schema);
        if (started == null)
            startedBySchema.set(sb.schema, started = new Set());
        if (started.has(ctor))
            return;
        started.add(ctor);

        sb.include(ctor);

        if (!byCtor.has(ctor))
            byCtor.set(ctor, {
                ctor,
                getSemiSymbols,
                lazy: new ResetLazy<Map<string, T>>(() => buildCache(ctor)),
            } as SemiSymbolTypeLogic<SemiSymbol>);

        sb.schema.generating.push(schema => generateSemiSymbols(schema, ctor));

        const synchronizeThis: SynchronizingHandler = replacements => synchronizeSemiSymbols(replacements, ctor);
        Object.defineProperty(synchronizeThis, "name", { value: `synchronizeSemiSymbols(${ctor.name})`, configurable: true });
        sb.schema.synchronizing.push(synchronizeThis);

        sb.schema.initializing.push(() => load(ctor));
    }

    export async function load<T extends SemiSymbol>(ctor: Type<T>): Promise<void> {
        const stl = byCtor.get(ctor);
        if (stl == null) return;
        stl.lazy.reset();
        await stl.lazy.value();
    }

    export async function ready<T extends SemiSymbol>(ctor: Type<T>): Promise<void> {
        await byCtor.get(ctor)?.lazy.value();
    }

    /** The DECLARED semi-symbols, warmed with their persisted ids (Signum's `SemiSymbols`). */
    export function semiSymbols<T extends SemiSymbol>(ctor: Type<T>): T[] {
        return [...cache(ctor).values()] as T[];
    }

    export function tryToSemiSymbol<T extends SemiSymbol>(ctor: Type<T>, key: string): T | undefined {
        return cache(ctor).get(key) as T | undefined;
    }

    export function toSemiSymbol<T extends SemiSymbol>(ctor: Type<T>, key: string): T {
        const s = cache(ctor).get(key);
        if (s == null)
            throw new Error(`SemiSymbol '${key}' is not registered for ${ctor.name}.`);
        return s as T;
    }
}

function cache<T extends SemiSymbol>(ctor: Type<T>): Map<string, T> {
    const stl = byCtor.get(ctor);
    if (stl == null)
        throw new Error(`SemiSymbolLogic has not been started for ${ctor.name}. Call SemiSymbolLogic.start(sb, ${ctor.name}) first.`);
    const c = stl.lazy.valueOrUndefined;
    if (c == null)
        throw new Error(`SemiSymbolLogic cache for ${ctor.name} is not loaded — the async load (run by schema.initialize()) must have completed.`);
    return c as Map<string, T>;
}

// The read-back (Signum's lazy factory): stamp each persisted id onto the shared DECLARED instance, matched
// by key. Rows with NO key are a user's and take no part. Tolerant of a missing table / a table whose shape
// trails the code, exactly as SymbolLogic and TypeLogic are — this runs at startup, before `sync`.
async function buildCache<T extends SemiSymbol>(ctor: Type<T>): Promise<Map<string, T>> {
    loading = true;
    try {
        const byKey = new Map<string, T>();

        const semiTable = Connector.current().schema.tryTable(ctor as never);
        if (semiTable == null || !await Administrator.existsTable(semiTable))
            return byKey;

        let rows: { key: string | null; id: PrimaryKey }[];
        try {
            rows = await table(ctor as never).toArray() as unknown as { key: string | null; id: PrimaryKey }[];
        } catch (e) {
            StartParameters.reportDatabaseMismatch(new Error(
                `Could not read the ${ctor.name} table (${semiTable.name.toString()}) — the database trails the code. Consider Synchronize.`
                + "\n" + ((e as Error)?.message ?? String(e))));
            return byKey;
        }

        // Signum's `.Where(a => a.Key.HasText())`: only the DECLARED half is cached.
        const keyed = rows.filter((r): r is { key: string; id: PrimaryKey } => r.key != null && r.key !== "");
        if (keyed.length === 0)
            return byKey;

        for (const [row, sym] of joinRelaxed(
            keyed,
            byCtor.get(ctor)!.getSemiSymbols(),
            row => row.key,
            s => s.key!,
            (row, s) => [row, s] as [{ key: string; id: PrimaryKey }, SemiSymbol],
            "caching " + ctor.name,
        )) {
            (sym as { id: PrimaryKey }).id = row.id;
            sym.isNew = false;
            byKey.set(row.key, sym as T);
        }

        return byKey;
    } finally {
        loading = false;
    }
}

/**
 * The declared semi-symbols as they should be STORED — Signum's `CreateSemiSymbols`.
 *
 * The one step here is the NAME. `init()` fills it from the field name ("QuestionSummarizer"), which is
 * what Signum's `SemiSymbol(declaringType, fieldName)` ctor does; the row, though, holds the DISPLAY name
 * ("Question summarizer"), because Signum re-assigns `item.Name = item.NiceToString()` on the way to both
 * the generate and the synchronize script. Without it every declared semi-symbol reads as changed against
 * a Signum database, and altea's own rows carry an identifier where a label belongs.
 *
 * It mutates the DECLARED instances, as Signum does: the registry is the single source of what a symbol is
 * called, so the runtime object and its row agree afterwards. (Signum wraps this in
 * `ChangeCulture(Schema.ForceCultureInfo)` so the stored label is the app's canonical language rather than
 * whatever culture the sync happens to run in; altea's `niceToString` reads the registered descriptions,
 * which are not per-request culture-switched here, so there is nothing to pin.)
 */
function createSemiSymbols(symbols: Iterable<SemiSymbol>): SemiSymbol[] {
    const result = [...symbols];
    for (const s of result)
        s.name = s.niceToString();
    return result;
}

// Generation: one INSERT per DECLARED semi-symbol (Signum's Schema_Generating).
function generateSemiSymbols<T extends SemiSymbol>(schema: Schema, ctor: Type<T>): SqlPreCommand | undefined {
    const stl = byCtor.get(ctor);
    const semiTable = schema.tryTable(ctor as never);
    if (stl == null || semiTable == null)
        return undefined;

    const sorted = createSemiSymbols(stl.getSemiSymbols()).sort((a, b) => (a.key! < b.key! ? -1 : a.key! > b.key! ? 1 : 0));
    if (sorted.length === 0)
        return undefined;

    return SqlPreCommand.combine(Spacing.Simple, ...sorted.map(s => insertSqlSyncGenerated(semiTable, s as Entity)));
}

// Synchronization (Signum's Schema_Synchronizing). The ONE thing that makes this not SymbolLogic: `current`
// holds only the rows that HAVE a key, so a user-created row is neither matched nor removed.
async function synchronizeSemiSymbols<T extends SemiSymbol>(
    replacements: Replacements,
    ctor: Type<T>,
): Promise<SqlPreCommand | undefined> {
    const schema = Connector.current().schema;
    const stl = byCtor.get(ctor);
    const semiTable = schema.tryTable(ctor as never);
    if (stl == null || semiTable == null)
        return undefined;

    const all = await Administrator.tryRetrieveAll(ctor as never, replacements) as SemiSymbol[];
    const current = all.filter(c => c.key != null && c.key !== "").toMap(c => c.key!);
    const should = createSemiSymbols(stl.getSemiSymbols()).toMap(s => s.key!);

    return Synchronizer.synchronizeScriptReplacing<SemiSymbol, SemiSymbol>(
        replacements,
        Replacements.keyEnumsForTable(semiTable.name.name),
        Spacing.Double,
        should,
        current,
        (_k, s) => insertSqlSyncGenerated(semiTable, s as Entity),
        (_k, c) => deleteSqlSync(semiTable, c as Entity),
        (_k, s, c) => {
            // Matched by key: the persisted row KEEPS its id (an FK target across the database) and takes
            // the declared key + name.
            copyRowFields(c as Entity, s as Entity);
            return updateSqlSync(semiTable, c as Entity);
        },
    );
}
