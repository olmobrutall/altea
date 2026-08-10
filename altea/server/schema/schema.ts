import type { Entity, Type, View, ViewType } from '../../data/entity';
import type { ResetLazy } from '../../data/resetLazy';
import type { TypeCaches, TypeRow } from '../typeLogic';
import { SqlPreCommand, Spacing } from '../sync/sqlPreCommand';
import { commentedError } from '../sync/syncTableRead';
import { installDefaultGenerating } from '../sync/schemaGenerator';
import { synchronizeSchemasScript, synchronizeTablesScript, synchronizeEnumsScript } from '../sync/schemaSynchronizer';
import type { Replacements } from '../sync/synchronizer';
import { SchemaAssets } from '../sync/schemaAssets';
import { EntityEvents, type QueryFilterContext } from './entityEvents';
import type { Table } from './table';
import { ViewBuilder } from './viewBuilder';

// A step in the generation pipeline: given the schema, contributes a piece of the
// create script, or nothing. Combined in registration order by generationScript().
// Taking the schema as a parameter avoids each handler capturing it in a closure.
export type GeneratingHandler = (schema: Schema) => SqlPreCommand | undefined;

// A step in the synchronization pipeline (mirrors Signum's Schema.Synchronizing). Given the
// user's rename Replacements, contributes a piece of the migration script, or nothing. Async
// because the steps introspect the live database (the IView catalog readers). The default
// steps (schemas → tables/columns/FKs → enum rows) are seeded in the Schema constructor; apps
// may push more.
export type SynchronizingHandler = (replacements: Replacements) => Promise<SqlPreCommand | undefined>;

// Shared empty context — the common case (no row-security provider registered), so translation allocates
// nothing and every `filterContext.get(...)` simply misses.
const EMPTY_QUERY_FILTER_CONTEXT: QueryFilterContext = new Map();

// Registry of all included tables, keyed by entity constructor, with name maps
// for query/serialization lookups. Built by SchemaBuilder. (EntityEvents and
// other runtime hooks are deferred to the save/query milestone.)
export class Schema {
    readonly tables = new Map<Type<Entity>, Table>();
    readonly nameToType = new Map<string, Type<Entity>>();
    readonly typeToName = new Map<Type<Entity>, string>();

    // Generation event chain (mirrors Signum's Schema.Generating). Seeded with
    // the default schema/table/FK steps; apps may push more (e.g. seed data).
    readonly generating: GeneratingHandler[] = [];

    // Synchronization event chain (mirrors Signum's Schema.Synchronizing). Seeded with the
    // default schema / tables-columns-FKs / enum-row steps; apps may push more. The step
    // functions import the IView catalog readers, but only reference Schema as a *type*, so
    // wiring them here is cycle-free.
    readonly synchronizing: SynchronizingHandler[] = [];

    // The schema's Views + stored procedures / user-defined functions (Signum's Schema.Assets).
    // Apps register assets on it (IncludeView / IncludeUserDefinedFunction / IncludeStoreProcedure)
    // and its four schema_* methods are wired into the generating / synchronizing pipelines below,
    // in Signum's order: procedures-before-tables FIRST in generating, views + procedures LAST;
    // the same before/after split in synchronizing.
    readonly assets = new SchemaAssets();

    // Type-discriminator caches (Signum's TypeLogic typeCachesLazy, held per-schema instead of
    // in process-global statics so multiple schemas can coexist in one process — e.g. the
    // offline binder tests, or a `--test-isolation=none` run). Installed by TypeLogic.start()
    // from SchemaBuilder.complete(); read via the active connector's schema
    // (Connector.current().schema) during query translation / materialisation. The lazy
    // projects `typeRowsSnapshot` — the TypeEntity rows read back from the DB by
    // TypeLogic.load() — or, before any load, a deterministic bootstrap. See typeLogic.ts.
    typeCaches!: ResetLazy<TypeCaches>;
    typeRowsSnapshot?: TypeRow[];

    // Per-entity-type engine hooks (Signum's Schema.EntityEvents<T>()), lazily created per ctor.
    // A module registers handlers in its start(); the engine fires them from the relevant path
    // (currently only PreDeleteSqlSync, from the sync delete — see save.ts deleteSqlSync).
    private readonly entityEventsMap = new Map<Function, EntityEvents<Entity>>();

    entityEvents<T extends Entity>(ctor: Type<T>): EntityEvents<T> {
        let ee = this.entityEventsMap.get(ctor);
        if (ee == null)
            this.entityEventsMap.set(ctor, ee = new EntityEvents<Entity>());
        return ee as unknown as EntityEvents<T>;
    }

