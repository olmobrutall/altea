import { Connector } from "./connection/connector";
import { cleanTypeName } from "../data/registration";
import { TypeEntity } from "../data/typeEntity";
import { quotedFunction } from "./query";
import { ClassType } from "./runtimeTypes";
import { ResetLazy } from "../data/resetLazy";
import { insertSqlSyncGenerated, updateSqlSync, deleteSqlSync } from "./save";
import { table as table_ } from "./table";
import { existsTable, readObjectName } from "./sync/syncTableRead";
import { Synchronizer, Replacements } from "./sync/synchronizer";
import type { Entity, PrimaryKey } from "../data/entity";
import type { Schema } from "./schema/schema";
import type { Table } from "./schema/table";
import { SqlPreCommand, Spacing } from "./sync/sqlPreCommand";

// Port of Signum's TypeLogic (Basics/TypeLogic.cs): the single server-side facade mapping
// every persistent entity type to a stable int id, via the TypeEntity system table. That id
// is the discriminator `@implementedByAll` stores (its type column), what `GetType()` /
// type-equality compares, and what the reader resolves back to a constructor — Signum's
// `TypeToId` / `IdToType` caches, plus `IdToEntity` (the `Map<PrimaryKey, TypeEntity>`).
//
// **Faithful to Signum: the ids are DB-assigned and read back.** TypeEntity has an identity
// PK; generation inserts the rows without ids (the DB assigns them) and `TypeLogic.load`
// reads them back into the caches. The caches therefore hold whatever ids the database
// actually persisted, so a `@implementedByAll` discriminator written in one run resolves to
// the same type in the next — unlike a positional in-memory scheme, which would drift the
// moment the type set changed and corrupt every stored discriminator. This is exactly why the
// caches live behind a `ResetLazy` (Signum's `typeCachesLazy`): they load from the DB and are
// reset after a sync inserts/renames/removes a type (see `synchronizeTypes` / `load`).
//
// The ONE altea-specific wrinkle: altea has no synchronous DB API, but `typeToId` is called
// synchronously all over the query/save hot path, so the ResetLazy factory cannot itself read
// the database (Signum's does, blocking). Instead the async read lives in `load()`, which
// stows the rows on `schema.typeRowsSnapshot` and resets the lazy; the factory projects that
// snapshot. When no snapshot has been loaded yet — a fresh database before generation, or the
// offline binder tests with a fake connector — the factory falls back to a DETERMINISTIC
// bootstrap (entity ctors sorted by name, 1..N). Generation seeds the rows in that same sorted
// order, so the DB-assigned identity ids coincide with the bootstrap ids for an unchanged
// schema; `load()` then reads back those very ids. Divergences vs Signum are limited to this
// module (and the identity-vs-seeded PK toggle in SchemaBuilder).

export interface TypeRow {
    id: PrimaryKey;
    tableName: string;
    cleanName: string;
    namespace: string;
    className: string;
}

// The bidirectional type↔id caches (Signum's TypeCaches), projected from a TypeRow[] — either
// the DB snapshot or the deterministic bootstrap. Held behind the schema's ResetLazy.
export interface TypeCaches {
    typeToId: Map<Function, PrimaryKey>;
    idToType: Map<PrimaryKey, Function>;
    idToEntity: Map<PrimaryKey, TypeEntity>;
    typeRows: TypeRow[];
}

export class TypeLogic {
    private constructor() { }

    // The caches live on the Schema (not process-global statics), so multiple schemas coexist
    // in one process without clobbering each other. The read methods resolve the registry from
    // the active connection's schema (Signum reaches its caches via Schema.Current); the
    // offline binder tests wrap binding in Connector.withConnector.
    private static get schema(): Schema {
        return Connector.current().schema;
    }

