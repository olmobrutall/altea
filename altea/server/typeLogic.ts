import { joinRelaxed } from "../data/globals/joinRelaxed";
import { Connector } from "./connection/connector";
import { cleanTypeName, getLocation, enumNameOf } from "../data/registration";
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
// The ONE altea-specific wrinkle: altea has no synchronous DB API (Signum's factory blocks on
// Database.RetrieveAll), so the ResetLazy factory is ASYNC — it reads the TypeEntity rows through the
// ORM (`table(TypeEntity)`), guarded by `TypeLogic.isLoading` so the LINQ provider does not re-await the
// lazy for that very query. Because `typeToId` is called SYNCHRONOUSLY all over the query/save hot path
// (and during generation, before the table exists), the sync read falls back to a DETERMINISTIC bootstrap
// (entity ctors sorted by name, 1..N) until an async boundary — server startup / a suite's initialize() —
// has awaited `ready()`/`load()` and warmed the box with the real DB ids. Generation seeds the rows in
// that same sorted order, so the DB-assigned identity ids coincide with the bootstrap ids for an unchanged
// schema; a changed schema is reconciled by sync + the load() read-back. Divergences vs Signum are limited
// to this module (and the identity-vs-seeded PK toggle in SchemaBuilder).

// The bidirectional type↔id caches (Signum's TypeCaches), projected from the TypeEntity rows —
// either the DB rows or the deterministic bootstrap. Held behind the schema's ResetLazy.
export interface TypeCaches {
    typeToId: Map<Function, PrimaryKey>;
    idToType: Map<PrimaryKey, Function>;
    idToEntity: Map<PrimaryKey, TypeEntity>;
}

// The type↔id resolvers used by the LINQ pipeline read an EXPLICITLY-THREADED `TypeCaches` (resolved
// once at the LINQ-provider boundary — `isLoading ? undefined : await ready()`), not the ambient static.
// `undefined` means the caches weren't available (a query bound while they were loading): a discriminator
// (@implementedByAll) can't be resolved there, so `requireTypeId` throws — but the re-entrant
// `table(TypeEntity)` load has no such discriminator, so it never calls this.
export function requireTypeId(caches: TypeCaches | undefined, ctor: Function): PrimaryKey {
    if (caches == null)
        throw new Error(`@implementedByAll for '${ctor.name}' can't be resolved: type caches unavailable (a query bound while they were loading).`);
    const id = caches.typeToId.get(ctor);
    if (id == null)
        throw new Error(`Type '${ctor.name}' is not registered in TypeLogic.`);
    return id;
}

export class TypeLogic {
    private constructor() { }

    // True WHILE the async factory is loading the caches — i.e. while its `table(TypeEntity)` query is
    // itself being executed. The LINQ provider checks this to AVOID awaiting `typeCaches.value()` for that
    // re-entrant query (which would deadlock on the very lazy being loaded). TypeEntity has no
    // @implementedByAll column, so that query needs no type↔id lookup anyway; every OTHER query awaits
    // `ready()` first. Process-global (the load is single-flighted per lazy; nested loads never overlap).
    static isLoading = false;

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
        schema.typeCaches = new ResetLazy<TypeCaches>(() => buildCaches(schema));

