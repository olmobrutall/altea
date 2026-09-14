import "../data/globals"; // Array.prototype.toMap
import { joinRelaxed } from "../data/globals/joinRelaxed";
import { Connector } from "./connection/connector";
import { cleanTypeName, getLocation, enumNameOf, resolveCleanType, legacyClassName } from "../data/registration";
import { TypeEntity } from "../data/typeEntity";
import { quotedFunction } from "./query";
import { ClassType } from "./runtimeTypes";
import { ResetLazy } from "./resetLazy";
import { insertSqlSyncGenerated, updateSqlSync, deleteSqlSync, copyRowFields } from "./save";
import { table as table_ } from "./table";
import { existsTable } from "./sync/syncTableRead";
import { Administrator } from "./Administrator";
import { StartParameters } from "../data/utils/startParameters";
import { isPartType } from "../data/propertyRoute";
import { Synchronizer, Replacements } from "./sync/synchronizer";
import { ObjectName, SchemaName, defaultDatabaseName } from "./schema/objectName";
import { ImplementedByAllTypeColumn } from "./schema/column";
import type { Entity, PrimaryKey } from "../data/entity";
import type { Schema } from "./schema/schema";
import type { Table } from "./schema/table";
import { SqlPreCommand, SqlPreCommandSimple, Spacing } from "./sync/sqlPreCommand";

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
// lazy for that very query.
//
// Which is why there is NO synchronous `TypeLogic.typeToId`: it would be a read that silently depends on
// somebody else having loaded the caches, and on nothing having reloaded them since (a sync inserts a type
// and `load()` re-reads, under a running process). Every reader instead awaits `caches()` and, when it has
// synchronous work to do — a query visitor, the Retriever's per-row projector, the save path's
// discriminator — carries the resolved {@link TypeCaches} into it. Generation needs no ids at all
// (`bootstrapMetas` gives the insert order); `schema.initialize()` still loads the caches eagerly, which is
// where a database that does not match the model says so. Divergences vs Signum are limited to this module
// (and the identity-vs-seeded PK toggle in SchemaBuilder).

/**
 * The bidirectional type↔id caches (Signum's TypeCaches), projected from the TypeEntity rows. Held behind
 * the schema's ResetLazy, and — this is the point — RESOLVED AND PASSED to whoever needs it.
 *
 * The ids can change under a running process (a sync inserts a type, `load()` re-reads), so no consumer
 * may read them from an ambient static that happens to be warm: every reader either awaits
 * `TypeLogic.caches()` or takes this object as a parameter. A synchronous reader — a query visitor, the
 * Retriever's per-row projector, the save path's discriminator — is handed the SAME snapshot the async
 * boundary above it resolved, so one query or one save cannot straddle two generations of ids.
 */
export class TypeCaches {
    constructor(
        private readonly byType: Map<Function, PrimaryKey>,
        private readonly byId: Map<PrimaryKey, Function>,
        private readonly entityById: Map<PrimaryKey, TypeEntity>,
    ) { }

    /** The discriminator id for an entity type (Signum's TypeToId.GetOrThrow). */
    typeToId(ctor: Function): PrimaryKey {
        const id = this.byType.get(ctor);
        if (id == null)
            throw new Error(`Type '${ctor.name}' is not registered in TypeLogic. Was its table included before SchemaBuilder.complete(), and TypeLogic.load() run after generation/sync?`);
        return id;
    }

    /** The discriminator id, or undefined when the type has no TypeEntity row (Signum's TypeToId.TryGetC)
     *  — for a caller that resolved a type NAME which may not name a persistent type at all. */
    tryTypeToId(ctor: Function): PrimaryKey | undefined {
        return this.byType.get(ctor);
    }

    /** The discriminator id for a type NAME — clean ("Order") or full ("OrderEntity") — or undefined when
     *  the name does not resolve to a persistent type. */
    tryTypeToIdByName(typeName: string): PrimaryKey | undefined {
        const ctor = resolveCleanType(typeName);
        return ctor == null ? undefined : this.tryTypeToId(ctor);
    }

    /** The entity type for a discriminator id, or undefined if unknown (Signum's Schema.GetType / IdToType
     *  — the @implementedByAll materialisation path). */
    tryGetType(id: PrimaryKey | null): Function | undefined {
        return id == null ? undefined : this.byId.get(id);
    }

