import { Entity, typeConstructor } from '../entities/entity';
import type { Type, PrimaryKey } from '../entities/entity';
import { cleanTypeName } from '../entities/registration';
import { referenceKey } from '../entities/changes';
import { Lite } from '../entities/lite';
import { Temporal } from '../entities/basics';
import { Connector } from './connection/connector';
import type { IColumn } from './schema/column';
import type { Table } from './schema/table';
import {
    Field,
    FieldValue,
    FieldEnum,
    FieldTicks,
    FieldPrimaryKey,
    FieldReference,
    FieldImplementedBy,
    FieldImplementedByAll,
    FieldEmbedded,
    FieldEntityArray,
} from './schema/field';
import { SqlPreCommandSimple, SqlParameter } from './sync/sqlPreCommand';

// Low-level, single-row persistence: the SQL that writes ONE entity's row. The
// graph orchestration (ordering, cascade of owned child rows, change detection,
// integrity, transaction, re-baselining) lives in ./saver, which calls these. They
// read the active database from the ambient connector (Connector.current()), find
// the entity's Table in that connector's schema, and emit parameterized,
// dialect-aware SQL (RETURNING vs OUTPUT for the new id).
//
// Scope (matches the schema model): value/enum/ticks columns, single & embedded
// references, and @implementedBy. @implementedByAll writes its id but can only
// approximate the type discriminator as the clean type *name* (there is no Type
// table yet to map it to an int). Child arrays (@backReference) carry no columns of
// their own here — ./saver persists them as their own rows.

interface ColumnValue {
    column: IColumn;
    value: unknown;
}

// INSERTs a new entity (no id yet), assigning the database-generated id and
// clearing isNew. Returns nothing — the caller re-baselines after the graph commits.
export async function insertEntityRow(entity: Entity): Promise<void> {
    const connector = Connector.current();
    const table = connector.schema.table(entity.constructor as Type<Entity>);
    const assignments = collectAssignments(table, entity);

    const rows = await buildInsert(table, assignments).executeQuery();
    const idColumn = table.primaryKey.column.name;
    const row = rows[0] as Record<string, unknown> | undefined;
    entity.id = (row?.[idColumn] ?? row?.['id']) as PrimaryKey;
    // The row was written with ticks = 0 (collectAssignments), so the in-memory
    // concurrency token starts there too.
    if (table.ticks != null)
        entity.ticks = 0;
    entity.isNew = false;
}

// UPDATEs an existing entity in place. Enforces optimistic concurrency when the
// table has a ticks column: the row is written with ticks = old + 1 guarded by
// `WHERE id = ? AND ticks = old`, so a row modified or deleted by someone else
// since this entity was retrieved matches zero rows and raises ConcurrencyException.
export async function updateEntityRow(entity: Entity): Promise<void> {
    const connector = Connector.current();
    const table = connector.schema.table(entity.constructor as Type<Entity>);
    const assignments = collectAssignments(table, entity);

    if (table.ticks == null) {
        await buildUpdate(table, assignments, entity.id).executeNonQuery();
        return;
    }

    const oldTicks = entity.ticks ?? 0;
    const newTicks = oldTicks + 1;
    for (const a of assignments)
        if (a.column === table.ticks.column) a.value = newTicks;

    const affected = await buildUpdate(table, assignments, entity.id, {
        column: table.ticks.column,
        value: oldTicks,
    }).executeNonQuery();

    if (affected === 0)
        throw new ConcurrencyException(entity);

    entity.ticks = newTicks;
}

// Raised when an UPDATE's optimistic-concurrency guard matches no row — the entity
// was changed or deleted by another transaction since it was loaded. Port of
// Signum's ConcurrencyException.
export class ConcurrencyException extends Error {
    constructor(public readonly entity: Entity) {
        super(`Concurrency error: ${entity.constructor.name} (id ${String(entity.id)}) was modified or deleted since it was retrieved.`);
        this.name = 'ConcurrencyException';
    }
}

// ---- Value extraction ------------------------------------------------------

// Flattens every (non-PK) field's column values for this entity, including mixins.
function collectAssignments(table: Table, entity: Entity): ColumnValue[] {
    const out: ColumnValue[] = [];

    for (const ef of Object.values(table.fields)) {
        if (ef.field instanceof FieldPrimaryKey)
            continue; // id is handled separately (identity insert / WHERE clause)
        pushFieldValues(ef.field, ef.getter(entity), out);
    }

    for (const mixin of Object.values(table.mixins))
        for (const ef of Object.values(mixin.fields))
            pushFieldValues(ef.field, ef.getter(entity), out);

    return out;
}