        if (!schema.generating.includes(generateTypeEntities))
            schema.generating.push(generateTypeEntities);
        if (!schema.synchronizing.includes(synchronizeTypes))
            schema.synchronizing.push(synchronizeTypes);
        // Signum's TypeLogic subscription to Schema.Initializing: read the persisted TypeEntity ids back
        // into the caches when the host calls schema.initialize() (after gen/sync). TypeLogic.load must run
        // FIRST — the type↔id caches are foundational, and other initializing hooks (e.g. authorization
        // building its role/type rule context) call TypeLogic.typeToId — so TypeLogic.start MUST run before
        // any other module registers an initializing hook. Assert that instead of quietly reordering
        // (unshift): a non-empty list here means a module registered too early, which we want to catch loud.
        if (!schema.initializing.includes(TypeLogic.load)) {
            if (schema.initializing.length > 0)
                throw new Error("TypeLogic.start must run before any other Schema.initializing hook is registered — TypeLogic.load loads the foundational type↔id caches those hooks depend on.");
            schema.initializing.push(TypeLogic.load);
        }
    }

    // Warm the type-caches (Signum's typeCachesLazy.Load): an async boundary — the LINQ provider's
    // execute, the saver, server startup — awaits this so the RESOLVED caches are in the box, and
    // subsequent SYNCHRONOUS `typeToId` reads (during binding / materialisation) succeed. Returns the
    // resolved caches. `schema` defaults to the active connection's schema.
    static ready(schema: Schema = this.schema): Promise<TypeCaches> {
        return schema.typeCaches.value();
    }

    // Reset + reload the caches from the DB (Signum's Schema.Initializing → typeCachesLazy.Load, plus
    // the post-sync invalidation). Call after the connector is bound and the schema exists in the DB:
    // at server startup, and after generation / synchronization mutate the table. Tolerant of a
    // not-yet-created table (the factory falls back to the deterministic bootstrap). `schema` defaults
    // to the active connection's schema.
    static async load(schema: Schema = this.schema): Promise<void> {
        schema.typeCaches.reset();
        await schema.typeCaches.value();
    }

    // The resolved caches for a SYNCHRONOUS reader (the static typeToId/getType surface, used by the
    // save discriminator write, the auth logics, etc.) — the async-loaded box, or THROW if it hasn't been
    // loaded yet. Production always has it warm: `initialize()` → `load()` runs before any query or save.
    // No deterministic bootstrap is invented here — an id that isn't the real DB-assigned one is never
    // fabricated (offline SQL-comparison tests seed a cache explicitly — see altea-test's seedTypeCachesForTest).
    private static get caches(): TypeCaches {
        const c = this.schema.typeCaches.valueOrUndefined;
        if (c == null)
            throw new Error("TypeLogic caches are not loaded — type↔id resolution needs the async load (TypeLogic.load(), run by schema.initialize()) to have completed. Offline binders must seed the caches first (altea-test's seedTypeCachesForTest).");
        return c;
    }

    // The discriminator id for an entity type (Signum's TypeToId.GetOrThrow).
    static typeToId(ctor: Function): PrimaryKey {
        const id = this.caches.typeToId.get(ctor);
        if (id == null)
            throw new Error(`Type '${ctor.name}' is not registered in TypeLogic. Was its table included before SchemaBuilder.complete(), and TypeLogic.load() run after generation/sync?`);
        return id;
    }

    // The entity type for a discriminator id, or undefined if unknown (Signum's
    // Schema.GetType / IdToType lookup — the IBA materialisation path).
    static tryGetType(id: PrimaryKey | null): Function | undefined {
        return id == null ? undefined : this.caches.idToType.get(id);
    }

    static getType(id: PrimaryKey): Function {
        const ctor = this.caches.idToType.get(id);
        if (ctor == null)
            throw new Error(`No registered entity type for TypeEntity id '${id}'.`);
        return ctor;
    }

    // The TypeEntity row for a discriminator id (Signum's IdToType + TypeToEntity).
    static idToEntity(id: PrimaryKey): TypeEntity | undefined {
        return this.caches.idToEntity.get(id);
    }

    // The clean type name (Signum's Reflector.CleanTypeName) — used to populate the
    // TypeEntity.cleanName column and for display, NOT as the stored discriminator.
    static getCleanName(ctor: Function): string {
        return cleanTypeName(ctor);
    }
}