    getType(id: PrimaryKey): Function {
        const ctor = this.byId.get(id);
        if (ctor == null)
            throw new Error(`No registered entity type for TypeEntity id '${id}'.`);
        return ctor;
    }

    /** The TypeEntity row for a discriminator id (Signum's IdToType + TypeToEntity). */
    idToEntity(id: PrimaryKey): TypeEntity | undefined {
        return this.entityById.get(id);
    }

    /** The TypeEntity row for an entity type, or undefined when it has none. */
    tryTypeToEntity(ctor: Function): TypeEntity | undefined {
        const id = this.byType.get(ctor);
        return id == null ? undefined : this.entityById.get(id);
    }

    /** Every cached TypeEntity row (Signum's `TypeToEntity.Values`). Only rows that JOINED a model type are
     *  here (see projectCaches), so a row left over from a type no longer in the model is absent. */
    allTypeEntities(): TypeEntity[] {
        return [...this.entityById.values()];
    }
}

// The type↔id resolvers used by the LINQ pipeline read an EXPLICITLY-THREADED `TypeCaches` (resolved
// once at the LINQ-provider boundary — `isLoading ? undefined : await ready()`), not the ambient static.
// `undefined` means the caches weren't available (a query bound while they were loading): a discriminator
// (@implementedByAll) can't be resolved there, so `requireTypeId` throws — but the re-entrant
// `table(TypeEntity)` load has no such discriminator, so it never calls this.
export function requireTypeId(caches: TypeCaches | undefined, ctor: Function): PrimaryKey {
    if (caches == null)
        throw new Error(`@implementedByAll for '${ctor.name}' can't be resolved: type caches unavailable (a query bound while they were loading).`);
    return caches.typeToId(ctor);
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

        // The cascade that lets an `@implementedByAll` discriminator carry a real FOREIGN KEY — see
        // deleteImplementedByAllRowsOfType.
        if (!schema.entityEvents(TypeEntity).preDeleteSqlSync.includes(deleteImplementedByAllRowsOfType))
            schema.entityEvents(TypeEntity).preDeleteSqlSync.push(deleteImplementedByAllRowsOfType);
    }

// THE way to read the type↔id caches (Signum's typeCachesLazy.Value): await them, then pass the
    // resolved {@link TypeCaches} to whatever synchronous code needs it. There is no synchronous static
    // twin on purpose — one would silently depend on somebody else having loaded the caches first, and on
    // them not having been reloaded since. `schema` defaults to the active connection's schema.
    static caches(schema: Schema = this.schema): Promise<TypeCaches> {
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
    const modelTypes = typedTables(schema).map(([type]) => type);

    const typeToId = new Map<Function, PrimaryKey>();
    const idToType = new Map<PrimaryKey, Function>();
    const idToEntity = new Map<PrimaryKey, TypeEntity>();

    if (rows.length === 0)
        return new TypeCaches(typeToId, idToType, idToEntity);

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

    return new TypeCaches(typeToId, idToType, idToEntity);
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
    try {
        return await table_(TypeEntity).toArray() as TypeEntity[];
    } catch (e) {
        // The table EXISTS but its SHAPE trails the code — a column this model reads is not there (the case
        // a database generated by another schema generation lands in: Signum's TypeEntity.Namespace where
        // altea reads `package`). That is a database MISMATCH, not a fault, so it goes through
        // StartParameters: the strict default (the web host) still throws with "Consider Synchronize", and
        // tolerant startup COLLECTS it — the mode the terminal enables precisely so `sync`, the tool that
        // repairs this, can boot at all. Empty caches cost nothing on that path: `synchronizeTypes` re-reads
        // the rows itself through `Administrator.tryRetrieveAll`, which by then knows the column renames the
        // table sync learned this run.
        StartParameters.reportDatabaseMismatch(new Error(
            `Could not read the ${TypeEntity.name} table (${table.name.toString()}) — the database trails the code. Consider Synchronize.`
            + "\n" + ((e as Error)?.message ?? String(e))));
        return [];
    }
}

