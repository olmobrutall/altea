import type { Connector } from '../connection/connector';
import type { IColumn } from '../schema/column';
import { AbstractDbType, isNullableToBool } from '../schema/dbType';
import { ObjectName, SchemaName } from '../schema/objectName';
import type { Table } from '../schema/table';
import type { TableIndex } from '../schema/tableIndex';
import type { DiffColumn } from './diffModels';
import { SqlPreCommand, SqlPreCommandSimple, SqlPreCommandWithHistory, Spacing } from './sqlPreCommand';
import { chopHash, codify, HASH_SIZE } from './stringHash';
import { VERSIONING_FUNCTION } from './postgres/versioning';

// Renders dialect-specific DDL fragments from the in-memory schema model. Mirrors
// Signum's SqlBuilder, scoped to schema *generation*: CREATE SCHEMA / CREATE
// TABLE / ADD FOREIGN KEY. Synchronization-only emitters (ALTER COLUMN, DROP,
// rename, indexes, system-versioning) are deferred with the rest of milestone B.
//
// Owned by a Connector, which supplies the dialect flag and the DB's identifier
// length limit (used to hash-chop long constraint names).
export class SqlBuilder {
    readonly isPostgres: boolean;

    constructor(private readonly connector: Connector) {
        this.isPostgres = connector.isPostgres;
    }

    private get maxNameLength(): number {
        return this.connector.maxNameLength;
    }

    // ---- Identifier escaping ------------------------------------------------

