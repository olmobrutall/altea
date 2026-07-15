import { Entity, typeConstructor } from '../entities/entity';
import type { Type, PrimaryKey } from '../entities/entity';
import { TypeLogic } from './typeLogic';
import { getTypeInfo } from '../entities/reflection';
import { referenceKey } from '../entities/changes';
import { Lite } from '../entities/lite';
import { Connector } from './connection/connector';
import { normalizeScalar } from './normalizeScalar';
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
import { SqlPreCommandSimple, type SqlParameter } from './sync/sqlPreCommand';

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

export interface ColumnValue {
    column: IColumn;
    value: unknown;
}

// The entities whose foreign keys must be written as NULL on this row because they are
// not saved yet — the back-edge targets of a save-time reference cycle (Signum's
// `Forbidden`). A later UPDATE pass fills them once those targets have ids. Empty for
// the common acyclic case.
export type Forbidden = ReadonlySet<Entity>;
const NO_FORBIDDEN: Forbidden = new Set<Entity>();

// INSERTs a single new entity. Thin wrapper over the batched path.
export function insertEntityRow(entity: Entity, forbidden: Forbidden = NO_FORBIDDEN): Promise<void> {
    return insertEntityRows([entity], [forbidden]);
}

// INSERTs a group of new entities of the SAME table in one multi-row statement
// (`INSERT INTO t (cols) VALUES (…),(…),… `), the Saver's batching win for collections
// (many part-entity rows of one type at the same dependency level). Two modes, decided by
// whether the database assigns the primary key:
//   - generated (id == null): omit the PK column, read the DB-assigned ids back via
//     RETURNING (pg) / OUTPUT (SS), and map them to the entities BY POSITION (a single
//     multi-row INSERT returns them in VALUES order on both dialects, as Signum relies on);
//   - explicit (id already set — a client/UUID/enum key, "without identity"): write the PK
//     in each tuple and skip the read-back.
// `forbiddens[i]` is entity i's cycle-deferral set (its FK to a not-yet-saved target is
// NULLed, filled later by the Saver's deferred UPDATE). No pre-compiled parameter builder —
// `collectAssignments` reflects per row, which is negligible next to the round-trip.
export async function insertEntityRows(entities: Entity[], forbiddens?: Forbidden[]): Promise<void> {
    if (entities.length === 0) return;
    const connector = Connector.current();
    const table = connector.schema.table(entities[0].constructor as Type<Entity>);
    const generated = entities[0].id == null;

    const rows = entities.map((e, i) => {
        const a = collectAssignments(table, e, forbiddens?.[i] ?? NO_FORBIDDEN);
        return generated ? a : [{ column: table.primaryKey.column, value: e.id }, ...a];
    });

    // No non-PK columns + generated id (e.g. an all-defaults table): can't put two
    // `DEFAULT VALUES` in one statement, so fall back to a single-row insert per entity.
    if (generated && rows[0].length === 0) {
        const idColumn = table.primaryKey.column.name;
        for (const e of entities) {
            const back = await buildInsert(table, []).executeQuery();
            const row = back[0] as Record<string, unknown> | undefined;
            e.id = (row?.[idColumn] ?? row?.['id']) as PrimaryKey;
        }
    } else if (generated) {
        const idColumn = table.primaryKey.column.name;
        const result = await buildInsertMany(table, rows, true).executeQuery() as Record<string, unknown>[];
        entities.forEach((e, i) => {
            const row = result[i];
            e.id = (row?.[idColumn] ?? row?.['id']) as PrimaryKey;
        });
    } else {
        await buildInsertMany(table, rows, false).executeNonQuery();
    }

    // The rows were written with ticks = 0 (collectAssignments), so the in-memory
    // concurrency token starts there too.
    for (const e of entities) {
        if (table.ticks != null)
            e.ticks = 0;
        e.isNew = false;
    }
}