/**
 * Sweep every `@implementedByAll` row that pointed at a type being REMOVED — Signum's
 * `EntityEvents<TypeEntity>.PreDeleteSqlSync`, and what makes the discriminator column's FOREIGN KEY
 * affordable.
 *
 * An `@implementedByAll` column stores its target's TypeEntity id, so it is an ordinary reference and
 * Signum gives it an ordinary FK (a Southwind database has `fk_alert_target_id_type`,
 * `fk_case_main_entity_id_type`, and fifteen more). altea used to suppress that FK — with the FK in
 * place, a sync that DELETES a type row fails on whichever table still has rows pointing at it, and
 * without this cascade there was nothing to clear them. That left the discriminator dangling instead,
 * which is the worse of the two: a row claiming to point at a type that no longer exists.
 *
 * Signum registers one handler per MODULE (eighteen of them, each naming its own table and field).
 * altea derives it instead: the SCHEMA already knows which columns are discriminators, so one handler
 * covers every table — including the ones a module author would forget, and any the app itself adds.
 * Views are skipped (nothing writes them).
 */
function deleteImplementedByAllRowsOfType(type: TypeEntity): SqlPreCommand | undefined {
    const connector = Connector.current();
    const sqlBuilder = connector.sqlBuilder;
    const commands: SqlPreCommand[] = [];
    for (const table of connector.schema.tables.values()) {
        if (table.isView)
            continue;
        // Read the FLATTENED physical layout, so a discriminator inside an embedded or a mixin counts
        // like any other — that is where several of them live (an alert's target, a view log's).
        for (const column of Object.values(table.columns))
            if (column instanceof ImplementedByAllTypeColumn)
                commands.push(new SqlPreCommandSimple(
                    `DELETE FROM ${sqlBuilder.objectName(table.name)} WHERE ${sqlBuilder.sqlEscape(column.name)} = ${type.id};`));
    }
    return SqlPreCommand.combine(Spacing.Simple, ...commands);
}

/**
 * The tables that get a TypeEntity ROW — the schema's real entity tables (an enum side-table is keyed
 * by a generic descriptor, is never an `@implementedByAll` target, and gets none).
 *
 * LEGACY MODE skips a table that stands in for a Signum MLIST TABLE (`Table.isMListRow`). An MList table
 * is not an entity in Signum: `TypeLogic` enumerates `Schema.Tables`, where MList tables live in a
 * collection of their own, so a Signum database has no row for one — and Signum's
 * `TypeLogic.Schema_Synchronizing` DELETES rows it does not recognise, so the two applications would take
 * turns adding and removing them for as long as both run.
 *
 * A `@part` that is NOT an MList row still gets one in either mode, which is the whole of what
 * `isMListRow` (i.e. `mlistRowOwner`) decides: a part reached through a single reference stands in for a
 * Signum EMBEDDED, and one whose owner declares `@legacyTableName({ wasVirtualMList: true })` stands in
 * for a real ENTITY there — both of which Signum has a type row for.
 *
 * Nothing needs the id: an MList row is never the TARGET of an `@implementedByAll` reference (the only
 * thing that stores a type discriminator), and a property route is rooted at the OWNING entity, never at
 * the row type. This is the same `isMListRow` question legacyMode already answers for Ticks and ToStr —
 * see SchemaSettings.legacyMode.
 *
 * The single source for every consumer, so the caches, the generation order and the sync all agree on
 * which types exist — a model type missing from one of them is reported as a database mismatch.
 */
function typedTables(schema: Schema): [Function, Table][] {
    const entries: [Function, Table][] = [];
    for (const [type, table] of schema.tables)
        if (typeof type === "function" && !(table.legacyMode && table.isMListRow))
            entries.push([type, table]);
    return entries;
}