    // Installs the type-caches lazy on the *given* schema and registers the generate + sync
    // steps. Called from SchemaBuilder.complete() once every table is included (Signum's
    // TypeLogic.Start + the typeCaches GlobalLazy). Idempotent per schema. Does NOT compute the
    // caches or touch the database — the caches build on first read (bootstrap) and are
    // refreshed from the DB by `load()`.
    static start(schema: Schema): void {
        schema.typeRowsSnapshot = undefined;
        schema.typeCaches = new ResetLazy<TypeCaches>(() => buildCaches(schema));

        if (!schema.generating.includes(seedTypeEntities))
            schema.generating.push(seedTypeEntities);
        if (!schema.synchronizing.includes(synchronizeTypes))
            schema.synchronizing.push(synchronizeTypes);
        // Signum's TypeLogic subscription to Schema.Initializing: read the persisted TypeEntity ids back
        // into the caches when the host calls schema.initialize() (after gen/sync). UNSHIFT (run FIRST):
        // the type↔id caches are foundational — other initializing hooks (e.g. authorization warming the
        // role/type rule cache) call TypeLogic.typeToId, so the ids must be loaded before they run.
        if (!schema.initializing.includes(TypeLogic.load))
            schema.initializing.unshift(TypeLogic.load);
    }

    // Reads the persisted TypeEntity rows back into the schema's snapshot and resets the caches
    // (Signum's Schema.Initializing → typeCachesLazy.Load, plus the post-sync invalidation).
    // Call after the connector is bound and the schema exists in the DB: at server startup, and
    // after generation / synchronization mutate the table. Tolerant of a not-yet-created table
    // (a fresh DB): clears the snapshot so the deterministic bootstrap applies until generation
    // runs. `schema` defaults to the active connection's schema.
    static async load(schema: Schema = this.schema): Promise<void> {
        const table = schema.tryTable(TypeEntity as never);
        // Guard the ORM read: on a not-yet-generated database `table(TypeEntity).toArray()` would
        // fail against a missing table. When absent, clear the snapshot so the deterministic
        // bootstrap covers reads until generation seeds the table (existsTable is the low-level
        // catalog probe, cycle-free — unlike the query provider).
        if (table == null || !(await existsTable(table.name))) {
            schema.typeRowsSnapshot = undefined;
            schema.typeCaches.reset();
            return;
        }

        // Signum's TypeCaches reads the rows through the ORM (Database.RetrieveAll<TypeEntity>).
        // TypeEntity has only scalar columns (no @implementedByAll), so materialising it never
        // needs the very caches we are loading — no bootstrap circularity. The typeLogic → table
        // → QueryBinder → typeLogic import cycle is eval-safe: `table` is used only here at
        // runtime, never during module evaluation (same as the existing typeLogic ↔ save cycle).
        const rows = await table_(TypeEntity).toArray();
        schema.typeRowsSnapshot = rows.map(te => ({
            id: te.id!,
            tableName: te.tableName,
            cleanName: te.cleanName,
            namespace: te.namespace ?? "",
            className: te.className,
        }));
        schema.typeCaches.reset();
    }

    // The discriminator id for an entity type (Signum's TypeToId.GetOrThrow).
    static typeToId(ctor: Function): PrimaryKey {
        const id = this.schema.typeCaches.value.typeToId.get(ctor);
        if (id == null)
            throw new Error(`Type '${ctor.name}' is not registered in TypeLogic. Was its table included before SchemaBuilder.complete(), and TypeLogic.load() run after generation/sync?`);
        return id;
    }

    // The entity type for a discriminator id, or undefined if unknown (Signum's
    // Schema.GetType / IdToType lookup — the IBA materialisation path).
    static tryGetType(id: PrimaryKey | null): Function | undefined {
        return id == null ? undefined : this.schema.typeCaches.value.idToType.get(id);
    }

    static getType(id: PrimaryKey): Function {
        const ctor = this.schema.typeCaches.value.idToType.get(id);
        if (ctor == null)
            throw new Error(`No registered entity type for TypeEntity id '${id}'.`);
        return ctor;
    }

    // The TypeEntity row for a discriminator id (Signum's IdToType + TypeToEntity).
    static idToEntity(id: PrimaryKey): TypeEntity | undefined {
        return this.schema.typeCaches.value.idToEntity.get(id);
    }

    // The clean type name (Signum's Reflector.CleanTypeName) — used to populate the
    // TypeEntity.cleanName column and for display, NOT as the stored discriminator.
    static getCleanName(ctor: Function): string {
        return cleanTypeName(ctor);
    }
}