    // Quotes an identifier only when required: when it collides with a reserved
    // word or doesn't match the dialect's bare-identifier pattern. Keeps output
    // readable (matching Signum), unlike unconditional quoting.
    sqlEscape(ident: string): string {
        if (this.isPostgres) {
            const safe = ident.toLowerCase() === ident && /^[a-z_][a-z0-9_]{0,62}$/.test(ident);
            if (!safe || RESERVED_WORDS.has(ident.toUpperCase()))
                return `"${ident}"`;
            return ident;
        }
        const safe = /^[a-zA-Z_][a-zA-Z0-9_@#]{0,127}$/.test(ident);
        if (!safe || RESERVED_WORDS.has(ident.toUpperCase()))
            return `[${ident}]`;
        return ident;
    }

    // Fully-qualified, escaped object name: [database.][schema.]name. Empty parts
    // (the default schema/database) are omitted.
    objectName(name: ObjectName): string {
        return [name.schema.database.name, name.schema.name, name.name]
            .filter(p => p !== '')
            .map(p => this.sqlEscape(p))
            .join('.');
    }

    // Like objectName but always schema-qualified — an empty (default) schema becomes the
    // dialect default (dbo / public). SQL Server's SYSTEM_VERSIONING HISTORY_TABLE clause
    // rejects a one-part name, so the history table must be spelled out in two parts.
    qualifiedName(name: ObjectName): string {
        const schema = name.schema.name !== '' ? name.schema.name : (this.isPostgres ? 'public' : 'dbo');
        return [name.schema.database.name, schema, name.name]
            .filter(p => p !== '')
            .map(p => this.sqlEscape(p))
            .join('.');
    }

    // ---- Schemas ------------------------------------------------------------

    createSchema(schema: SchemaName): SqlPreCommand {
        const name = this.sqlEscape(schema.name);
        return new SqlPreCommandSimple(
            this.isPostgres
                ? `CREATE SCHEMA IF NOT EXISTS ${name};`
                : `CREATE SCHEMA ${name};`,
        );
    }

    // ---- Tables -------------------------------------------------------------

    createTableSql(table: Table): SqlPreCommand {
        const sv = table.systemVersioned;
        const lines = Object.values(table.columns).map(c => this.columnLine(c));

        const pk = table.primaryKey.column;
        // A temp-table view's representative PK aliases an existing column (it's not a
        // physical column of its own), so there's no PK constraint to emit — its rows are
        // never dedup'd. Only add the constraint when the PK is a real column of the table.
        if (table.columns[pk.name] === pk) {
            const pkName = this.sqlEscape(this.primaryKeyName(table.name.name));
            const pkCol = this.sqlEscape(pk.name);
            const pkConstraint = this.isPostgres
                ? `CONSTRAINT ${pkName} PRIMARY KEY (${pkCol})`
                : `CONSTRAINT ${pkName} PRIMARY KEY CLUSTERED (${pkCol} ASC)`;
            lines.push(pkConstraint);
        }

        // SQL Server system-versioning: the PERIOD declaration lives in the table body and the
        // WITH (SYSTEM_VERSIONING = ON …) clause follows the column list; SQL Server auto-creates
        // the named history table. (Postgres has no native support — the sys_period column is an
        // ordinary column here; the history table + trigger are emitted separately.)
        let suffix = '';
        if (sv != null && !this.isPostgres) {
            lines.push(`PERIOD FOR SYSTEM_TIME (${this.sqlEscape(sv.startColumnName!)}, ${this.sqlEscape(sv.endColumnName!)})`);
            // SQL Server requires HISTORY_TABLE in two-part (schema-qualified) form.
            suffix = `\nWITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = ${this.qualifiedName(sv.historyTableName)}))`;
        }

        const body = lines.map(l => `  ${l}`).join(',\n');
        return new SqlPreCommandSimple(`CREATE TABLE ${this.objectName(table.name)}(\n${body}\n)${suffix};`);
    }

    // ---- system-versioning (temporal tables) --------------------------------

    // The generic Postgres versioning() trigger function (altea's own — see postgres/versioning.ts).
    // Installed once before the versioned tables; SQL Server needs no such function (native).
    createVersioningFunction(): SqlPreCommand {
        return new SqlPreCommandSimple(VERSIONING_FUNCTION + ';');
    }

    // Postgres history table: `CREATE TABLE <hist> (LIKE <main>)` copies the column definitions
    // (names/types/NOT NULL) without PK/identity/FK/indexes — a plain archive of row versions.
    createHistoryTableSql(table: Table): SqlPreCommand {
        const sv = table.systemVersioned!;
        return new SqlPreCommandSimple(`CREATE TABLE ${this.objectName(sv.historyTableName)} (LIKE ${this.objectName(table.name)});`);
    }

    // Postgres per-table versioning trigger, emitted as a one-liner. Passes the generic function
    // the sys_period column, the (qualified) history table, and the comma-separated column list
    // (every physical column except sys_period) — the Option C design. `replace` emits
    // CREATE OR REPLACE TRIGGER (Signum's CreateVersioningTrigger(replace)), used by the
    // synchronizer when the column list drifts (altea passes the columns as a trigger arg, so an
    // added/dropped column requires re-emitting the trigger — a divergence from Signum's
    // column-agnostic generic function).
    createVersioningTrigger(table: Table, replace = false): SqlPreCommand {
        const [sysPeriod, historyName, cols] = this.versioningTriggerArgs(table);
        return new SqlPreCommandSimple(
            `CREATE ${replace ? 'OR REPLACE ' : ''}TRIGGER versioning_trigger BEFORE INSERT OR UPDATE OR DELETE ON ${this.objectName(table.name)} ` +
            `FOR EACH ROW EXECUTE FUNCTION versioning('${sysPeriod}', '${historyName}', '${cols}');`);
    }

    // The three string arguments altea passes to the generic versioning() trigger function
    // (Signum's VersioningTriggerArgs, extended for Option C): the sys_period column, the
    // (qualified) history table, and the comma-separated column list (every physical column
    // except sys_period). The reader decodes pg_trigger.tgargs into the same three-element array,
    // so the synchronizer can compare them and CREATE OR REPLACE the trigger when either the
    // history table OR the column list has drifted.
    versioningTriggerArgs(table: Table): string[] {
        const sv = table.systemVersioned!;
        const sysPeriod = sv.postgresSysPeriodColumnName!;
        const cols = Object.values(table.columns)
            .filter(c => c.name !== sysPeriod)
            .map(c => this.sqlEscape(c.name))
            .join(',');
        return [sysPeriod, this.objectName(sv.historyTableName), cols];
    }

    // Drop a Postgres versioning trigger by name (Signum's DropVersionningTrigger). Used when a
    // table is no longer system-versioned in the model.
    dropVersioningTrigger(tableName: ObjectName, triggerName: string): SqlPreCommand {
        return new SqlPreCommandSimple(`DROP TRIGGER ${this.sqlEscape(triggerName)} ON ${this.objectName(tableName)};`);
    }

    // A single column declaration: name type [IDENTITY] (NULL|NOT NULL) [DEFAULT]. `forHistory`
    // (Signum's ColumnLine forHistoryTable) suppresses the identity and GENERATED-ALWAYS period
    // markers: a Postgres history table is a plain `(LIKE main)` archive whose columns are never
    // engine-maintained (no identity, no ROW START/END), so a column added to it must not carry
    // those attributes.
    columnLine(c: IColumn, forHistory = false): string {
        const parts: (string | undefined)[] = [
            this.sqlEscape(c.name),
            this.getColumnType(c),
            // SQL Server period columns are engine-maintained row start/end timestamps.
            // (Postgres' sys_period is an ordinary tstzrange column — no marker here.)
            forHistory ? undefined
                : c.systemVersion === 'start' ? 'GENERATED ALWAYS AS ROW START HIDDEN'
                : c.systemVersion === 'end' ? 'GENERATED ALWAYS AS ROW END HIDDEN' : undefined,
            c.identity && !forHistory ? (this.isPostgres ? 'GENERATED ALWAYS AS IDENTITY' : 'IDENTITY') : undefined,
            c.collation != null ? `COLLATE ${c.collation}` : undefined,
            isNullableToBool(c.nullable) ? 'NULL' : 'NOT NULL',
            c.default != null ? `DEFAULT ${this.quote(c.dbType, c.default)}` : undefined,
        ];
        return parts.filter(p => p != null).join(' ');
    }

    getColumnType(c: IColumn): string {
        const base = this.isPostgres ? c.dbType.postgres : c.dbType.sqlServer;
        return base + this.sizePrecisionScale(c);
    }

    private sizePrecisionScale(c: IColumn): string {
        const isDecimal = this.isDecimal(c);
        if (isDecimal) {
            if (c.precision == null)
                return '';
            return c.scale == null ? `(${c.precision})` : `(${c.precision},${c.scale})`;
        }
        if (c.size == null) {
            // A string type with no explicit length is treated as unbounded:
            // SQL Server's bare `nvarchar` means `nvarchar(1)` (silently truncates),
            // so emit `(MAX)`; Postgres `varchar` is already unbounded.
            if (this.isString(c))
                return this.isPostgres ? '' : '(MAX)';
            return '';
        }
        // SqlServer's "unbounded" size → (MAX); Postgres has no length on text.
        if (c.size === MAX_SIZE)
            return this.isPostgres ? '' : '(MAX)';
        return `(${c.size})`;
    }

    private isDecimal(c: IColumn): boolean {
        const t = this.isPostgres ? c.dbType.postgres : c.dbType.sqlServer;
        return t === 'decimal' || t === 'numeric';
    }

    private isString(c: IColumn): boolean {
        const t = (this.isPostgres ? c.dbType.postgres : c.dbType.sqlServer).toLowerCase();
        return t === 'nvarchar' || t === 'varchar' || t === 'nchar' || t === 'char' || t === 'text';
    }

    // ---- Foreign keys -------------------------------------------------------

    // One ALTER TABLE ... ADD CONSTRAINT per FK column. Run after every table
    // exists so referenced tables are present. Columns flagged avoidForeignKey
    // (or with no referenceTable) emit nothing.
    alterTableForeignKeys(table: Table): SqlPreCommand | undefined {
        const cmds = Object.values(table.columns)
            .filter(c => c.referenceTable != null && !c.avoidForeignKey)
            .map(c => this.alterTableAddConstraintForeignKey(table, c.name, c.referenceTable!));
        return SqlPreCommand.combine(Spacing.Simple, ...cmds);
    }

    // Faithful to Signum's two AlterTableAddConstraintForeignKey overloads: the Table/column
    // form (used by generation) delegates to the ObjectName form (used by synchronization).
    alterTableAddConstraintForeignKey(table: Table, fieldName: string, foreignTable: Table): SqlPreCommand | undefined;
    alterTableAddConstraintForeignKey(parentTable: ObjectName, parentColumn: string, targetTable: ObjectName, targetPrimaryKey: string): SqlPreCommand | undefined;
    alterTableAddConstraintForeignKey(a: Table | ObjectName, b: string, c: Table | ObjectName, d?: string): SqlPreCommand | undefined {
        if (a instanceof ObjectName)
            return this.alterTableAddConstraintForeignKeyCore(a, b, c as ObjectName, d!);

        const foreignTable = c as Table;
        return this.alterTableAddConstraintForeignKeyCore(a.name, b, foreignTable.name, foreignTable.primaryKey.column.name);
    }

    private alterTableAddConstraintForeignKeyCore(parentTable: ObjectName, parentColumn: string, targetTable: ObjectName, targetPrimaryKey: string): SqlPreCommand {
        return new SqlPreCommandSimple(
            `ALTER TABLE ${this.objectName(parentTable)} ADD CONSTRAINT ${this.sqlEscape(this.foreignKeyName(parentTable.name, parentColumn))} ` +
            `FOREIGN KEY (${this.sqlEscape(parentColumn)}) REFERENCES ${this.objectName(targetTable)}(${this.sqlEscape(targetPrimaryKey)});`,
        );
    }

    // ---- Indexes ------------------------------------------------------------

    // Index name (Signum's TableIndex.GetIndexName): IX_ / UIX_ prefix (lowercased on
    // Postgres) + table + column signature, chop-hashed to the length limit, plus a
    // WHERE/INCLUDE signature so a filtered/covering variant on the same columns gets a
    // distinct, deterministic name.
    indexName(index: TableIndex): string {
        const prefix = index.unique ? (this.isPostgres ? 'uix' : 'UIX') : (this.isPostgres ? 'ix' : 'IX');
        const cols = index.columns.map(c => c.name).join('_');
        // Reserve room for the "__" + 7-char WHERE signature (Signum's MaxNameLength()).
        const base = chopHash(`${prefix}_${index.table.name.name}_${cols}`, this.maxNameLength - HASH_SIZE - 2, this.isPostgres);
        return base + this.whereSignature(index);
    }

    // "__" + hash of the WHERE clause + INCLUDE columns (Signum's TableIndex.WhereSignature),
    // or "" when the index is a plain full index over its key columns.
    private whereSignature(index: TableIndex): string {
        const include = index.includeColumns != null && index.includeColumns.length > 0
            ? index.includeColumns.map(c => c.name).join('_')
            : '';
        const where = index.where ?? '';
        if (where === '' && include === '')
            return '';
        return '__' + codify(where + include, this.isPostgres);
    }

    // CREATE [UNIQUE] INDEX name ON table(cols) [INCLUDE(...)] [WHERE ...] (Signum's
    // CreateIndexBasic; clustered/partitioned/indexed-view variants are deferred). Postgres
    // and SQL Server share this shape once the default-filegroup `ON 'PRIMARY'` is dropped.
    // `index.where` is already the rendered SQL predicate (translated at registration time).
    createIndex(index: TableIndex): SqlPreCommand {
        const name = this.sqlEscape(this.indexName(index));
        const cols = index.columns.map(c => this.sqlEscape(c.name)).join(', ');
        const include = index.includeColumns != null && index.includeColumns.length > 0
            ? ` INCLUDE (${index.includeColumns.map(c => this.sqlEscape(c.name)).join(', ')})`
            : '';
        const where = index.where != null && index.where !== '' ? ` WHERE ${index.where}` : '';
        return new SqlPreCommandSimple(
            `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${this.objectName(index.table.name)} (${cols})${include}${where};`);
    }

    dropIndex(tableName: ObjectName, indexName: string): SqlPreCommand {
        if (this.isPostgres)
            return new SqlPreCommandSimple(`DROP INDEX ${this.sqlEscape(indexName)};`);
        return new SqlPreCommandSimple(`DROP INDEX ${this.sqlEscape(indexName)} ON ${this.objectName(tableName)};`);
    }

    // ---- Enum side-tables ---------------------------------------------------

    // One multi-row INSERT seeding an enum side-table: id = the member's
    // underlying value, name = the member name. Mirrors Signum's enum seeding.
    // Run after the tables exist. Returns undefined for an empty enum.
    insertEnumValues(table: Table, values: { id: number; name: string }[]): SqlPreCommand | undefined {
        if (values.length === 0)
            return undefined;
        const cols = `(${this.sqlEscape('id')}, ${this.sqlEscape('name')})`;
        const rows = values.map(v => `(${v.id}, ${this.quoteString(v.name)})`).join(', ');
        return new SqlPreCommandSimple(`INSERT INTO ${this.objectName(table.name)} ${cols} VALUES ${rows};`);
    }

    // One multi-row INSERT seeding the TypeEntity system table: one row per entity
    // type, id = the deterministic discriminator TypeLogic assigned. Mirrors
    // Signum's TypeLogic.Schema_Generating. Run after the tables exist.
    insertTypeEntities(table: Table, rows: { id: number | string; tableName: string; cleanName: string; namespace: string; className: string }[]): SqlPreCommand | undefined {
        if (rows.length === 0)
            return undefined;
        // Resolve each logical field to its physical column name (dialect-cased by the
        // SchemaBuilder — e.g. `tableName` → `TableName` / `table_name`), never hardcoded.
        const physical = (f: string): string =>
            f === 'id' ? table.primaryKey.column.name : table.fields[f].field.columns()[0].name;
        const cols = ['id', 'tableName', 'cleanName', 'namespace', 'className'].map(physical);
        const colList = `(${cols.map(c => this.sqlEscape(c)).join(', ')})`;
        const rowSql = rows.map(r =>
            `(${r.id}, ${this.quoteString(r.tableName)}, ${this.quoteString(r.cleanName)}, ${this.quoteString(r.namespace)}, ${this.quoteString(r.className)})`
        ).join(', ');
        return new SqlPreCommandSimple(`INSERT INTO ${this.objectName(table.name)} ${colList} VALUES ${rowSql};`);
    }

    private quoteString(value: string): string {
        return `'${value.replace(/'/g, "''")}'`;
    }

    // ---- Constraint naming --------------------------------------------------

    foreignKeyName(table: string, column: string): string {
        const prefix = this.isPostgres ? 'fk' : 'FK';
        return this.chopName(`${prefix}_${table}_${column}`);
    }

    primaryKeyName(table: string): string {
        const prefix = this.isPostgres ? 'pk' : 'PK';
        return this.chopName(`${prefix}_${table}`);
    }

    // Chop an over-long identifier to the DB's name-length limit, appending a short hash of
    // the truncated tail (Signum's StringHashEncoder.ChopHash).
    private chopName(name: string): string {
        return chopHash(name, this.maxNameLength, this.isPostgres);
    }

    // ---- Synchronization emitters -------------------------------------------
    //
    // Ported from Signum's SqlBuilder, scoped to the lean synchronizer (no system-versioning /
    // temporal `withHistory` variants, no partitions, no computed/check constraints). Signum's
    // GoBefore/GoAfter statement-ordering flags are dropped — altea's SqlPreCommand orders
    // purely by combine order, so callers must sequence statements themselves. (Divergence.)

    dropTable(tableName: ObjectName): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`DROP TABLE ${this.objectName(tableName)};`);
    }

    dropView(viewName: ObjectName): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`DROP VIEW ${this.objectName(viewName)};`);
    }

    // Two forms (Signum's overloads): the plain ObjectName form, and — for a system-versioned
    // table — a Table + `withHistory` form that returns a SqlPreCommandWithHistory forking the
    // drop to BOTH the main and the history table (only when withHistory).
    alterTableDropColumn(tableName: ObjectName, columnName: string): SqlPreCommand;
    alterTableDropColumn(table: Table, columnName: string, withHistory: boolean): SqlPreCommand;
    alterTableDropColumn(a: ObjectName | Table, columnName: string, withHistory?: boolean): SqlPreCommand {
        if (a instanceof ObjectName)
            return this.alterTableDropColumnCore(a, columnName);

        const normal = this.alterTableDropColumnCore(a.name, columnName);
        if (!withHistory)
            return normal;
        return new SqlPreCommandWithHistory(normal, this.alterTableDropColumnCore(a.systemVersioned!.historyTableName, columnName));
    }

    private alterTableDropColumnCore(tableName: ObjectName, columnName: string): SqlPreCommand {
        return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} DROP COLUMN ${this.sqlEscape(columnName)};`);
    }

    // The ObjectName form emits the ADD; the Table form (Signum's ITable overload) retargets at
    // the history table when `forHistory` and suppresses identity/period markers via columnLine.
    alterTableAddColumn(tableName: ObjectName, column: IColumn, tempDefault?: DefaultConstraint, forHistory?: boolean): SqlPreCommand;
    alterTableAddColumn(table: Table, column: IColumn, tempDefault?: DefaultConstraint, forHistory?: boolean): SqlPreCommand;
    alterTableAddColumn(a: ObjectName | Table, column: IColumn, tempDefault?: DefaultConstraint, forHistory = false): SqlPreCommand {
        const tableName = a instanceof ObjectName ? a : (forHistory ? a.systemVersioned!.historyTableName : a.name);
        const line = tempDefault == null
            ? this.columnLine(column, forHistory)
            : `${this.columnLine(column, forHistory)} ${this.isPostgres
                ? `DEFAULT ${tempDefault.quotedDefinition}`
                : `CONSTRAINT ${this.sqlEscape(tempDefault.name!)} DEFAULT ${tempDefault.quotedDefinition}`}`;
        return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ADD ${line};`);
    }

    // In-place column change. SQL Server re-states the whole column (type + nullability);
    // Postgres issues separate ALTER COLUMN … TYPE / SET|DROP NOT NULL statements, only for
    // the facets that actually differ (Signum's AlterTableAlterColumn). Three call shapes: a
    // plain change to `table`; a change retargeted via `forceTableName` (used to alter the
    // history table directly); and — Signum's withHistory overload — a boolean that forks the
    // change to BOTH the main and history tables as a SqlPreCommandWithHistory.
    alterTableAlterColumn(table: Table, column: IColumn, diffColumn: DiffColumn, forceTableName?: ObjectName): SqlPreCommand;
    alterTableAlterColumn(table: Table, column: IColumn, diffColumn: DiffColumn, withHistory: boolean): SqlPreCommand;
    alterTableAlterColumn(table: Table, column: IColumn, diffColumn: DiffColumn, p4?: ObjectName | boolean): SqlPreCommand {
        if (typeof p4 === "boolean") {
            const normal = this.alterTableAlterColumnCore(table, column, diffColumn);
            if (!p4)
                return normal;
            return new SqlPreCommandWithHistory(normal, this.alterTableAlterColumnCore(table, column, diffColumn, table.systemVersioned!.historyTableName));
        }
        return this.alterTableAlterColumnCore(table, column, diffColumn, p4);
    }

    private alterTableAlterColumnCore(table: Table, column: IColumn, diffColumn: DiffColumn, forceTableName?: ObjectName): SqlPreCommand {
        const tableName = forceTableName ?? table.name;
        const escName = this.sqlEscape(column.name);
        const nullable = isNullableToBool(column.nullable);
        const collate = column.collation != null ? ` COLLATE ${column.collation}` : '';

        if (!this.isPostgres) {
            return new SqlPreCommandSimple(
                `ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} ${this.getColumnType(column)}${collate} ${nullable ? 'NULL' : 'NOT NULL'};`);
        }

        const typeChanged = !diffColumn.dbType.equals(column.dbType) || diffColumn.collation !== column.collation
            || !diffColumn.scaleEquals(column) || !diffColumn.sizeEquals(column) || !diffColumn.precisionEquals(column);

        const parts: (SqlPreCommand | undefined)[] = [
            typeChanged ? new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} TYPE ${this.getColumnType(column)}${collate};`) : undefined,
            diffColumn.nullable && !nullable ? new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} SET NOT NULL;`) : undefined,
            !diffColumn.nullable && nullable ? new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} DROP NOT NULL;`) : undefined,
        ];

        return SqlPreCommand.combine(Spacing.Simple, ...parts)
            ?? new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} -- UNEXPECTED COLUMN CHANGE!!`);
    }

    // The DF_ default-constraint descriptor for a column that declares a default, or undefined.
    getDefaultConstaint(tableName: ObjectName, c: IColumn): DefaultConstraint | undefined {
        if (c.default == null)
            return undefined;

        return new DefaultConstraint(c.name, `DF_${tableName.name}_${c.name}`, this.quote(c.dbType, c.default));
    }

    alterTableDropDefaultConstaint(tableName: ObjectName, columnName: string, constraintName?: string): SqlPreCommand {
        if (this.isPostgres)
            return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${this.sqlEscape(columnName)} DROP DEFAULT;`);
        return this.alterTableDropConstraint(tableName, constraintName!);
    }

    alterTableAddDefaultConstraint(tableName: ObjectName, defCons: DefaultConstraint): SqlPreCommandSimple {
        if (this.isPostgres)
            return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${this.sqlEscape(defCons.columnName)} SET DEFAULT ${defCons.quotedDefinition};`);
        return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ADD CONSTRAINT ${this.sqlEscape(defCons.name!)} DEFAULT ${defCons.quotedDefinition} FOR ${this.sqlEscape(defCons.columnName)};`);
    }

    alterTableDropConstraint(tableName: ObjectName, constraintName: string | ObjectName): SqlPreCommand {
        const name = constraintName instanceof ObjectName ? constraintName.name : constraintName;
        return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} DROP CONSTRAINT ${this.sqlEscape(name)};`);
    }

    renameForeignKey(tn: ObjectName, foreignKeyName: ObjectName, newName: string): SqlPreCommand {
        if (this.isPostgres)
            return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tn)} RENAME CONSTRAINT ${this.sqlEscape(foreignKeyName.name)} TO ${this.sqlEscape(newName)};`);
        return this.spRename(`${tn.schema.name ? this.sqlEscape(tn.schema.name) + '.' : ''}${this.sqlEscape(foreignKeyName.name)}`, newName, 'OBJECT');
    }

    renameTable(oldName: ObjectName, newName: string): SqlPreCommand {
        if (this.isPostgres)
            return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(oldName)} RENAME TO ${this.sqlEscape(newName)};`);
        return this.spRename(this.objectName(oldName), newName, undefined);
    }

    alterSchema(oldName: ObjectName, schemaName: SchemaName): SqlPreCommandSimple {
        if (this.isPostgres)
            return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(oldName)} SET SCHEMA ${this.sqlEscape(schemaName.name)};`);
        return new SqlPreCommandSimple(`ALTER SCHEMA ${this.sqlEscape(schemaName.name)} TRANSFER ${this.objectName(oldName)};`);
    }

    // Plain ObjectName form, plus a Table + `withHistory` form (Signum's overload) that forks the
    // rename to the history table too when withHistory.
    renameColumn(tableName: ObjectName, oldName: string, newName: string): SqlPreCommand;
    renameColumn(table: Table, oldName: string, newName: string, withHistory: boolean): SqlPreCommand;
    renameColumn(a: ObjectName | Table, oldName: string, newName: string, withHistory?: boolean): SqlPreCommand {
        if (a instanceof ObjectName)
            return this.renameColumnCore(a, oldName, newName);

        const normal = this.renameColumnCore(a.name, oldName, newName);
        if (!withHistory)
            return normal;
        return new SqlPreCommandWithHistory(normal, this.renameColumnCore(a.systemVersioned!.historyTableName, oldName, newName));
    }

    private renameColumnCore(tableName: ObjectName, oldName: string, newName: string): SqlPreCommand {
        if (this.isPostgres)
            return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} RENAME COLUMN ${this.sqlEscape(oldName)} TO ${this.sqlEscape(newName)};`);
        return this.spRename(`${this.objectName(tableName)}.${oldName}`, newName, 'COLUMN');
    }

    dropSchema(schemaName: SchemaName): SqlPreCommand {
        return new SqlPreCommandSimple(`DROP SCHEMA ${this.sqlEscape(schemaName.name)};`);
    }

    // Drops whatever primary-key constraint the table currently has (its name is discovered
    // at run time), so a PK-type change can recreate it. SQL Server only — Postgres renames
    // the constraint directly. Faithful to Signum's DropPrimaryKeyConstraint.
    dropPrimaryKeyConstraint(tableName: ObjectName): SqlPreCommandSimple {
        const full = this.objectName(tableName);
        const varName = 'PrimaryKey_Constraint_' + tableName.name;
        const command =
`DECLARE @${varName} nvarchar(max)
SELECT  @${varName} = 'ALTER TABLE ${full} DROP CONSTRAINT [' + kc.name  + '];'
FROM sys.key_constraints kc
WHERE kc.parent_object_id = OBJECT_ID('${full}')
EXEC dbo.sp_executesql @${varName}`;
        return new SqlPreCommandSimple(command);
    }

    // SQL Server's sp_rename. Divergence from Signum: no cross-database prefix (altea is
    // single-database).
    private spRename(oldName: string, newName: string, objectType: string | undefined): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`EXEC SP_RENAME '${oldName}' , '${newName}'${objectType != null ? `, '${objectType}'` : ''};`);
    }

    // Quote a scalar default/literal for its abstract type — string/char types get single
    // quotes (Signum's Quote(AbstractDbType, string)).
    quote(dbType: AbstractDbType, value: string): string {
        const t = (this.isPostgres ? dbType.postgres : dbType.sqlServer).toLowerCase();
        const isString = t.includes('char') || t.includes('text');
        if (isString && !value.startsWith("'"))
            return `'${value.replace(/'/g, "''")}'`;
        return value;
    }
}