// The deterministic bootstrap metadata: one entry per {@link typedTables} ctor, sorted by ctor name.
// Generation seeds the rows in this same order so the DB-assigned identity ids match the bootstrap
// 1..N numbering.
type TypeMeta = { tableName: string; cleanName: string; package: string | null; className: string; isPart: boolean };
function bootstrapMetas(schema: Schema): TypeMeta[] {
    const entries = typedTables(schema);
    entries.sort((a, b) => (a[0].name < b[0].name ? -1 : a[0].name > b[0].name ? 1 : 0));
    // Signum's `TableName = SimplifyTableName(tab.Name).ToString()` — the FULL ObjectName, so the
    // column is schema-qualified and its parts are escaped where the dialect needs it
    // (`sms.sms_message`, `public."order"`). `qualifiedName` is what spells the DEFAULT schema out as
    // `public` / `dbo`, which a Signum database also does — a bare `application_configuration` would
    // read as a different table from Signum's `public.application_configuration`, which is exactly the
    // rename a Southwind sync used to offer.
    const sqlBuilder = Connector.current().sqlBuilder;
    return entries.map(([ctor, table]) => ({
        tableName: sqlBuilder.qualifiedName(table.name),
        cleanName: cleanTypeName(ctor),
        package: packageOf(ctor),
        className: classNameOf(ctor),
        // Derived from the MODEL through the one predicate the route rules and the token layer also go
        // through, so the row cannot disagree with them about what a part is — see TypeEntity.isPart.
        isPart: isPartType(ctor),
    }));
}

// The registry NAME of an entity/enum ctor for the TypeEntity.className column + its ctor↔row lookup.
// A closed EnumEntity<E> type's ctor.name is "EnumEntity<OrderState>" — use the bare ENUM name
// ("OrderState") instead (matching cleanName + the name its FileInfo/enum registration is keyed by).
//
// Signum stores `type.Name`, so for a type altea RENAMED the stored name is Signum's class name, not
// altea's — and it is DECLARED (`@legacyClassName`), not derived. It has to be: this column is the one a
// Signum application synchronizes back to its own answer, so guessing it from the clean name plus a kind
// suffix would be a guess about the very value the two applications must agree on.
export function classNameOf(ctor: Function): string {
    const boundEnum = (ctor as { boundEnum?: object }).boundEnum;
    if (boundEnum != null) {
        const enumName = enumNameOf(boundEnum);
        if (enumName != null)
            return enumName;
    }
    const legacy = legacyClassName(ctor);
    if (legacy != null)
        return legacy;
    return ctor.name;
}


// The owning npm package of an entity/enum ctor (Signum's Namespace analog), from the registration
// FileInfo the quote-transformer stamps — keyed by classNameOf (so an enum resolves via its enum name,
// not the "EnumEntity<E>" ctor name, which has no registered location). `null` when unknown: the column
// is nullable (as Signum's is), so "no package" is a NULL rather than an empty string that would read
// as a package named "".
function packageOf(ctor: Function): string | null {
    return getLocation(classNameOf(ctor))?.packageName ?? null;
}

