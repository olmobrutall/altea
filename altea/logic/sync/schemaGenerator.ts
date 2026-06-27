import { Connector } from '../connection/connector';
import { SchemaName } from '../schema/objectName';
import type { Schema } from '../schema/schema';
import { SqlPreCommand, Spacing } from './sqlPreCommand';
import { getBoundEnum, enumEntityMembers } from '../../entities/enumEntity';

// Builds the database-creation script from an in-memory Schema. Mirrors Signum's
// SchemaGenerator, scoped to what the current schema model supports: named
// schemas, CREATE TABLE, and foreign keys. (Enum side-tables, the Type table,
// indexes, and system-versioning are not modelled yet, so their generation
// steps are intentionally absent.)
//
// Each step reads the dialect-specific SqlBuilder from the ambient
// Connector.current(), so a connector must be active when generationScript()
// runs (set Connector.default or wrap in Connector.withConnector).

// CREATE SCHEMA for every distinct non-default schema referenced by a table.
export function createSchemasScript(schema: Schema): SqlPreCommand | undefined {
    const sqlBuilder = Connector.current().sqlBuilder;

    const seen = new Set<string>();
    const schemas: SchemaName[] = [];
    for (const table of schema.tables.values()) {
        const sn = table.name.schema;
        if (sn.name !== '' && !seen.has(sn.name)) {
            seen.add(sn.name);
            schemas.push(sn);
        }
    }

    return SqlPreCommand.combine(Spacing.Simple, ...schemas.map(sn => sqlBuilder.createSchema(sn)));
}

// CREATE TABLE for every table, then ALTER TABLE ADD FOREIGN KEY for every FK.
// Tables come first as a block so all of them exist before any FK references
// them (handles self- and mutual references).
export function createTablesScript(schema: Schema): SqlPreCommand | undefined {
    const sqlBuilder = Connector.current().sqlBuilder;
    const tables = [...schema.tables.values()];

    const createTables = SqlPreCommand.combine(Spacing.Double, ...tables.map(t => sqlBuilder.createTableSql(t)));
    const foreignKeys = SqlPreCommand.combine(Spacing.Double, ...tables.map(t => sqlBuilder.alterTableForeignKeys(t)));

    return SqlPreCommand.combine(Spacing.Triple, createTables, foreignKeys);
}

// INSERT one row per member into each EnumEntity<T> table. Runs after the tables
// (and FKs) exist; enum tables have no incoming FK so order among them is free.
export function createEnumValuesScript(schema: Schema): SqlPreCommand | undefined {
    const sqlBuilder = Connector.current().sqlBuilder;
    const cmds = [...schema.tables.values()].map(t => {
        const enumObject = getBoundEnum(t.type);
        return enumObject == null ? undefined : sqlBuilder.insertEnumValues(t, enumEntityMembers(enumObject));
    });
    return SqlPreCommand.combine(Spacing.Double, ...cmds);
}

// Seeds a schema's `generating` event with the default steps. Called from the
// Schema constructor so every schema can produce a generation script once a
// connector is active. Apps may push extra handlers (e.g. seed data) afterwards.
export function installDefaultGenerating(schema: Schema): void {
    // Each handler takes the schema as its argument (GeneratingHandler), so they
    // can be registered directly rather than wrapped in schema-capturing closures.
    schema.generating.push(createSchemasScript, createTablesScript, createEnumValuesScript);
}