// A default-value constraint descriptor (Signum's SqlBuilder.DefaultConstraint) — the column
// it defaults, an optional constraint name (SQL Server), and the already-quoted definition.
export class DefaultConstraint {
    constructor(
        public columnName: string,
        public name: string | undefined,
        public quotedDefinition: string,
    ) { }
}

// Sentinel size meaning "max length" (nvarchar(MAX) / text). Reserved; the
// schema builder does not emit it yet.
export const MAX_SIZE = -1;

// Reserved words common to SQL Server and PostgreSQL that we always quote when
// used as identifiers (column/table names). Not exhaustive — the bare-identifier
// regex catches the rest of the risky cases (spaces, leading digits, casing).
const RESERVED_WORDS = new Set([
    'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'AUTHORIZATION', 'BACKUP', 'BEGIN', 'BETWEEN',
    'BREAK', 'BROWSE', 'BULK', 'BY', 'CASCADE', 'CASE', 'CHECK', 'CHECKPOINT', 'CLOSE', 'CLUSTERED',
    'COALESCE', 'COLLATE', 'COLUMN', 'COMMIT', 'COMPUTE', 'CONSTRAINT', 'CONTAINS', 'CONTINUE',
    'CONVERT', 'CREATE', 'CROSS', 'CURRENT', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
    'CURRENT_USER', 'CURSOR', 'DATABASE', 'DEFAULT', 'DELETE', 'DENY', 'DESC', 'DISTINCT', 'DROP',
    'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXEC', 'EXECUTE', 'EXISTS', 'EXTERNAL', 'FETCH', 'FILE',
    'FOR', 'FOREIGN', 'FREETEXT', 'FROM', 'FULL', 'FUNCTION', 'GRANT', 'GROUP', 'HAVING', 'IDENTITY',
    'IF', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE',
    'LIMIT', 'NATURAL', 'NOT', 'NULL', 'OF', 'OFFSET', 'ON', 'OPEN', 'OR', 'ORDER', 'OUTER', 'OVER',
    'PRIMARY', 'PROCEDURE', 'PUBLIC', 'REFERENCES', 'RETURN', 'REVOKE', 'RIGHT', 'ROLLBACK', 'ROW',
    'ROWS', 'SCHEMA', 'SELECT', 'SESSION_USER', 'SET', 'SOME', 'TABLE', 'THEN', 'TO', 'TOP', 'TRIGGER',
    'TRUNCATE', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'USING', 'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WHILE', 'WITH',
]);