// Builds the type↔id caches from the persisted TypeEntity rows (the ResetLazy's async factory —
// Signum's TypeCaches constructor, which JoinRelaxed-joins the retrieved rows to the schema types
// by class name), falling back to the deterministic bootstrap on a not-yet-generated / offline
// schema. A row whose type is no longer in the model is skipped (Signum's relaxed join); a model
// type with no row yet simply has no id until the next sync inserts it and load() re-reads.
async function buildCaches(schema: Schema): Promise<TypeCaches> {
    // Mark the load in-flight so the LINQ provider skips its `ready()` await for the `table(TypeEntity)`
    // query below (see TypeLogic.isLoading) — otherwise that query would await the very lazy we are inside.
    TypeLogic.isLoading = true;
    try {
        return projectCaches(schema, await loadTypeEntities(schema));
    } finally {
        TypeLogic.isLoading = false;
    }
}

// Projects the TypeEntity rows into the bidirectional caches — Signum's TypeCaches ctor, which JOINS the
// retrieved rows to the schema types by class name with `JoinRelaxed`: only the matched pairs make it into the
// caches, and any row without a model type (or model type without a row) is REPORTED through StartParameters
// ("Consider Synchronize"), not silently dropped. Synchronous — shared by the async DB factory and the test
// seeder. EMPTY rows (a fresh database before generation) report nothing: `joinRelaxed` is only reached when
// there is something to compare (see loadTypeEntities).
function projectCaches(schema: Schema, rows: TypeEntity[]): TypeCaches {
    const modelTypes: Function[] = [];
    for (const [type] of schema.tables)
        if (typeof type === "function")
            modelTypes.push(type);

    const typeToId = new Map<Function, PrimaryKey>();
    const idToType = new Map<PrimaryKey, Function>();
    const idToEntity = new Map<PrimaryKey, TypeEntity>();

    if (rows.length === 0)
        return { typeToId, idToType, idToEntity };

    for (const [ctor, te] of joinRelaxed(
        rows,
        modelTypes,
        te => te.className,
        classNameOf,
        (te, ctor) => [ctor, te] as [Function, TypeEntity],
        "caching " + TypeEntity.name,
    )) {
        const id = te.id!;
        typeToId.set(ctor, id);
        idToType.set(id, ctor);
        idToEntity.set(id, te);
    }

    return { typeToId, idToType, idToEntity };
}

// Reads the persisted TypeEntity rows through the ORM (Signum's Database.RetrieveAll<TypeEntity>). Safe
// against re-entrancy: `TypeLogic.isLoading` is set (buildCaches), so the LINQ provider does NOT await
// `ready()` for this query — and TypeEntity has no @implementedByAll column, so binding/materialising it
// needs no type↔id lookup. Returns EMPTY when the table doesn't exist yet (a fresh DB before generation,
// or an offline / fake connector): generation only needs `bootstrapMetas` (insert order), never typeToId,
// and a later `load()` fills the real ids once the table is populated.
async function loadTypeEntities(schema: Schema): Promise<TypeEntity[]> {
    const table = schema.tryTable(TypeEntity as never);
    if (table == null)
        return [];
    let exists = false;
    try { exists = await existsTable(table.name); } catch { return []; }
    if (!exists)
        return [];
    return await table_(TypeEntity).toArray() as TypeEntity[];
}

// The deterministic bootstrap metadata: every real entity ctor (enum side-tables, keyed by a generic
// descriptor, are never @implementedByAll targets and get no row), sorted by ctor name. Generation seeds
// the rows in this same order so the DB-assigned identity ids match the bootstrap 1..N numbering.
type TypeMeta = { tableName: string; cleanName: string; package: string; className: string };
function bootstrapMetas(schema: Schema): TypeMeta[] {
    const entries: [Function, Table][] = [];
    for (const [type, table] of schema.tables)
        if (typeof type === "function")
            entries.push([type, table]);
    entries.sort((a, b) => (a[0].name < b[0].name ? -1 : a[0].name > b[0].name ? 1 : 0));
    return entries.map(([ctor, table]) => ({ tableName: table.name.name, cleanName: cleanTypeName(ctor), package: packageOf(ctor), className: classNameOf(ctor) }));
}

