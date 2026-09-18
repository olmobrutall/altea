import "../../data/globals"; // Array.prototype.joinComma (Signum's CommaAnd) + String.prototype.forGenderAndNumber
import type { Entity, Type } from '../../data/entity';
import { Enum } from '../../data/enum';
import { getBoundEnum } from '../../data/enumEntity';
import { CollectionMessage } from '../../data/dynamicQueries';
import { EngineMessage } from '../../data/uiMessages';
import type { IColumn } from '../schema/column';
import type { EntityField } from '../schema/field';
import { FieldEmbedded } from '../schema/field';
import type { Schema } from '../schema/schema';
import type { Table } from '../schema/table';
import type { TableIndex } from '../schema/tableIndex';
import type { Connector } from './connector';

/**
 * Port of Signum's `ForeignKeyException` / `UniqueKeyException`
 * (old/Framework/Signum/Engine/Exceptions.cs): a constraint violation raised by the driver, re-read
 * through the Schema and re-raised as a sentence naming the ENTITY TYPE and the PROPERTY rather than
 * the table and the column.
 *
 * Signum builds them in each connector's `ReplaceException` (PostgreSqlConnector / SqlServerConnector),
 * and so does altea — see `Connector.replaceException`, overridden by the two real connectors. The
 * dialect-specific half is therefore "what the driver's error object looks like"; everything below is
 * dialect-neutral.
 *
 * Three DIVERGENCES from Signum, all forced or clearly better:
 *
 *  1. **The constraint name is looked UP, not parsed.** Signum walks `FK_(?<parts>.+?)` and tries every
 *     `table_column` split against the schema until one matches — it has to, because SQL Server only
 *     gives it a name. altea instead builds a reverse index by asking the SqlBuilder for the name it
 *     WOULD generate for every FK column / unique index in the schema, and matches on that. It is exact
 *     (it survives the chop-hash truncation of a long name, which the split heuristic cannot) and it
 *     works identically on both providers. Signum's split heuristic is kept as the fallback for a
 *     constraint altea did not generate.
 *  2. **No `HumanValues`.** Signum re-retrieves the offending FK values as Lites to print them. Every
 *     altea database call is async and this is a constructor, so the duplicate key is printed as the
 *     driver's own text. (PostgreSQL reports it in `detail`, which Signum ignores, so the PG message is
 *     actually RICHER here: Signum always falls back to `ThereIsAlreadyA0WithTheSame1_G` on Postgres.)
 *  3. **Insert-vs-delete is decided from the failing STATEMENT.** Signum greps the driver message for
 *     "INSERT"/"UPDATE", which is the exception's localized text. The seam has the SQL in hand, so the
 *     leading verb answers it without depending on the server's `lc_messages`.
 */

// ---- What the two drivers hand us, normalised ------------------------------------------------

/** The dialect-neutral shape of a foreign-key violation, filled by each connector. */
export interface ForeignKeyViolation {
    /** The FK constraint's name, as the database spells it. */
    readonly constraintName: string | undefined;
    /** The table the constraint is DECLARED on (the REFERENCING one). PostgreSQL names it; SQL Server does not. */
    readonly tableName?: string;
    /** The database schema of that table (PostgreSQL only) — needed because altea puts each package in its own. */
    readonly schemaName?: string;
    /** The OTHER table the driver names: on a dangling write, the one that was referenced. */
    readonly referedTableName?: string;
    /** True when the failing statement WROTE a dangling reference; false when a delete/update was BLOCKED by one. */
    readonly isInsert: boolean;
}

/** The dialect-neutral shape of a unique-index violation, filled by each connector. */
export interface UniqueKeyViolation {
    /** The unique index / constraint name, as the database spells it. */
    readonly indexName: string | undefined;
    readonly tableName?: string;
    readonly schemaName?: string;
    /** The duplicate key values, as the driver printed them (`'Artist'`, `1, 2`). */
    readonly values?: string;
}

// ---- Constraint-name → schema object ----------------------------------------------------------

interface ForeignKeyTarget { readonly table: Table; readonly column: IColumn; }
interface UniqueIndexTarget { readonly table: Table; readonly index: TableIndex; }

interface ConstraintIndex {
    /** Lower-cased constraint name → the FK columns that would generate it (several only across DB schemas). */
    readonly foreignKeys: Map<string, ForeignKeyTarget[]>;
    /** Lower-cased index name → the unique indexes that would generate it. */
    readonly uniqueIndexes: Map<string, UniqueIndexTarget[]>;
    /** Lower-cased table name → the tables with that name (several when two packages' DB schemas repeat one). */
    readonly tables: Map<string, Table[]>;
}

