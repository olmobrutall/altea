import type { Entity, Type, PrimaryKey } from '../../entities/entity';
import type { TypeEntity } from '../../entities/typeEntity';
import { typeConstructor } from '../../entities/entity';
import { SqlPreCommand, Spacing } from '../sync/sqlPreCommand';
import { installDefaultGenerating } from '../sync/schemaGenerator';
import { synchronizeSchemasScript, synchronizeTablesScript, synchronizeEnumsScript } from '../sync/schemaSynchronizer';
import type { Replacements } from '../sync/synchronizer';
import { SchemaAssets } from '../sync/schemaAssets';
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

    // Type-discriminator caches (Signum's TypeLogic caches, held per-schema instead of
    // in process-global statics so multiple schemas can coexist in one process — e.g.
    // the offline binder tests, or a `--test-isolation=none` run). Populated by
    // TypeLogic.start() from SchemaBuilder.complete(); read via the active connector's
    // schema (Connector.current().schema) during query translation / materialisation.
    readonly typeToIdMap = new Map<Function, PrimaryKey>();
    readonly idToTypeMap = new Map<PrimaryKey, Function>();
    readonly idToEntityMap = new Map<PrimaryKey, TypeEntity>();
    readonly typeRows: { id: PrimaryKey; tableName: string; cleanName: string; namespace: string; className: string }[] = [];

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
        for (const handler of this.synchronizing)
            parts.push(await handler(replacements));
        return SqlPreCommand.combine(Spacing.Triple, ...parts);
    }

    table<T extends Entity>(type: Type<T>): Table {
        const table = this.tables.get(type as unknown as Type<Entity>);
        if (table == null)
            throw new Error(`Type '${typeConstructor(type).name}' is not included in the schema`);
        return table;
    }

    tryTable(type: Type<Entity>): Table | undefined {
        return this.tables.get(type);
    }

    // Raw database views (Signum's IView), built lazily by ViewBuilder and cached — the
    // analogue of Signum's Schema.View<T>(). A view is not `include`d like an entity; it is
    // materialised on first use (by Database.view / the binder's view source, or when a
    // @quoted navigation references another view).
    readonly views = new Map<Type<Entity>, Table>();

    view<T extends Entity>(type: Type<T>): Table {
        const key = type as unknown as Type<Entity>;
        let table = this.views.get(key);
        if (table == null) {
            // Pass `this` so a temp-table view's FK column can resolve its target entity's
            // already-built Table (catalog views ignore it — they map scalar columns only).
            table = new ViewBuilder(this).newView(key);
            this.views.set(key, table);
        }
        return table;
    }
}
