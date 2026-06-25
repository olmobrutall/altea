import type { Entity, EntityType } from '../../entities/entity';
import type { Table } from './table';

// Registry of all included tables, keyed by entity constructor, with name maps
// for query/serialization lookups. Built by SchemaBuilder. (EntityEvents and
// other runtime hooks are deferred to the save/query milestone.)
export class Schema {
    readonly tables = new Map<EntityType, Table>();
    readonly nameToType = new Map<string, EntityType>();
    readonly typeToName = new Map<EntityType, string>();

    table<T extends Entity>(type: new () => T): Table {
        const table = this.tables.get(type as unknown as EntityType);
        if (table == null)
            throw new Error(`Type '${type.name}' is not included in the schema`);
        return table;
    }

    tryTable(type: EntityType): Table | undefined {
        return this.tables.get(type);
    }
}