// UPDATEs an existing entity in place. Enforces optimistic concurrency when the
// table has a ticks column: the row is written with ticks = old + 1 guarded by
// `WHERE id = ? AND ticks = old`, so a row modified or deleted by someone else
// since this entity was retrieved matches zero rows and raises ConcurrencyException.
export async function updateEntityRow(entity: Entity, forbidden: Forbidden = NO_FORBIDDEN): Promise<void> {
    const connector = Connector.current();
    const table = connector.schema.table(entity.constructor as Type<Entity>);
    const assignments = collectAssignments(table, entity, forbidden);

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

// ---- Synchronization SQL (single row, no execution) ------------------------
//
// The SQL that INSERTs / UPDATEs / DELETEs one row, returned as a SqlPreCommand rather
// than executed. Used by SchemaSynchronizer.synchronizeEnumsScript (Signum's Table.
// InsertSqlSync / UpdateSqlSync / DeleteSqlSync). Unlike insertEntityRow these write the
// primary key EXPLICITLY (enum ids are fixed values, not identity), and cover every
// column — value/enum/reference/embedded AND mixin columns — via collectAssignments, so an
// enum with a mixin syncs its full row.

// INSERT with an explicit primary key + all columns (incl mixins).
export function insertSqlSync(table: Table, entity: Entity): SqlPreCommandSimple {
    const sb = Connector.current().sqlBuilder;
    const assignments: ColumnValue[] = [{ column: table.primaryKey.column, value: entity.id }, ...collectAssignments(table, entity)];
    const cols = assignments.map(a => sb.sqlEscape(a.column.name)).join(', ');
    const values = assignments.map((_, i) => placeholder(sb.isPostgres, i)).join(', ');
    return new SqlPreCommandSimple(`INSERT INTO ${sb.objectName(table.name)} (${cols}) VALUES (${values});`, namedParameters(assignments));
}

// UPDATE all non-PK columns (incl mixins) of the row WHERE id = entity.id. No optimistic
// concurrency (enum tables have no ticks).
export function updateSqlSync(table: Table, entity: Entity): SqlPreCommandSimple {
    return buildUpdate(table, collectAssignments(table, entity), entity.id);
}

// DELETE the row WHERE id = entity.id.
export function deleteSqlSync(table: Table, entity: Entity): SqlPreCommandSimple {
    const sb = Connector.current().sqlBuilder;
    const idCol = sb.sqlEscape(table.primaryKey.column.name);
    return new SqlPreCommandSimple(
        `DELETE FROM ${sb.objectName(table.name)} WHERE ${idCol} = ${placeholder(sb.isPostgres, 0)};`,
        [{ name: "p0", value: entity.id }]);
}

// The full column-value image of an entity's row (incl PK + mixins), for comparing a
// "should" enum row against the current DB row (→ decide whether an UPDATE is needed).
export function rowImage(table: Table, entity: Entity): Map<string, unknown> {
    const image = new Map<string, unknown>();
    image.set(table.primaryKey.column.name, entity.id);
    for (const a of collectAssignments(table, entity))
        image.set(a.column.name, a.value);
    return image;
}

// ---- Value extraction ------------------------------------------------------

// Flattens every (non-PK) field's column values for this entity, including mixins. Shared by
// the single/batched insert path and the bulk inserter (Signum's Table.BulkInsertDataRow).
export function collectAssignments(table: Table, entity: Entity, forbidden: Forbidden = NO_FORBIDDEN): ColumnValue[] {
    const out: ColumnValue[] = [];

    for (const ef of Object.values(table.fields)) {
        if (ef.field instanceof FieldPrimaryKey)
            continue; // id is handled separately (identity insert / WHERE clause)
        pushFieldValues(ef.field, ef.getter(entity), out, forbidden);
    }

    for (const mixin of Object.values(table.mixins))
        for (const ef of Object.values(mixin.fields))
            pushFieldValues(ef.field, ef.getter(entity), out, forbidden);

    // Pre-saving (Signum's SetToStrField): materialise the display string into the
    // ToStr column so queries can read it without running the JS toString().
    if (table.toStrColumn != null)
        out.push({ column: table.toStrColumn, value: entity.toString() });

    return out;
}

function pushFieldValues(field: Field, value: unknown, out: ColumnValue[], forbidden: Forbidden = NO_FORBIDDEN): void {
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

    // A reference to a not-yet-saved cycle target is written NULL now and filled by the
    // Saver's deferred UPDATE pass (Signum's Forbidden) — treat it as an absent reference.
    if (isForbidden(value, forbidden))
        value = null;

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
        // Write the id into the column matching the target's PK type; NULL the others.
        const ctor = value == null ? undefined : entityConstructorOf(value);
        const valuePk = ctor == null ? undefined : (getTypeInfo(ctor)?.fields["id"]?.columnOptions?.primaryKey ?? "int");
        for (const col of field.idColumns)
            out.push({ column: col, value: (value != null && col.pkType === valuePk) ? referenceId(value as Lite<Entity> | Entity) : null });
        // The discriminator is the target type's TypeEntity id (Signum's TypeToId).
        out.push({ column: field.typeColumn, value: value == null ? null : TypeLogic.typeToId(entityConstructorOf(value)) });
        return;
    }

    if (field instanceof FieldEmbedded) {
        const present = value != null;
        if (field.hasValue != null)
            out.push({ column: field.hasValue, value: present });
        for (const ef of Object.values(field.embeddedFields))
            pushFieldValues(ef.field, present ? ef.getter(value) : null, out, forbidden);
        return;
    }
}

