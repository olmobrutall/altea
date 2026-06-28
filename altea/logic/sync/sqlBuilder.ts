import type { Connector } from '../connection/connector';
import type { IColumn } from '../schema/column';
import { isNullableToBool } from '../schema/dbType';
import { ObjectName, SchemaName } from '../schema/objectName';
import type { Table } from '../schema/table';
import { SqlPreCommand, SqlPreCommandSimple, Spacing } from './sqlPreCommand';

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
        const lines = Object.values(table.columns).map(c => this.columnLine(c));

        const pk = table.primaryKey.column;
        const pkName = this.sqlEscape(this.primaryKeyName(table.name.name));
        const pkCol = this.sqlEscape(pk.name);
        const pkConstraint = this.isPostgres
            ? `CONSTRAINT ${pkName} PRIMARY KEY (${pkCol})`
            : `CONSTRAINT ${pkName} PRIMARY KEY CLUSTERED (${pkCol} ASC)`;
        lines.push(pkConstraint);

        const body = lines.map(l => `  ${l}`).join(',\n');
        return new SqlPreCommandSimple(`CREATE TABLE ${this.objectName(table.name)}(\n${body}\n);`);
    }

    // A single column declaration: name type [IDENTITY] (NULL|NOT NULL) [DEFAULT].
    columnLine(c: IColumn): string {
        const parts: (string | undefined)[] = [
            this.sqlEscape(c.name),
            this.getColumnType(c),
            c.identity ? (this.isPostgres ? 'GENERATED ALWAYS AS IDENTITY' : 'IDENTITY') : undefined,
            c.collation != null ? `COLLATE ${c.collation}` : undefined,
            isNullableToBool(c.nullable) ? 'NULL' : 'NOT NULL',
            c.default != null ? `DEFAULT ${this.quote(c, c.default)}` : undefined,
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

    private quote(c: IColumn, value: string): string {
        const t = (this.isPostgres ? c.dbType.postgres : c.dbType.sqlServer).toLowerCase();
        const isString = t.includes('char') || t.includes('text');
        if (isString && !value.startsWith("'"))
            return `'${value.replace(/'/g, "''")}'`;
        return value;
    }

    // ---- Foreign keys -------------------------------------------------------

    // One ALTER TABLE ... ADD CONSTRAINT per FK column. Run after every table
    // exists so referenced tables are present. Columns flagged avoidForeignKey
    // (or with no referenceTable) emit nothing.
    alterTableForeignKeys(table: Table): SqlPreCommand | undefined {
        const cmds = Object.values(table.columns)
            .filter(c => c.referenceTable != null && !c.avoidForeignKey)
            .map(c => this.alterTableAddConstraintForeignKey(table, c));
        return SqlPreCommand.combine(Spacing.Simple, ...cmds);
    }

    private alterTableAddConstraintForeignKey(table: Table, column: IColumn): SqlPreCommand {
        const target = column.referenceTable!;
        return new SqlPreCommandSimple(
            `ALTER TABLE ${this.objectName(table.name)} ADD CONSTRAINT ${this.sqlEscape(this.foreignKeyName(table.name.name, column.name))} ` +
            `FOREIGN KEY (${this.sqlEscape(column.name)}) REFERENCES ${this.objectName(target.name)}(${this.sqlEscape(target.primaryKey.column.name)});`,
        );
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
        return this.chopHash(`${prefix}_${table}_${column}`);
    }

    primaryKeyName(table: string): string {
        const prefix = this.isPostgres ? 'pk' : 'PK';
        return this.chopHash(`${prefix}_${table}`);
    }

    // Truncates an over-long identifier and appends a short deterministic hash so
    // it stays unique within the DB's name-length limit. Mirrors Signum's
    // StringHashEncoder.ChopHash.
    private chopHash(name: string): string {
        const max = this.maxNameLength;
        if (name.length <= max)
            return name;
        const hash = hash8(name);
        return name.substring(0, max - hash.length - 1) + '_' + hash;
    }
}

// Sentinel size meaning "max length" (nvarchar(MAX) / text). Reserved; the
// schema builder does not emit it yet.
export const MAX_SIZE = -1;

// 8-char base-36 hash of a string (FNV-1a). Deterministic, collision-resistant
// enough for disambiguating truncated constraint names.
function hash8(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

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