// A TypeEntity carrying the given metadata — the "should" row, id-less: generation and the sync's
// createNew both INSERT it without an id (the identity PK is DB-assigned), and the sync's mergeBoth
// copies its fields onto the RETRIEVED row rather than re-building one around the persisted id.
function typeEntityFromMeta(m: TypeMeta): TypeEntity {
    const te = new TypeEntity();
    te.tableName = m.tableName;
    te.cleanName = m.cleanName;
    te.package = m.package;
    te.className = m.className;
    te.isPart = m.isPart;
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
    const cmds = bootstrapMetas(schema).map(m => insertSqlSyncGenerated(table, typeEntityFromMeta(m)));
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

    // `should` and `current` are both dictionaries of TypeEntity ENTITIES keyed by physical table name
    // (Signum's `Dictionary<string, TypeEntity>`) — the entity is the unit of comparison, so there is no
    // record shape restating its columns.
    const should = bootstrapMetas(schema).map(m => typeEntityFromMeta(m)).toMap(te => te.tableName);

    // Read the current rows as ENTITIES through an ordinary LINQ query — Administrator.tryRetrieveAll
    // temporarily points the in-memory Table at the name the database still uses (a rename learned this
    // run) for the duration of the read. A not-yet-created table (the first sync introducing TypeEntity)
    // yields no current rows, so every type becomes an INSERT that runs after the CREATE emitted earlier in
    // this same script. Any OTHER read failure propagates to Schema.synchronizationScript, which comments
    // it out (so it surfaces).
    const currentByTable = (await Administrator.tryRetrieveAll(TypeEntity, replacements)).toMap(te => te.tableName);

    // Signum seeds the TypeTableName bucket from the TABLE rename map the tables step just resolved
    // (TypeLogic.cs: `replacements.Add(TypeTableName, replacements.TryGetC(KeyTables).SelectDictionary(...))`).
    // A table that MOVED — altea groups tables into per-package schemas, so `queries.filter_operation`
    // becomes `basics.filter_operation` against a Signum database — is already an answered question
    // there; without this it is asked a second time here, and the wrong answer is a delete + insert
    // that re-ids the type and breaks every @implementedByAll discriminator, auth rule and stored Lite
    // pointing at it. Both sides go through the same spelling the column uses (Signum parses and
    // re-renders them for exactly that reason): keyTables holds `ObjectName.toString()`, which leaves
    // the default schema off and escapes nothing.
    const tableRenames = replacements.tryGetC(Replacements.keyTables);
    if (tableRenames != null && tableRenames.size > 0) {
        const asColumn = (raw: string): string => {
            const dot = raw.lastIndexOf(".");
            const schema = dot < 0 ? "" : raw.slice(0, dot);
            const name = dot < 0 ? raw : raw.slice(dot + 1);
            return connector.sqlBuilder.qualifiedName(new ObjectName(name, new SchemaName(schema, defaultDatabaseName)));
        };
        const seeded = new Map([...tableRenames].map(([o, n]) => [asColumn(o), asColumn(n)]));
        const existing = replacements.tryGetC("TypeTableName");
        if (existing != null) for (const [k, v] of seeded) { if (!existing.has(k)) existing.set(k, v); }
        else replacements.set("TypeTableName", seeded);
    }

    // synchronizeScriptReplacing asks which removed table name each new one renames (the
    // "TypeTableName" bucket) and re-keys current by the new name, so a renamed type lands in
    // mergeBoth (metadata UPDATE) rather than a delete+insert — which would re-id it and break
    // its discriminator.
    return Synchronizer.synchronizeScriptReplacing<TypeEntity, TypeEntity>(
        replacements,
        "TypeTableName",
        Spacing.Double,
        should,
        currentByTable,
        (_k, s) => insertSqlSyncGenerated(table, s),
        (_k, c) => deleteSqlSync(table, c),
        (_k, s, c) => {
            // Matched (possibly through a RENAME): write the model metadata onto the RETRIEVED row, which
            // KEEPS its persisted id — that id is the @implementedByAll discriminator stored across the
            // whole database, so it is never re-assigned. updateSqlSync returns undefined when nothing drifted.
            //
            // `namespace` is NOT model metadata — altea never writes one (see TypeEntity) — so it is
            // carried over from the persisted row. Copying the model row wholesale would null out the
            // values a SIGNUM database has, on the first sync, which is exactly what the column is
            // kept to avoid.
            s.namespace = c.namespace;
            // `isPart` is the opposite case and needs no line here: it IS model metadata, DERIVED, so
            // `copyRowFields` copying it wholesale is exactly right — every existing row is rewritten to
            // whatever the model now says, which is what a derived column has to do. (The sync's own
            // ADD COLUMN backfills a temporary `false` first, so the UPDATEs below are what put the true
            // ones back; and the FIRST sync that introduces the column cannot read it at all, so this
            // whole step is commented out of that script — run the sync TWICE and apply the second.)
            copyRowFields(c, s);
            return updateSqlSync(table, c);
        },
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
    // THE one synchronous cache read left in the engine, and it is one because the method's signature is
    // synchronous: a registered expression is written inline in a query lambda. In a query the body never
    // runs (the QueryBinder lowers the call to the TypeEntity table); in memory it can only answer from an
    // already-loaded cache, so it says so rather than inventing an id.
    const caches = Connector.current().schema.typeCaches.valueOrUndefined;
    if (caches == null)
        throw new Error("`toTypeEntity()` ran IN MEMORY before the type↔id caches were loaded."
            + " Inside a query it is translated and needs nothing; in memory, await TypeLogic.caches()"
            + " first (schema.initialize() does) — or read the row through those caches directly.");
    return caches.idToEntity(caches.typeToId(this))!;
};
quotedFunction(Function.prototype.toTypeEntity).__resultType = () => new ClassType(TypeEntity);