// The entity a reference value points at (a full Entity, or the entity of a fat Lite),
// or undefined for a null / thin-lite reference. Used to test cycle membership.
function referencedEntity(value: unknown): Entity | undefined {
    if (value instanceof Lite) return value.entityOrNull ?? undefined;
    if (value instanceof Entity) return value;
    return undefined;
}

function isForbidden(value: unknown, forbidden: Forbidden): boolean {
    if (forbidden.size === 0) return false;
    const e = referencedEntity(value);
    return e != null && forbidden.has(e);
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

// One multi-row INSERT for a group of same-table rows. Each `rows[k]` is that row's
// column/value list (identical columns and order across rows — collectAssignments is
// deterministic per table). Parameters are flattened p0..pN across all tuples. When
// `generated`, the DB assigns the PK, so add RETURNING (pg) / OUTPUT INSERTED.<pk> (SS) to
// stream the new ids back in row order; otherwise the PK is already in each row's values.
function buildInsertMany(table: Table, rows: ColumnValue[][], generated: boolean): SqlPreCommandSimple {
    const sb = Connector.current().sqlBuilder;
    const tableName = sb.objectName(table.name);
    const idCol = sb.sqlEscape(table.primaryKey.column.name);
    const cols = rows[0].map(a => sb.sqlEscape(a.column.name)).join(', ');

    const params: SqlParameter[] = [];
    let p = 0;
    const tuples = rows
        .map(assignments => {
            const placeholders = assignments.map(a => {
                params.push({ name: `p${p}`, value: a.value });
                return placeholder(sb.isPostgres, p++);
            });
            return `(${placeholders.join(', ')})`;
        })
        .join(', ');

    // Writing an explicit value into a real identity/serial PK needs an override: pg's
    // GENERATED ALWAYS PKs want OVERRIDING SYSTEM VALUE; SQL Server needs SET IDENTITY_INSERT
    // around the statement (mirrors queryFormatter.visitInsertSelect).
    const identityOverride = !generated && table.primaryKey.column.identity;

    let sql = sb.isPostgres
        ? `INSERT INTO ${tableName} (${cols})${identityOverride ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES ${tuples}${generated ? ` RETURNING ${idCol}` : ''};`
        : `INSERT INTO ${tableName} (${cols})${generated ? ` OUTPUT INSERTED.${idCol}` : ''} VALUES ${tuples};`;
    if (identityOverride && !sb.isPostgres)
        sql = `SET IDENTITY_INSERT ${tableName} ON;\n${sql}\nSET IDENTITY_INSERT ${tableName} OFF;`;
    return new SqlPreCommandSimple(sql, params);
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