    // Async row-security context providers (a module's on-demand equivalent of Signum's always-warm
    // FilterQuery caches). A module (e.g. altea-auth) registers one under its own key; the engine awaits
    // ALL of them just before translating each query (buildQueryFilterContext) and hands the resulting
    // opaque QueryFilterContext to the sync `queryFilter` handlers, which read their own key back. Keeping
    // the load HERE (once per query, async) means no cache has to be kept permanently warm.
    readonly queryFilterProviders = new Map<string, () => Promise<unknown>>();

    async buildQueryFilterContext(): Promise<QueryFilterContext> {
        if (this.queryFilterProviders.size === 0)
            return EMPTY_QUERY_FILTER_CONTEXT;
        const ctx = new Map<string, unknown>();
        for (const [key, provider] of this.queryFilterProviders)
            ctx.set(key, await provider());
        return ctx;
    }

    constructor() {
        installDefaultGenerating(this);
        // Assets.Schema_GeneratingBeforeTables runs BEFORE the table steps (a UDF a table may
        // reference must exist first), Assets.Schema_Generating LAST — mirroring Signum's
        // Generating chain order. installDefaultGenerating seeded [schemas, tables, indices,
        // enums]; splice the before-tables handler in front and append the after handler.
        this.generating.unshift(() => this.assets.schema_GeneratingBeforeTables());
        this.generating.push(() => this.assets.schema_Generating());

        // Assets.Schema_SynchronizingBeforeTables FIRST, Assets.Schema_Synchronizing LAST —
        // mirroring Signum's Synchronizing chain order.
        this.synchronizing.push(
            r => this.assets.schema_SynchronizingBeforeTables(r),
            synchronizeSchemasScript, synchronizeTablesScript, synchronizeEnumsScript,
            r => this.assets.schema_Synchronizing(r),
        );
    }

    // Combines every registered generating step into the full create script.
    // Requires an active Connector (the steps read its dialect SqlBuilder).
    // Returns undefined when the schema is empty.
    generationScript(): SqlPreCommand | undefined {
        return SqlPreCommand.combine(Spacing.Triple, ...this.generating.map(h => h(this)));
    }

    // Combines every registered synchronizing step into the full migration script (Signum's
    // Schema.SynchronizationScript). Requires an active Connector (the steps introspect it).
    // Returns undefined when the database already matches the model.
    async synchronizationScript(replacements: Replacements): Promise<SqlPreCommand | undefined> {
        const parts: (SqlPreCommand | undefined)[] = [];
        // Signum's SynchronizationScript wraps each synchronizing step: a thrown error becomes a
        // COMMENTED-OUT command (so the rest of the script still generates and the error is visible)
        // instead of aborting the whole synchronization. The user re-runs sync after applying the script.
        for (let i = 0; i < this.synchronizing.length; i++) {
            try {
                parts.push(await this.synchronizing[i](replacements));
            } catch (e) {
                parts.push(commentedError(`synchronizing step #${i}`, e));
            }
        }
        return SqlPreCommand.combine(Spacing.Triple, ...parts);
    }

    // Signum's `Schema.Initialize()` (+ the `Initializing` event). Run AFTER the database has been
    // generated / synchronized to load whatever the engine reads back from it. Modules subscribe by
    // pushing onto `initializing` (Signum's `Schema.Initializing +=`); the core step — loading the
    // TypeEntity id caches — is registered by `TypeLogic.start` (so Schema stays decoupled from
    // TypeLogic). Hosts call `schema.initialize()` instead of `TypeLogic.load(schema)` directly.
    readonly initializing: ((schema: Schema) => void | Promise<void>)[] = [];
    async initialize(): Promise<void> {
        for (const h of this.initializing)
            await h(this);
    }

    table<T extends Entity>(type: Type<T>): Table {
        const table = this.tables.get(type as unknown as Type<Entity>);
        if (table == null)
            throw new Error(`Type '${type.name}' is not included in the schema`);
        return table;
    }

    tryTable(type: Type<Entity>): Table | undefined {
        return this.tables.get(type);
    }

    // Raw database views (Signum's IView), built lazily by ViewBuilder and cached — the
    // analogue of Signum's Schema.View<T>(). A view is not `include`d like an entity; it is
    // materialised on first use (by Database.view / the binder's view source, or when a
    // @quoted navigation references another view).
    readonly views = new Map<ViewType, Table>();

    view<T extends View>(type: ViewType<T>): Table {
        let table = this.views.get(type);
        if (table == null) {
            // Pass `this` so a temp-table view's FK column can resolve its target entity's
            // already-built Table (catalog views ignore it — they map scalar columns only).
            table = new ViewBuilder(this).newView(type);
            this.views.set(type, table);
        }
        return table;
    }
}
