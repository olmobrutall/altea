import { Entity } from '../entities/entity';
import type { EntityType, PrimaryKey } from '../entities/entity';
import { Lite } from '../entities/lite';
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

// Real Entity.save(), added to the prototype here in logic/ (the entities package
// only declares the shape — persistence is server-only). save() takes no
// arguments: it reads the active database from the ambient connector
// (Connector.current()), finds this entity's Table in that connector's schema,
// and either INSERTs it (new — no id yet) or UPDATEs it (existing id). The
// generated SQL is parameterized and dialect-aware (RETURNING vs OUTPUT for the
// new id), executed through the SqlPreCommand convenience methods.
//
// Scope (matches the schema model): value/enum/ticks columns, single & embedded
// references, and @implementedBy. @implementedByAll writes its id but can only
// approximate the type discriminator as the clean type *name* (there is no Type
// table yet to map it to an int). Child arrays (@backReference) carry no columns,
// so they are saved as their own rows by the caller, not cascaded from here.

declare module '../entities/entity' {
    interface Entity {
        save(): Promise<void>;
    }
}

interface ColumnValue {
    column: IColumn;
    value: unknown;
}

Entity.prototype.save = async function (this: Entity): Promise<void> {
    const connector = Connector.current();
    const table = connector.schema.table(this.constructor as EntityType);
    const assignments = collectAssignments(table, this);

    if (this.id == null) {
        const rows = await buildInsert(table, assignments).executeQuery();
        const idColumn = table.primaryKey.column.name;
        const row = rows[0] as Record<string, unknown> | undefined;
        this.id = (row?.[idColumn] ?? row?.['id']) as PrimaryKey;
        this.isNew = false;
    } else {
        await buildUpdate(table, assignments, this.id).executeNonQuery();
    }
};

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
        out.push({ column: field.idColumn, value: value == null ? null : referenceId(value) });
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

// Primitives pass through; Date is left as-is for the driver; other objects
// (Temporal.PlainDate / Duration) are stringified ("1982-11-30", "PT4M54S").
function normalizeScalar(value: unknown): unknown {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'object') return String(value);
    return value;
}

// The primary-key id behind a reference, whether it is a full Entity or a Lite.
function referenceId(value: unknown): PrimaryKey | null {
    if (value == null) return null;
    return (value as { id?: PrimaryKey }).id ?? null;
}

function entityConstructorOf(value: unknown): Function {
    if (value instanceof Lite) return value.entityType;
    return (value as object).constructor;
}

function cleanTypeName(ctor: Function): string {
    return ctor.name.replace(/Entity$/, '');
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

function buildUpdate(table: Table, assignments: ColumnValue[], id: PrimaryKey): SqlPreCommandSimple {
    const sb = Connector.current().sqlBuilder;
    const tableName = sb.objectName(table.name);
    const idCol = sb.sqlEscape(table.primaryKey.column.name);

    const sets = assignments
        .map((a, i) => `${sb.sqlEscape(a.column.name)} = ${placeholder(sb.isPostgres, i)}`)
        .join(', ');
    const sql = `UPDATE ${tableName} SET ${sets} WHERE ${idCol} = ${placeholder(sb.isPostgres, assignments.length)};`;
    return new SqlPreCommandSimple(sql, namedParameters(assignments, { value: id }));
}
