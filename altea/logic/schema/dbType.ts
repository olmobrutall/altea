// Whether a column accepts NULL. `Forced` mirrors Signum: the object-model
// property is non-null, but the column is nullable in the DB because it lives
// under a nullable embedded (so the whole group can be absent).
export enum IsNullable {
    No = 'No',
    Yes = 'Yes',
    Forced = 'Forced',
}

export function isNullableToBool(n: IsNullable): boolean {
    return n !== IsNullable.No;
}

// Holds a column's SQL type for each supported dialect. Mirrors Signum's
// AbstractDbType (which wraps SqlDbType? + NpgsqlDbType?) but stores plain type
// names, since DDL emission lives in a later milestone. Both dialects are kept
// side by side so the future generator can pick per target.
export class AbstractDbType {
    constructor(
        public readonly sqlServer: string,
        public readonly postgres: string,
    ) { }

    toString(): string {
        return `${this.sqlServer} / ${this.postgres}`;
    }
}

// Default DB type for a value field, derived from its runtime type *name* (the
// `typeName` emitted by the transformer, e.g. "Number", "Date", "Decimal",
// "PlainDate") and its `kind` alias (e.g. "int", "long", for branded number
// aliases). Returns undefined for names that aren't plain scalars (entities,
// embeddeds) — those are classified elsewhere by the SchemaBuilder, which
// resolves the name to a constructor. Enums are handled via FieldInfo.isEnum.
export function defaultDbType(typeName: string, kind: string | undefined): AbstractDbType | undefined {
    switch (kind) {
        case 'int': return new AbstractDbType('int', 'int4');
        case 'long': return new AbstractDbType('bigint', 'int8');
    }

    switch (typeName) {
        case 'String': return new AbstractDbType('nvarchar', 'varchar');
        case 'Boolean': return new AbstractDbType('bit', 'bool');
        case 'Number': return new AbstractDbType('float', 'float8');
        case 'Date': return new AbstractDbType('datetime2', 'timestamptz');
        case 'Decimal': return new AbstractDbType('decimal', 'numeric');
        // Temporal.* — keyed by the rightmost name the transformer emits.
        case 'PlainDate': return new AbstractDbType('date', 'date');
        case 'PlainTime': return new AbstractDbType('time', 'time');
        case 'PlainDateTime': return new AbstractDbType('datetime2', 'timestamp');
        case 'Instant':
        case 'ZonedDateTime': return new AbstractDbType('datetimeoffset', 'timestamptz');
        case 'Duration': return new AbstractDbType('time', 'interval');
    }

    return undefined;
}
