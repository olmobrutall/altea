import type { PrimaryKeyType } from '../../entities/reflection';

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

    // Structural equality of two abstract types. Mirrors Signum's AbstractDbType.Equals,
    // which compares whichever underlying dialect type is set. Altea stores both dialect
    // names, so we compare both slots (a DB-read DiffColumn fills both via the reader's
    // reverse mapping, so both are meaningful).
    equals(other: AbstractDbType): boolean {
        return this.sqlServer === other.sqlServer && this.postgres === other.postgres;
    }

    // Type-family predicates — the altea analogue of Signum's AbstractDbType.IsString()/
    // IsDecimal()/… extension methods. Signum reads a single SqlDbType?/NpgsqlDbType?; altea
    // stores both dialect *names*, so each predicate tests membership of the union of both
    // dialects' names for that family. The families are disjoint, so this is dialect-agnostic
    // and needs no ambient Connector (keeping dbType.ts free of the connector import cycle).
    isString(): boolean { return inFamily(this, STRING_TYPES); }
    isBinary(): boolean { return inFamily(this, BINARY_TYPES); }
    isDecimal(): boolean { return inFamily(this, DECIMAL_TYPES); }
    isNumber(): boolean { return inFamily(this, NUMBER_TYPES); }
    isBoolean(): boolean { return inFamily(this, BOOLEAN_TYPES); }
    isDate(): boolean { return inFamily(this, DATE_TYPES); }
    isTime(): boolean { return inFamily(this, TIME_TYPES); }
    isGuid(): boolean { return inFamily(this, GUID_TYPES); }
}

// True when either dialect name of `t` is in `family` (case-insensitive).
function inFamily(t: AbstractDbType, family: Set<string>): boolean {
    return family.has(t.sqlServer.toLowerCase()) || family.has(t.postgres.toLowerCase());
}

const STRING_TYPES = new Set(['nvarchar', 'varchar', 'nchar', 'char', 'text', 'ntext']);
const BINARY_TYPES = new Set(['binary', 'varbinary', 'image', 'bytea']);
const DECIMAL_TYPES = new Set(['decimal', 'numeric', 'money', 'smallmoney']);
// "Number" = every non-decimal numeric type + the decimal ones (Signum's IsNumber is the
// broad numeric family; IsDecimal is the narrow scaled subset).
const NUMBER_TYPES = new Set([
    'int', 'int4', 'bigint', 'int8', 'smallint', 'int2', 'tinyint',
    'float', 'float8', 'real', 'float4',
    'decimal', 'numeric', 'money', 'smallmoney',
]);
const BOOLEAN_TYPES = new Set(['bit', 'bool', 'boolean']);
const DATE_TYPES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'timestamp', 'timestamptz']);
const TIME_TYPES = new Set(['time', 'interval']);
const GUID_TYPES = new Set(['uniqueidentifier', 'uuid']);

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
        // JS `Date` is intentionally unsupported — model temporal columns with
        // Temporal.PlainDateTime / PlainDate / Instant instead. The SchemaBuilder
        // raises a clear error if a Date-typed field is included.
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

// DB type for a primary key, from its declared PrimaryKeyType (@primaryKey).
// uuid / uuid7 share storage (GUID); they differ only in value generation.
export function primaryKeyDbType(type: PrimaryKeyType): AbstractDbType {
    switch (type) {
        case 'int': return new AbstractDbType('int', 'int4');
        case 'long': return new AbstractDbType('bigint', 'int8');
        case 'uuid':
        case 'uuid7': return new AbstractDbType('uniqueidentifier', 'uuid');
    }
}
