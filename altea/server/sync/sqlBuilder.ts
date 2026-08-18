import type { Connector } from '../connection/connector';
import type { IColumn } from '../schema/column';
import { AbstractDbType, isNullableToBool } from '../schema/dbType';
import { ObjectName, SchemaName } from '../schema/objectName';
import type { Table } from '../schema/table';
import type { TableIndex } from '../schema/tableIndex';
import { FullTextTableIndex, fullTextChangeTrackingSql, FULL_TEXT_INDEX_NAME } from '../schema/tableIndex';
import { VectorTableIndex, pgVectorIndexMethod, pgVectorOperatorClass, sqlVectorMetric } from '../schema/tableIndex';
import type { DiffColumn, DiffTable } from './diffModels';
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

    /** An INDEX's own qualified name: indexes are not children of the table in Postgres' namespace — they are
     *  independent objects living in the TABLE's schema, so a bare name only resolves through the search_path.
     *  Used by `dropIndex` for a table outside the default schema. */
    indexObjectName(tableName: ObjectName, indexName: string): string {
        return [tableName.schema.database.name, tableName.schema.name, indexName]
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
            lines.push(this.periodClause(sv));
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

    // ---- SQL Server system-versioning transitions --------------------------
    // Toggling `SYSTEM_VERSIONING` and the `PERIOD FOR SYSTEM_TIME` — used when a table becomes /
    // stops being versioned, or for a "strong" column change SQL Server rejects with versioning on
    // (Signum's AlterTable{Disable,Enable}SystemVersioning / AlterTable{Add,Drop}Period). SQL
    // Server-only; Postgres manages versioning via its trigger + history table.

    alterTableDisableSystemVersioning(tableName: ObjectName): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} SET (SYSTEM_VERSIONING = OFF);`);
    }

    alterTableEnableSystemVersioning(table: Table): SqlPreCommandSimple {
        // HISTORY_TABLE rejects a one-part name, so qualify it (dbo./public.) like createTableSql.
        return new SqlPreCommandSimple(
            `ALTER TABLE ${this.objectName(table.name)} SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = ${this.qualifiedName(table.systemVersioned!.historyTableName)}));`);
    }

    alterTableAddPeriod(table: Table): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(table.name)} ADD ${this.periodClause(table.systemVersioned!)};`);
    }

    // Fused `ALTER TABLE t ADD <startCol>, <endCol>, PERIOD FOR SYSTEM_TIME(...)` — adds the two
    // GENERATED-ALWAYS period columns AND the PERIOD in one statement when a table becomes
    // system-versioned (Signum's combinedAddPeriod). No DEFAULT is emitted on the period columns,
    // so the table must be empty; a non-empty table becoming versioned would need backfill
    // defaults (deferred — the always-versioned model never populates a table before versioning).
    alterTableAddPeriodWithColumns(table: Table): SqlPreCommandSimple {
        const sv = table.systemVersioned!;
        const startCol = table.columns[sv.startColumnName!];
        const endCol = table.columns[sv.endColumnName!];
        return new SqlPreCommandSimple(
            `ALTER TABLE ${this.objectName(table.name)} ADD\n  ${this.columnLine(startCol)},\n  ${this.columnLine(endCol)},\n  ${this.periodClause(sv)};`);
    }

    alterTableDropPeriod(table: Table): SqlPreCommandSimple {
        return new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(table.name)} DROP PERIOD FOR SYSTEM_TIME;`);
    }

    // `PERIOD FOR SYSTEM_TIME (start, end)` (Signum's SqlBuilder.Period), shared by createTableSql
    // and alterTableAddPeriod.
    private periodClause(sv: { startColumnName?: string; endColumnName?: string }): string {
        return `PERIOD FOR SYSTEM_TIME (${this.sqlEscape(sv.startColumnName!)}, ${this.sqlEscape(sv.endColumnName!)})`;
    }

    // A single column declaration: name type [IDENTITY] (NULL|NOT NULL) [DEFAULT]. `forHistory`
    // (Signum's ColumnLine forHistoryTable) suppresses the identity and GENERATED-ALWAYS period
    // markers: a Postgres history table is a plain `(LIKE main)` archive whose columns are never
    // engine-maintained (no identity, no ROW START/END), so a column added to it must not carry
    // those attributes.
    columnLine(c: IColumn, forHistory = false): string {
        // GENERATED-ALWAYS clause (Signum's `generatedAlways`): a computed/generated column, or a
        // SQL Server system-versioning row start/end. When present it also suppresses the
        // NULL / NOT NULL marker (a generated column derives its nullability from its expression).
        // A history table is a plain archive, so its columns never carry generated markers.
        const generatedAlways = forHistory ? undefined
            : c.computedColumn != null
                ? (this.isPostgres
                    ? `GENERATED ALWAYS AS (${c.computedColumn.expression})${c.computedColumn.persisted ? ' STORED' : ''}`
                    : `AS (${c.computedColumn.expression})${c.computedColumn.persisted ? ' PERSISTED' : ''}`)
                : c.systemVersion === 'start' ? 'GENERATED ALWAYS AS ROW START HIDDEN'
                : c.systemVersion === 'end' ? 'GENERATED ALWAYS AS ROW END HIDDEN' : undefined;

        const parts: (string | undefined)[] = [
            this.sqlEscape(c.name),
            this.getColumnType(c),
            c.identity && !forHistory ? (this.isPostgres ? 'GENERATED ALWAYS AS IDENTITY' : 'IDENTITY') : undefined,
            generatedAlways,
            c.collation != null ? `COLLATE ${c.collation}` : undefined,
            generatedAlways != null ? undefined : isNullableToBool(c.nullable) ? 'NULL' : 'NOT NULL',
            c.default != null ? `DEFAULT ${this.quote(c.dbType, c.default)}` : undefined,
        ];
        return parts.filter(p => p != null).join(' ');
    }

    getColumnType(c: IColumn): string {
        const base = this.isPostgres ? c.dbType.postgres : c.dbType.sqlServer;
        return base + this.sizePrecisionScale(c);
    }

    private sizePrecisionScale(c: IColumn): string {
        // PostgreSQL `bytea` takes NO length modifier (`bytea(128)` is a syntax error); a size on a binary
        // field only applies to SQL Server's `varbinary(n)`.
        if (this.isPostgres && c.dbType.isBinary())
            return '';
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
        // A SQL Server full-text index has the fixed catalog name FULL_TEXT_INDEX (Signum's
        // FullTextTableIndex.GetIndexName); on Postgres it uses the ordinary hashed `ix_` name over
        // its source columns, so it falls through to the default computation below.
        if (index instanceof FullTextTableIndex && !this.isPostgres)
            return FULL_TEXT_INDEX_NAME;
        // A vector index uses a `vec_ix` / `VEC_IX` prefix (Signum's VectorTableIndex.GetIndexName).
        if (index instanceof VectorTableIndex) {
            const vprefix = this.isPostgres ? 'vec_ix' : 'VEC_IX';
            return chopHash(`${vprefix}_${index.table.name.name}_${index.columns.map(c => c.name).join('_')}`, this.maxNameLength - HASH_SIZE - 2, this.isPostgres);
        }
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
        if (index instanceof FullTextTableIndex)
            return this.createFullTextIndex(index);
        if (index instanceof VectorTableIndex)
            return this.createVectorIndex(index);
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
            // An index lives in its TABLE's schema, and Postgres resolves a bare index name against the
            // search_path only — so a table outside the default schema (altea-auth's tables live in `auth`)
            // needs the qualifier, or the drop fails with "index … does not exist". SQL Server takes the
            // table name separately below, so it was never affected.
            return new SqlPreCommandSimple(`DROP INDEX ${this.indexObjectName(tableName, indexName)};`);
        return new SqlPreCommandSimple(`DROP INDEX ${this.sqlEscape(indexName)} ON ${this.objectName(tableName)};`);
    }

    // ---- Full-text indexes (Signum's CreateIndex FullTextTableIndex branch) --
    //
    // SQL Server needs a FULLTEXT CATALOG object + a CREATE FULLTEXT INDEX bound to the table's PK
    // (KEY INDEX). Postgres materialises a persisted tsvector column (emitted by columnLine) and a
    // GIN index over it. Signum marks the SQL Server statements NoTransaction (full-text DDL cannot
    // run inside a transaction); altea executes generation/sync leaves in autocommit (each statement
    // is its own batch), so no transaction wrapper is added — the same effect without a mode flag.
    createFullTextIndex(index: FullTextTableIndex): SqlPreCommand {
        if (this.isPostgres) {
            const name = this.sqlEscape(this.indexName(index));
            const col = this.sqlEscape(index.postgres.tsVectorColumnName);
            return new SqlPreCommandSimple(`CREATE INDEX ${name} ON ${this.objectName(index.table.name)} USING GIN (${col});`);
        }
        const sqls = index.sqlServer;
        const columns = index.columns.map(c => this.sqlEscape(c.name)).join(', ');
        // The full-text index is keyed by the table's (unique) primary-key index — its name.
        const keyIndex = this.sqlEscape(this.primaryKeyName(index.table.name.name));
        const options = [
            sqls.changeTracking != null ? `CHANGE_TRACKING = ${fullTextChangeTrackingSql(sqls.changeTracking)}` : undefined,
            sqls.stoplistName != null ? `STOPLIST = ${sqls.stoplistName}` : undefined,
            sqls.propertyListName != null ? `SEARCH PROPERTY LIST = ${sqls.propertyListName}` : undefined,
        ].filter((o): o is string => o != null);
        const lines = [
            `CREATE FULLTEXT INDEX ON ${this.objectName(index.table.name)}(${columns})`,
            `KEY INDEX ${keyIndex}`,
            `ON ${this.sqlEscape(sqls.catalogName)}`,
            options.length > 0 ? `WITH ${options.join(', ')}` : undefined,
        ].filter((l): l is string => l != null);
        return new SqlPreCommandSimple(lines.join('\n') + ';');
    }

    // DROP FULLTEXT INDEX targets the table, not a named index (Signum's DropIndex FullTextIndex).
    dropFullTextIndex(tableName: ObjectName): SqlPreCommand {
        return new SqlPreCommandSimple(`DROP FULLTEXT INDEX ON ${this.objectName(tableName)};`);
    }

    // ---- Vector indexes (Signum's CreateIndex VectorTableIndex branch) -------
    //
    // SQL Server: CREATE VECTOR INDEX … WITH (METRIC, TYPE[, MAXDOP]) (a separate batch — vector
    // DDL cannot run in a transaction, satisfied by altea's autocommit leaf execution). Postgres:
    // a pgvector `USING hnsw|ivfflat (col <operator_class>)` index, optionally WITH (lists = n).
    createVectorIndex(index: VectorTableIndex): SqlPreCommand {
        const name = this.sqlEscape(this.indexName(index));
        const table = this.objectName(index.table.name);
        const col = this.sqlEscape(index.columns[0].name);
        if (this.isPostgres) {
            const pg = index.postgres;
            const method = pgVectorIndexMethod(pg.indexType);
            const opClass = pgVectorOperatorClass(pg.metric);
            const withClause = pg.indexType === 'IVFFlat' && pg.lists != null ? ` WITH (lists = ${pg.lists})` : '';
            return new SqlPreCommandSimple(`CREATE INDEX ${name} ON ${table} USING ${method} (${col} ${opClass})${withClause};`);
        }
        const ss = index.sqlServer;
        const options = [
            `METRIC = '${sqlVectorMetric(ss.metric)}'`,
            `TYPE = '${ss.indexType}'`,
            ss.maxDegreeOfParallelism != null ? `MAXDOP = ${ss.maxDegreeOfParallelism}` : undefined,
        ].filter((o): o is string => o != null);
        return new SqlPreCommandSimple(`CREATE VECTOR INDEX ${name} ON ${table}(${col}) WITH (${options.join(', ')});`);
    }

    // CREATE EXTENSION IF NOT EXISTS "vector" (Signum's CreateExtensionIfNotExist) — Postgres only,
    // emitted whenever the schema has any vector column so pgvector's `vector` type + operators exist.
    createExtension(name: string): SqlPreCommand {
        return new SqlPreCommandSimple(`CREATE EXTENSION IF NOT EXISTS "${name}";`);
    }

    // SQL Server FULLTEXT CATALOG management (Signum's CreateFullTextCatallog / DropFullTextCatallog).
    createFullTextCatalog(catalogName: string): SqlPreCommand {
        return new SqlPreCommandSimple(`CREATE FULLTEXT CATALOG ${this.sqlEscape(catalogName)};`);
    }

    dropFullTextCatalog(catalogName: string): SqlPreCommand {
        return new SqlPreCommandSimple(`DROP FULLTEXT CATALOG ${this.sqlEscape(catalogName)};`);
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

    dropTable(tableName: ObjectName): SqlPreCommandSimple;
    dropTable(diff: DiffTable): SqlPreCommand;
    dropTable(arg: ObjectName | DiffTable): SqlPreCommand {
        if (arg instanceof ObjectName)
            return new SqlPreCommandSimple(`DROP TABLE ${this.objectName(arg)};`);
        // A versioned table can't be dropped while SYSTEM_VERSIONING is ON — disable it first
        // (SQL Server only; Postgres drops the trigger/history separately). Signum's DropTable.
        const disable = !this.isPostgres && arg.temporalTableName != null
            ? this.alterTableDisableSystemVersioning(arg.name) : undefined;
        return SqlPreCommand.combine(Spacing.Simple, disable, new SqlPreCommandSimple(`DROP TABLE ${this.objectName(arg.name)};`))!;
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
            || !diffColumn.scaleEquals(column) || !diffColumn.sizeEquals(column, this.isPostgres) || !diffColumn.precisionEquals(column);

        const parts: (SqlPreCommand | undefined)[] = [
            typeChanged ? new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} TYPE ${this.getColumnType(column)}${collate};`) : undefined,
            diffColumn.nullable && !nullable ? new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} SET NOT NULL;`) : undefined,
            !diffColumn.nullable && nullable ? new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} DROP NOT NULL;`) : undefined,
        ];

        return SqlPreCommand.combine(Spacing.Simple, ...parts)
            ?? new SqlPreCommandSimple(`ALTER TABLE ${this.objectName(tableName)} ALTER COLUMN ${escName} -- UNEXPECTED COLUMN CHANGE!!`);
    }

    // Migrate ONLY a column's identity attribute (add or remove) on a type-compatible column, preserving
    // the existing values and FK dependents — Signum's ID_Old rename + PrimaryKeyUpdater solves the same
    // case (as part of its int→guid migration). The naive DROP+ADD would discard the ids and fail on FKs.
    //
    //  - Postgres CAN attach/detach IDENTITY to an existing populated column in place (ALTER COLUMN ADD/DROP
    //    GENERATED …), so nothing is dropped and no FK is touched. When ADDING, the identity sequence is
    //    reseeded to MAX(col)+1 so the next DB-assigned id doesn't collide with the existing rows.
    //  - SQL Server can't ALTER a column to IDENTITY, so it needs a table rebuild (Signum's MoveRows with
    //    IDENTITY_INSERT). That requires dropping/recreating the inbound FKs, which altea's synchronizer
    //    doesn't yet orchestrate — so it is emitted as a commented, explicit manual-migration block rather
    //    than silently-wrong DDL (documented follow-on; a fresh generate makes the table correct directly).
    alterColumnChangeIdentity(table: Table, column: IColumn, _diffColumn: DiffColumn, _withHistory: boolean): SqlPreCommand {
        const tableName = this.objectName(table.name);
        const col = this.sqlEscape(column.name);

        if (this.isPostgres) {
            if (!column.identity)
                return new SqlPreCommandSimple(`ALTER TABLE ${tableName} ALTER COLUMN ${col} DROP IDENTITY IF EXISTS;`);

            const add = new SqlPreCommandSimple(`ALTER TABLE ${tableName} ALTER COLUMN ${col} ADD GENERATED ALWAYS AS IDENTITY;`);
            // Reseed the just-created identity sequence past the existing rows (empty table → next id = 1).
            const schema = table.name.schema.name !== '' ? table.name.schema.name : 'public';
            const regclass = `${schema}.${table.name.name}`.replace(/'/g, "''");
            const colLit = column.name.replace(/'/g, "''");
            const reseed = new SqlPreCommandSimple(
                `SELECT setval(pg_get_serial_sequence('${regclass}', '${colLit}'), COALESCE((SELECT MAX(${col}) FROM ${tableName}), 0) + 1, false);`);
            return SqlPreCommand.combine(Spacing.Simple, add, reseed)!;
        }

        // SQL Server: a rebuild (see method doc). Emitted commented so the sync doesn't ship half-applied DDL.
        return new SqlPreCommandSimple(
            `-- MANUAL MIGRATION REQUIRED: change ${tableName}.${col} to IDENTITY (SQL Server cannot ALTER a\n` +
            `-- column to IDENTITY in place). Rebuild the table with IDENTITY_INSERT preserving the ids, or\n` +
            `-- regenerate the database from scratch. altea's FK-orchestrated rebuild (Signum's ID_Old +\n` +
            `-- PrimaryKeyUpdater) is a follow-on; this migration currently applies on PostgreSQL only.`);
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

    // Drops the table's primary-key constraint so a PK-type change (int→guid) can recreate it. On Postgres,
    // the constraint name is known (the DB diff carries it — `constraintName`); on SQL Server it's
    // discovered at run time. Faithful to Signum's DropPrimaryKeyConstraint.
    dropPrimaryKeyConstraint(tableName: ObjectName, constraintName?: string): SqlPreCommandSimple {
        const full = this.objectName(tableName);
        if (this.isPostgres) {
            const pk = constraintName ?? this.primaryKeyName(tableName.name);
            return new SqlPreCommandSimple(`ALTER TABLE ${full} DROP CONSTRAINT ${this.sqlEscape(pk)};`);
        }
        const varName = 'PrimaryKey_Constraint_' + tableName.name;
        const command =
`DECLARE @${varName} nvarchar(max)
SELECT  @${varName} = 'ALTER TABLE ${full} DROP CONSTRAINT [' + kc.name  + '];'
FROM sys.key_constraints kc
WHERE kc.parent_object_id = OBJECT_ID('${full}')
EXEC dbo.sp_executesql @${varName}`;
        return new SqlPreCommandSimple(command);
    }

    // Adds a primary-key constraint on an existing table (the recreate half of a PK-type migration). altea
    // otherwise only emits the PK inline in CREATE TABLE — this is the ALTER-TABLE form Signum's ID_Old path
    // needs. Uses the same constraint name (pk_<table>) as createTableSql, so a later sync sees no drift.
    alterTableAddPrimaryKey(table: Table): SqlPreCommandSimple {
        const pkName = this.sqlEscape(this.primaryKeyName(table.name.name));
        const pkCol = this.sqlEscape(table.primaryKey.column.name);
        return new SqlPreCommandSimple(
            `ALTER TABLE ${this.objectName(table.name)} ADD CONSTRAINT ${pkName} PRIMARY KEY (${pkCol});`);
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