// Builds the type↔id caches from the DB snapshot when one has been loaded, else from the
// deterministic bootstrap (Signum's TypeCaches constructor, which JoinRelaxed-joins the
// retrieved TypeEntity rows to the schema types by class name). A snapshot row whose type is no
// longer in the model is skipped (Signum's relaxed join); a model type not yet in the snapshot
// simply has no id until the next sync inserts it and load() re-reads.
function buildCaches(schema: Schema): TypeCaches {
    const rows = schema.typeRowsSnapshot ?? bootstrapRows(schema);

    const ctorByClassName = new Map<string, Function>();
    for (const [type] of schema.tables)
        if (typeof type === "function")
            ctorByClassName.set(type.name, type);

    const typeToId = new Map<Function, PrimaryKey>();
    const idToType = new Map<PrimaryKey, Function>();
    const idToEntity = new Map<PrimaryKey, TypeEntity>();
    for (const r of rows) {
        const ctor = ctorByClassName.get(r.className);
        if (ctor == null)
            continue;
        typeToId.set(ctor, r.id);
        idToType.set(r.id, ctor);
        idToEntity.set(r.id, typeEntityFromRow(r));
    }
    return { typeToId, idToType, idToEntity, typeRows: rows };
}

// The deterministic bootstrap: every real entity ctor (enum side-tables, keyed by a generic
// descriptor, are never @implementedByAll targets and get no row), sorted by ctor name and
// numbered 1..N. Used when no DB snapshot is loaded (fresh DB before generation; offline binder
// tests). Generation seeds the rows in this same order so the DB-assigned identity ids match.
function bootstrapRows(schema: Schema): TypeRow[] {
    const entries: [Function, Table][] = [];
    for (const [type, table] of schema.tables)
        if (typeof type === "function")
            entries.push([type, table]);
    entries.sort((a, b) => (a[0].name < b[0].name ? -1 : a[0].name > b[0].name ? 1 : 0));
    return entries.map(([ctor, table], i) => ({
        id: i + 1,
        tableName: table.name.name,
        cleanName: cleanTypeName(ctor),
        namespace: "",
        className: ctor.name,
    }));
}

function typeEntityFromRow(r: TypeRow): TypeEntity {
    const te = new TypeEntity();
    (te as { id: PrimaryKey }).id = r.id;
    te.isNew = false;
    te.tableName = r.tableName;
    te.cleanName = r.cleanName;
    te.namespace = r.namespace;
    te.className = r.className;
    return te;
}

// A TypeEntity carrying the given metadata (and optional id) — for generation inserts (no id,
// DB assigns) and sync updates/deletes (id = the persisted row's).
function typeEntityFromMeta(m: { tableName: string; cleanName: string; namespace: string; className: string }, id?: PrimaryKey): TypeEntity {
    const te = new TypeEntity();
    if (id != null)
        (te as { id: PrimaryKey }).id = id;
    te.tableName = m.tableName;
    te.cleanName = m.cleanName;
    te.namespace = m.namespace;
    te.className = m.className;
    return te;
}

// Generation step (Signum's TypeLogic.Schema_Generating): INSERT one row per entity type into
// the TypeEntity table, in the deterministic sorted order, WITHOUT an id (the identity PK is
// DB-assigned — insertSqlSyncGenerated omits it). Per-row statements (not one multi-row VALUES)
// so the identity ids increment in a defined order, matching the bootstrap. Runs after the
// tables exist (pushed onto schema.generating). Reads the rows off the schema it is invoked with.
function seedTypeEntities(schema: Schema): SqlPreCommand | undefined {
    const table = schema.tryTable(TypeEntity as never);
    if (table == null)
        return undefined;
    const cmds = bootstrapRows(schema).map(r => insertSqlSyncGenerated(table, typeEntityFromMeta(r) as unknown as Entity));
    return SqlPreCommand.combine(Spacing.Simple, ...cmds);
}