function pushFieldValues(field: Field, value: unknown, out: ColumnValue[]): void {
    // Child arrays (@backReference) live in the child's table — no parent column.
    if (field instanceof FieldEntityArray)
        return;

    // FieldTicks / FieldEnum extend FieldValue, so test them first.
    if (field instanceof FieldTicks) {
        out.push({ column: field.column, value: value ?? 0 });
        return;
    }
    if (field instanceof FieldEnum) {
        out.push({ column: field.column, value: value == null ? null : String(value) });
        return;
    }
    if (field instanceof FieldValue) {
        out.push({ column: field.column, value: normalizeScalar(value) });
        return;
    }

    if (field instanceof FieldReference) {
        out.push({ column: field.column, value: referenceId(value) });
        return;
    }

    if (field instanceof FieldImplementedBy) {
        for (const col of field.implementationColumns) {
            const matches = value != null && entityConstructorOf(value) === col.referenceTable!.type;
            out.push({ column: col, value: matches ? referenceId(value) : null });
        }
        return;
    }

    if (field instanceof FieldImplementedByAll) {
        out.push({ column: field.idColumn, value: value == null ? null : referenceId(value as Lite<Entity> | Entity) });
        // NOT YET: a Type table to map the target type to an int id; the clean
        // type name is written as a best-effort discriminator.
        out.push({ column: field.typeColumn, value: value == null ? null : cleanTypeName(entityConstructorOf(value)) });
        return;
    }

    if (field instanceof FieldEmbedded) {
        const present = value != null;
        if (field.hasValue != null)
            out.push({ column: field.hasValue, value: present });
        for (const ef of Object.values(field.embeddedFields))
            pushFieldValues(ef.field, present ? ef.getter(value) : null, out);
        return;
    }
}

// Primitives pass through; Date is left as-is for the driver. Temporal values are
// formatted to dialect-portable strings: datetime/time are capped at millisecond
// precision (Temporal's native nanoseconds overflow SQL Server's datetime2(7)), and
// a Duration is rendered as a clock time HH:MM:SS — the literal both a SQL Server
// `time` and a Postgres `interval` accept ("PT4M54S" is rejected by SQL Server).
function normalizeScalar(value: unknown): unknown {
    if (value == null) return null;
    if (value instanceof Date) return value;

    if (value instanceof Temporal.PlainDate) return value.toString();
    if (value instanceof Temporal.PlainDateTime) return value.toString({ fractionalSecondDigits: 3 });
    if (value instanceof Temporal.PlainTime) return value.toString({ fractionalSecondDigits: 3 });
    if (value instanceof Temporal.ZonedDateTime) return value.toString({ fractionalSecondDigits: 3 });
    if (value instanceof Temporal.Instant) return value.toString({ fractionalSecondDigits: 3 });
    if (value instanceof Temporal.Duration) {
        const total = Math.floor(Math.abs(value.total('seconds')));
        const hh = String(Math.floor(total / 3600)).padStart(2, '0');
        const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
        const ss = String(total % 60).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    if (typeof value === 'object') return String(value); // Decimal & friends
    return value;
}

// The primary-key id behind a reference (full Entity or Lite). Delegates to the
// shared helper so the save path and the snapshot projection agree — notably on
// fat lites of new entities, whose live id is read rather than the null captured
// at lite creation.
function referenceId(value: unknown): PrimaryKey | null {
    return referenceKey(value as Lite<Entity> | Entity | null);
}

function entityConstructorOf(value: unknown): Function {
    if (value instanceof Lite) return typeConstructor(value.entityType);
    return (value as object).constructor;
}

// ---- SQL building ----------------------------------------------------------

function placeholder(isPostgres: boolean, index: number): string {
    return isPostgres ? `$${index + 1}` : `@p${index}`;
}

function namedParameters(assignments: ColumnValue[], extra?: { value: unknown }): SqlParameter[] {
    const params: SqlParameter[] = assignments.map((a, i) => ({ name: `p${i}`, value: a.value }));
    if (extra != null)
        params.push({ name: `p${assignments.length}`, value: extra.value });
    return params;
}

function buildInsert(table: Table, assignments: ColumnValue[]): SqlPreCommandSimple {
    const sb = Connector.current().sqlBuilder;
    const tableName = sb.objectName(table.name);
    const idCol = sb.sqlEscape(table.primaryKey.column.name);

    if (assignments.length === 0) {
        const sql = sb.isPostgres
            ? `INSERT INTO ${tableName} DEFAULT VALUES RETURNING ${idCol};`
            : `INSERT INTO ${tableName} OUTPUT INSERTED.${idCol} DEFAULT VALUES;`;
        return new SqlPreCommandSimple(sql);
    }

    const cols = assignments.map(a => sb.sqlEscape(a.column.name)).join(', ');
    const values = assignments.map((_, i) => placeholder(sb.isPostgres, i)).join(', ');
    const sql = sb.isPostgres
        ? `INSERT INTO ${tableName} (${cols}) VALUES (${values}) RETURNING ${idCol};`
        : `INSERT INTO ${tableName} (${cols}) OUTPUT INSERTED.${idCol} VALUES (${values});`;
    return new SqlPreCommandSimple(sql, namedParameters(assignments));
}

function buildUpdate(
    table: Table,
    assignments: ColumnValue[],
    id: PrimaryKey,
    concurrency?: { column: IColumn; value: unknown },
): SqlPreCommandSimple {
    const sb = Connector.current().sqlBuilder;
    const tableName = sb.objectName(table.name);
    const idCol = sb.sqlEscape(table.primaryKey.column.name);

    const sets = assignments
        .map((a, i) => `${sb.sqlEscape(a.column.name)} = ${placeholder(sb.isPostgres, i)}`)
        .join(', ');

    const params = namedParameters(assignments, { value: id });
    let where = `${idCol} = ${placeholder(sb.isPostgres, assignments.length)}`;
    if (concurrency != null) {
        where += ` AND ${sb.sqlEscape(concurrency.column.name)} = ${placeholder(sb.isPostgres, assignments.length + 1)}`;
        params.push({ name: `p${assignments.length + 1}`, value: concurrency.value });
    }

    const sql = `UPDATE ${tableName} SET ${sets} WHERE ${where};`;
    return new SqlPreCommandSimple(sql, params);
}