// The registry NAME of an entity/enum ctor for the TypeEntity.className column + its ctor↔row lookup.
// A closed EnumEntity<E> type's ctor.name is "EnumEntity<OrderState>" — use the bare ENUM name
// ("OrderState") instead (matching cleanName + the name its FileInfo/enum registration is keyed by).
function classNameOf(ctor: Function): string {
    const boundEnum = (ctor as { boundEnum?: object }).boundEnum;
    if (boundEnum != null) {
        const enumName = enumNameOf(boundEnum);
        if (enumName != null)
            return enumName;
    }
    return ctor.name;
}

// The owning npm package of an entity/enum ctor (Signum's Namespace analog), from the registration
// FileInfo the quote-transformer stamps — keyed by classNameOf (so an enum resolves via its enum name,
// not the "EnumEntity<E>" ctor name, which has no registered location). "" when unknown.
function packageOf(ctor: Function): string {
    return getLocation(classNameOf(ctor))?.packageName ?? "";
}

// A TypeEntity carrying the given metadata (and optional id) — for generation inserts (no id,
// DB assigns) and sync updates/deletes (id = the persisted row's).
function typeEntityFromMeta(m: { tableName: string; cleanName: string; package: string; className: string }, id?: PrimaryKey): TypeEntity {
    const te = new TypeEntity();
    if (id != null)
        (te as { id: PrimaryKey }).id = id;
    te.tableName = m.tableName;
    te.cleanName = m.cleanName;
    te.package = m.package;
    te.className = m.className;
    return te;
}

// Generation step (Signum's TypeLogic.Schema_Generating): INSERT one row per entity type into
// the TypeEntity table, in the deterministic sorted order, WITHOUT an id (the identity PK is
// DB-assigned — insertSqlSyncGenerated omits it). Per-row statements (not one multi-row VALUES)
// so the identity ids increment in a defined order, matching the bootstrap. Runs after the
// tables exist (pushed onto schema.generating). Reads the rows off the schema it is invoked with.
function generateTypeEntities(schema: Schema): SqlPreCommand | undefined {
    const table = schema.tryTable(TypeEntity as never);
    if (table == null)
        return undefined;
    const cmds = bootstrapMetas(schema).map(m => insertSqlSyncGenerated(table, typeEntityFromMeta(m) as unknown as Entity));
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

    type Meta = { tableName: string; cleanName: string; package: string; className: string };
    const should = new Map<string, Meta>();
    for (const [type, t] of schema.tables)
        if (typeof type === "function")
            should.set(t.name.name, { tableName: t.name.name, cleanName: cleanTypeName(type), package: packageOf(type), className: classNameOf(type) });

    type Cur = { id: PrimaryKey } & Meta;
    const currentByTable = new Map<string, Cur>();
    // Read from the table's OLD name if it was renamed this run (readObjectName). A not-yet-created
    // table (the first sync introducing TypeEntity) yields no current rows, so every type becomes an
    // INSERT that runs after the CREATE emitted earlier in this same script. Any OTHER read failure
    // propagates to Schema.synchronizationScript, which comments it out (so it surfaces).
    const readName = readObjectName(table, replacements);
    if (await existsTable(readName)) {
        const cols = [pkCol, col("tableName"), col("cleanName"), col("package"), col("className")];
        const rows = await connector.executeQuery(
            `SELECT ${cols.map(c => sqlBuilder.sqlEscape(c)).join(", ")} FROM ${sqlBuilder.objectName(readName)}`,
        ) as Record<string, unknown>[];
        for (const r of rows) {
            const tableName = String(r[col("tableName")]);
            currentByTable.set(tableName, {
                id: r[pkCol] as PrimaryKey,
                tableName,
                cleanName: String(r[col("cleanName")]),
                package: r[col("package")] == null ? "" : String(r[col("package")]),
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
            (s.tableName === c.tableName && s.cleanName === c.cleanName && s.package === c.package && s.className === c.className)
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