// Synchronization step (Signum's TypeLogic.Schema_Synchronizing): diff the model types
// (`should`, keyed by physical table name — Signum's TypeTableName) against the persisted rows
// (`current`). A new type is INSERTed (DB assigns the id); a removed type is DELETEd; a matched
// type KEEPS its persisted id and only has its metadata UPDATEd — never re-id'd, because that
// id is the @implementedByAll discriminator stored across the whole database. Table renames are
// asked through Replacements (like the enum/symbol steps). A freshly generated schema diffs to
// nothing, so this returns undefined (the SynchronizeTablesScriptEmpty self-consistency check).
async function synchronizeTypes(replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const connector = Connector.current();
    const schema = connector.schema;
    const table = schema.tryTable(TypeEntity as never);
    if (table == null)
        return undefined;

    const sqlBuilder = connector.sqlBuilder;
    const pkCol = table.primaryKey.column.name;
    const col = (f: string): string => table.fields[f].field.columns()[0].name;

    type Meta = { tableName: string; cleanName: string; namespace: string; className: string };
    const should = new Map<string, Meta>();
    for (const [type, t] of schema.tables)
        if (typeof type === "function")
            should.set(t.name.name, { tableName: t.name.name, cleanName: cleanTypeName(type), namespace: "", className: type.name });

    type Cur = { id: PrimaryKey } & Meta;
    const currentByTable = new Map<string, Cur>();
    // Read from the table's OLD name if it was renamed this run (readObjectName). A not-yet-created
    // table (the first sync introducing TypeEntity) yields no current rows, so every type becomes an
    // INSERT that runs after the CREATE emitted earlier in this same script. Any OTHER read failure
    // propagates to Schema.synchronizationScript, which comments it out (so it surfaces).
    const readName = readObjectName(table, replacements);
    if (await existsTable(readName)) {
        const cols = [pkCol, col("tableName"), col("cleanName"), col("namespace"), col("className")];
        const rows = await connector.executeQuery(
            `SELECT ${cols.map(c => sqlBuilder.sqlEscape(c)).join(", ")} FROM ${sqlBuilder.objectName(readName)}`,
        ) as Record<string, unknown>[];
        for (const r of rows) {
            const tableName = String(r[col("tableName")]);
            currentByTable.set(tableName, {
                id: r[pkCol] as PrimaryKey,
                tableName,
                cleanName: String(r[col("cleanName")]),
                namespace: r[col("namespace")] == null ? "" : String(r[col("namespace")]),
                className: String(r[col("className")]),
            });
        }
    }

    // synchronizeScriptReplacing asks which removed table name each new one renames (the
    // "TypeTableName" bucket) and re-keys current by the new name, so a renamed type lands in
    // mergeBoth (metadata UPDATE) rather than a delete+insert — which would re-id it and break
    // its discriminator.
    return Synchronizer.synchronizeScriptReplacing<Meta, Cur>(
        replacements,
        "TypeTableName",
        Spacing.Double,
        should,
        currentByTable,
        (_k, s) => insertSqlSyncGenerated(table, typeEntityFromMeta(s) as unknown as Entity),
        (_k, c) => deleteSqlSync(table, typeEntityFromMeta(c, c.id) as unknown as Entity),
        (_k, s, c) =>
            (s.tableName === c.tableName && s.cleanName === c.cleanName && s.namespace === c.namespace && s.className === c.className)
                ? undefined
                : updateSqlSync(table, typeEntityFromMeta(s, c.id) as unknown as Entity), // keep the persisted id
    );
}

// `f.constructor.toTypeEntity()` in a query (Signum's Type.ToTypeEntity() on a runtime type):
// `this` is the entity constructor, so this returns its TypeEntity row via TypeLogic's caches. A
// real in-memory body (so it also works when a lambda runs in memory) plus the query `__resultType`
// fromQuoted reads to type the call; the QueryBinder lowers it to SQL. `f.constructor` (GetType)
// and `lite.entityType` are runtime-type tokens typed `Function`, so this method lives on Function;
// `Type.FullName` maps to native `Function.name`. Lives here in TypeLogic — the entity-type ↔
// TypeEntity facade it resolves against. (`.niceName()` lives in localization.ts.)
declare global {
    interface Function {
        toTypeEntity(): TypeEntity;
    }
}
Function.prototype.toTypeEntity = function (this: Function): TypeEntity {
    return TypeLogic.idToEntity(TypeLogic.typeToId(this))!;
};
quotedFunction(Function.prototype.toTypeEntity).__resultType = () => new ClassType(TypeEntity);