// Built once per Schema and kept alive only as long as it is — the schema is immutable after
// SchemaBuilder.complete(), so there is nothing to invalidate. Signum caches the same two lookups in
// static ConcurrentDictionaries keyed by table/index name.
const constraintIndexes = new WeakMap<Schema, ConstraintIndex>();

function constraintIndex(connector: Connector): ConstraintIndex {
    const schema = connector.schema;
    let result = constraintIndexes.get(schema);
    if (result != null)
        return result;

    const foreignKeys = new Map<string, ForeignKeyTarget[]>();
    const uniqueIndexes = new Map<string, UniqueIndexTarget[]>();
    const tables = new Map<string, Table[]>();
    const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
        const list = map.get(key.toLowerCase());
        if (list == null) map.set(key.toLowerCase(), [value]); else list.push(value);
    };

    for (const table of schema.tables.values()) {
        push(tables, table.name.name, table);
        // Exactly the filter `SqlBuilder.alterTableForeignKeys` generates from, so every name here is a
        // constraint that really exists and no constraint that exists is missing.
        for (const column of Object.values(table.columns))
            if (column.referenceTable != null && !column.avoidForeignKey)
                push(foreignKeys, connector.sqlBuilder.foreignKeyName(table.name.name, column.name), { table, column });

        for (const index of table.indexes)
            if (index.unique)
                push(uniqueIndexes, connector.sqlBuilder.indexName(index), { table, index });
    }

    result = { foreignKeys, uniqueIndexes, tables };
    constraintIndexes.set(schema, result);
    return result;
}

/**
 * Narrow the candidates of one constraint name to the table the driver named, when it named one.
 * A constraint name is unique per TABLE, not per database, and altea puts each package in its own DB
 * schema — so `fk_alert_state_id` could in principle exist twice. PostgreSQL hands us `schema` + `table`
 * and the ambiguity disappears; SQL Server hands us neither, and then the only honest answer for an
 * ambiguous name is "cannot tell", which reads as an unmapped constraint (the raw message).
 */
function narrow<T extends { table: Table }>(candidates: T[] | undefined, v: { tableName?: string; schemaName?: string }): T | undefined {
    if (candidates == null || candidates.length === 0)
        return undefined;
    if (candidates.length === 1)
        return candidates[0];
    const wanted = bareName(v.tableName);
    const matches = candidates.filter(c =>
        (wanted == null || c.table.name.name.toLowerCase() === wanted) &&
        (v.schemaName == null || c.table.name.schema.name.toLowerCase() === v.schemaName.toLowerCase()));
    return matches.length === 1 ? matches[0] : undefined;
}

/** SQL Server prints a table as `dbo.Alert`; Signum takes the last segment, so do we. Lower-cased. */
function bareName(tableName: string | undefined): string | undefined {
    if (tableName == null)
        return undefined;
    const bare = tableName.includes(".") ? tableName.slice(tableName.lastIndexOf(".") + 1) : tableName;
    return bare.toLowerCase();
}

/** The table a (schema-qualified) name refers to, when exactly one answers to it. */
function findTable(connector: Connector, tableName: string | undefined, schemaName?: string): Table | undefined {
    const bare = bareName(tableName);
    if (bare == null)
        return undefined;
    const candidates = constraintIndex(connector).tables.get(bare);
    if (candidates == null || candidates.length === 0)
        return undefined;
    if (candidates.length === 1)
        return candidates[0];
    const inSchema = schemaName == null ? [] :
        candidates.filter(t => t.name.schema.name.toLowerCase() === schemaName.toLowerCase());
    return inSchema.length === 1 ? inSchema[0] : undefined;
}

// ---- Schema object → display name -------------------------------------------------------------

/**
 * A table's type as a user sees it. An ENUM table maps back to the ENUM, not to an entity — its
 * `EnumEntity<Sex>` carrier class would humanise to the literal string "EnumEntity<Sex>" — which is
 * Signum's `EnumEntity.Extract(type) ?? type` in `ForeignKeyException`, applied to every table here
 * rather than only to the referenced one.
 */
function tableNiceName(table: Table): string {
    const boundEnum = getBoundEnum(table.type);
    if (boundEnum != null)
        return Enum.niceTypeName(boundEnum as Record<string, string | number>) ?? table.name.name;
    return (table.type as Type<Entity>).niceName();
}

