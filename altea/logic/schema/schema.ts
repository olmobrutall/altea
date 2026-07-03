import type { Entity, Type } from '../../entities/entity';
import { typeConstructor } from '../../entities/entity';
import { SqlPreCommand, Spacing } from '../sync/sqlPreCommand';
import { installDefaultGenerating } from '../sync/schemaGenerator';
import type { Table } from './table';
import { ViewBuilder } from './viewBuilder';

// A step in the generation pipeline: given the schema, contributes a piece of the
// create script, or nothing. Combined in registration order by generationScript().
// Taking the schema as a parameter avoids each handler capturing it in a closure.
export type GeneratingHandler = (schema: Schema) => SqlPreCommand | undefined;

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

    constructor() {
        installDefaultGenerating(this);
    }

    // Combines every registered generating step into the full create script.
    // Requires an active Connector (the steps read its dialect SqlBuilder).
    // Returns undefined when the schema is empty.
    generationScript(): SqlPreCommand | undefined {
        return SqlPreCommand.combine(Spacing.Triple, ...this.generating.map(h => h(this)));
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
            table = new ViewBuilder().newView(key);
            this.views.set(key, table);
        }
        return table;
    }
}
