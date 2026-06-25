import { Decimal, Temporal } from '../../entities/basics';

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

// Default DB type for a value field, derived from its runtime type constructor
// (the result of `@field(() => Type)`) and its `kind` alias (e.g. "int", "long",
// produced by the transformer for branded number aliases). Returns undefined for
// types that aren't plain scalars (entities, embeddeds, enums) — those are
// classified elsewhere by the SchemaBuilder.
export function defaultDbType(typeCtor: unknown, kind: string | undefined): AbstractDbType | undefined {
    switch (kind) {
        case 'int': return new AbstractDbType('int', 'int4');
        case 'long': return new AbstractDbType('bigint', 'int8');
    }

    if (typeCtor === String) return new AbstractDbType('nvarchar', 'varchar');
    if (typeCtor === Boolean) return new AbstractDbType('bit', 'bool');
    if (typeCtor === Number) return new AbstractDbType('float', 'float8');
    if (typeCtor === Date) return new AbstractDbType('datetime2', 'timestamptz');
    if (typeCtor === Decimal) return new AbstractDbType('decimal', 'numeric');

    if (typeCtor === Temporal.PlainDate) return new AbstractDbType('date', 'date');
    if (typeCtor === Temporal.PlainTime) return new AbstractDbType('time', 'time');
    if (typeCtor === Temporal.PlainDateTime) return new AbstractDbType('datetime2', 'timestamp');
    if (typeCtor === Temporal.Instant || typeCtor === Temporal.ZonedDateTime) return new AbstractDbType('datetimeoffset', 'timestamptz');
    if (typeCtor === Temporal.Duration) return new AbstractDbType('time', 'interval');

    return undefined;
}