/** As {@link tableNiceName}, plural. An enum has no plural name, so it answers with its singular. */
function tableNicePluralName(table: Table): string {
    if (getBoundEnum(table.type) != null)
        return tableNiceName(table);
    return (table.type as Type<Entity>).nicePluralName();
}

/** The grammatical gender the `_G` messages pick their article from (undefined for a genderless culture). */
function tableGender(table: Table): string | undefined {
    if (getBoundEnum(table.type) != null)
        return undefined;
    return (table.type as Type<Entity>).gender();
}

/**
 * The display name of the PROPERTY a physical column belongs to — Signum's
 * `Reflector.TryFindPropertyInfo(f.FieldInfo)` over the fields whose columns contain it.
 *
 * altea flattens an embedded into its owner's row, so a column can sit several member steps down; the
 * walk RECURSES and joins the steps with " / " ("Ship Address / City"), where Signum stops at the
 * outermost field and would answer just "Ship Address". Mixin fields are searched after the own ones.
 */
function columnNiceName(table: Table, column: IColumn): string | undefined {
    const walk = (fields: { [name: string]: EntityField }, prefix: string[]): string | undefined => {
        for (const ef of Object.values(fields)) {
            if (!ef.field.columns().includes(column))
                continue;
            const here = [...prefix, ef.fieldInfo.niceToString()];
            // The embedded's own HasValue column belongs to the embedded itself, so a deeper miss
            // correctly falls back to the embedded's own name.
            if (ef.field instanceof FieldEmbedded) {
                const inner = walk(ef.field.embeddedFields, here);
                if (inner != null)
                    return inner;
            }
            return here.join(" / ");
        }
        return undefined;
    };

    const own = walk(table.fields, []);
    if (own != null)
        return own;
    for (const mixin of Object.values(table.mixins)) {
        const inMixin = walk(mixin.fields, []);
        if (inMixin != null)
            return inMixin;
    }
    return undefined;
}

/** Every property a unique index covers, in column order and without repeats. */
function indexNiceNames(table: Table, index: TableIndex): string[] {
    const names: string[] = [];
    for (const column of index.columns) {
        const name = columnNiceName(table, column);
        if (name != null && !names.includes(name))
            names.push(name);
    }
    return names;
}

// ---- The exceptions ---------------------------------------------------------------------------

/**
 * Signum's `ForeignKeyException`. Two quite different failures share error code 23503 / 547:
 *
 *  - a DELETE (or a key UPDATE) BLOCKED because rows still point at the row being removed —
 *    `EngineMessage.ThereAre0ThatReferThisEntityByProperty1`, or
 *    `ThereAreRecordsIn0PointingToThisTableByColumn1` when the table maps to no known type;
 *  - an INSERT/UPDATE that WROTE a reference to a row that does not exist — "The column {0} of the {1}
 *    does not refer to a valid {2}". Signum leaves that sentence an English LITERAL: it is the only one
 *    here with no `EngineMessage` member, and so with no translation in any Signum XML. altea keeps it
 *    literal rather than inventing a member no culture has text for.
 */
export class ForeignKeyException extends Error {
    /** The referencing table, once the constraint was mapped back to the schema. */
    readonly table: Table | undefined;
    /** The referencing column, once mapped. */
    readonly column: IColumn | undefined;
    /** The referenced table, when the driver named it and it maps (the dangling-write case only). */
    readonly referedTable: Table | undefined;
    readonly isInsert: boolean;
    /** The raw names, kept for the message the engine falls back to when the mapping fails. */
    readonly tableName: string | undefined;
    readonly columnName: string | undefined;

    constructor(connector: Connector, inner: unknown, violation: ForeignKeyViolation) {
        const target = narrow(
            violation.constraintName == null ? undefined : constraintIndex(connector).foreignKeys.get(violation.constraintName.toLowerCase()),
            violation);

        // Signum's split heuristic, kept ONLY as the fallback for a constraint altea did not generate:
        // `FK_<table>_<column>` with both halves free of underscores is not decidable, so it tries every
        // split position and keeps the first whose left half names a table.
        const raw = target != null
            ? { tableName: target.table.name.name, columnName: target.column.name }
            : splitConstraintName(connector, violation);

        const table = target?.table ?? findTable(connector, raw?.tableName, violation.schemaName);
        const referedTable = violation.isInsert ? findTable(connector, violation.referedTableName) : undefined;
        const property = table != null && target != null ? columnNiceName(table, target.column) : undefined;

        super(message(), { cause: inner });
        this.name = "ForeignKeyException";
        this.table = table;
        this.column = target?.column;
        this.referedTable = referedTable;
        this.isInsert = violation.isInsert;
        this.tableName = raw?.tableName;
        this.columnName = raw?.columnName;

        function message(): string {
            if (raw == null)
                return innerMessage(inner);

            if (violation.isInsert)
                return table == null || referedTable == null
                    ? `The column ${raw.columnName} on table ${raw.tableName} does not reference ${violation.referedTableName}`
                    : `The column ${raw.columnName} of the ${tableNiceName(table)} does not refer to a valid ${tableNiceName(referedTable)}`;

            return table == null
                ? EngineMessage.ThereAreRecordsIn0PointingToThisTableByColumn1.niceToString(raw.tableName, raw.columnName)
                : EngineMessage.ThereAre0ThatReferThisEntityByProperty1.niceToString(
                    tableNicePluralName(table), property ?? raw.columnName);
        }
    }
}

