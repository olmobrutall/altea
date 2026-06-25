// Fully-qualified database object names: [database].[schema].[name].
// Ported verbatim from the original logic/schema.ts.

export class DatabaseName {
    constructor(
        public readonly name: string,
    ) { }

    toString(): string {
        return this.name;
    }
}

export class SchemaName {
    constructor(
        public readonly name: string,
        public readonly database: DatabaseName,
    ) { }

    toString(): string {
        return this.database.name ? `${this.database.name}.${this.name}` : this.name;
    }
}

export class ObjectName {
    constructor(
        public readonly name: string,
        public readonly schema: SchemaName,
    ) { }

    toString(): string {
        const schemaStr = this.schema.toString();
        return schemaStr ? `${schemaStr}.${this.name}` : this.name;
    }
}

// The "default" schema: empty schema/database names mean "current schema of the
// connection". SchemaSettings can override the default schema name later.
export const defaultDatabaseName = new DatabaseName('');
export const defaultSchemaName = new SchemaName('', defaultDatabaseName);