/**
 * Signum's `UniqueKeyException`: a unique index rejected a duplicate. The index name maps back to a
 * `TableIndex`, and its columns to the properties they belong to, so the sentence names the entity and
 * the fields rather than the index.
 *
 * A PRIMARY KEY violation carries the same error code and lands here too; its constraint is not a
 * registered `TableIndex`, so the index stays unmapped and the message falls back to the raw constraint
 * name — exactly as in Signum.
 */
export class UniqueKeyException extends Error {
    readonly table: Table | undefined;
    readonly index: TableIndex | undefined;
    /** The display names of the properties the index covers, when it mapped. */
    readonly properties: string[] | undefined;
    readonly values: string | undefined;

    constructor(connector: Connector, inner: unknown, violation: UniqueKeyViolation) {
        const target = narrow(
            violation.indexName == null ? undefined : constraintIndex(connector).uniqueIndexes.get(violation.indexName.toLowerCase()),
            violation);
        const table = target?.table ?? findTable(connector, violation.tableName, violation.schemaName);
        const properties = target == null ? undefined : indexNiceNames(target.table, target.index);

        super(message(), { cause: inner });
        this.name = "UniqueKeyException";
        this.table = table;
        this.index = target?.index;
        this.properties = properties;
        this.values = violation.values;

        function message(): string {
            if (table == null)
                return innerMessage(inner);

            const columns = properties != null && properties.length > 0
                ? properties.map(p => `[${p}]`).joinComma(CollectionMessage.And.niceToString())
                : violation.indexName ?? "";

            const gender = tableGender(table);
            return violation.values == null
                ? EngineMessage.ThereIsAlreadyA0WithTheSame1_G.niceToString(tableNiceName(table), columns).forGenderAndNumber(gender)
                : EngineMessage.ThereIsAlreadyA0With1EqualsTo2_G.niceToString(tableNiceName(table), columns, violation.values).forGenderAndNumber(gender);
        }
    }
}

// ---- Shared helpers ---------------------------------------------------------------------------

/**
 * Signum's `ForeignKeyException` constraint-name split, reached only when {@link constraintIndex} has
 * no entry — a FK altea did not generate, or one whose name predates a rename. `fk_album_label_id`
 * could be (album, label_id) or (album_label, id), so it tries each split and keeps the first whose
 * left half names a table. Returns the raw names only; the caller still has to map them.
 */
function splitConstraintName(connector: Connector, violation: ForeignKeyViolation): { tableName: string; columnName: string } | undefined {
    const name = violation.constraintName;
    if (name == null)
        return undefined;

    // PostgreSQL names the constraint's own table, so the column is just the rest of the name and no
    // guessing is needed — Signum's `pg.ConstraintName.After($"fk_{pg.TableName}_")`.
    if (violation.tableName != null) {
        const prefix = new RegExp(`^fk_${violation.tableName}_`, "i");
        if (prefix.test(name))
            return { tableName: violation.tableName, columnName: name.replace(prefix, "") };
    }

    const parts = name.replace(/^fk_/i, "").split("_");
    for (let i = 1; i < parts.length; i++) {
        const tableName = parts.slice(0, i).join("_");
        if (findTable(connector, tableName, violation.schemaName) != null)
            return { tableName, columnName: parts.slice(i).join("_") };
    }
    return violation.tableName == null ? undefined : { tableName: violation.tableName, columnName: name };
}

/** The driver's own text — what both exceptions fall back to when the constraint maps to nothing. */
function innerMessage(inner: unknown): string {
    return inner instanceof Error ? inner.message : String(inner);
}
