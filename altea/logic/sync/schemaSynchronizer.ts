import { Connector } from "../connection/connector";
import type { IColumn } from "../schema/column";
import { ObjectName, SchemaName, DatabaseName } from "../schema/objectName";
import type { Table } from "../schema/table";
import type { Schema } from "../schema/schema";
import type { TableIndex } from "../schema/tableIndex";
import { AbstractDbType } from "../schema/dbType";
import { DiffColumn, DiffTable, DiffIndex, DiffIndexColumn } from "./diffModels";
import { SqlBuilder, DefaultConstraint } from "./sqlBuilder";
import { SqlPreCommand, SqlPreCommandSimple, Spacing } from "./sqlPreCommand";
import { Synchronizer, Replacements } from "./synchronizer";
import { getDatabaseDescription as getSqlServerDescription } from "./sqlServer/sysTablesSchema";
import { getDatabaseDescription as getPostgresDescription } from "./postgres/postgresCatalogSchema";
import { EnumEntity, getBoundEnum, enumEntityMembers } from "../../entities/enumEntity";
import { insertSqlSync, updateSqlSync, deleteSqlSync, rowImage } from "../save";
import type { PrimaryKey } from "../../entities/entity";

// The default synchronizing steps (synchronizeSchemasScript / synchronizeTablesScript /
// synchronizeEnumsScript, exported below) are seeded onto Schema.synchronizing by the Schema
// constructor — automatic, like Signum. They only reference Schema as a *type*, so wiring
// them from schema.ts is cycle-free.

// Port of Signum's Engine/Sync/SchemaSynchronizer.SynchronizeTablesScript, scoped to the
// lean synchronizer: schemas/tables/columns/foreign keys. The huge feature set Signum also
// handles here — system-versioning/temporal, partitions, full-text, vector & regular
// indexes, statistics, computed/check constraints, multi-database — is omitted (altea's
// schema model has no equivalent yet). Enum-row synchronization is deferred (a freshly
// generated DB already has the seeded rows, so the script is still null; drift detection
// comes later). Divergence: async (altea's IView readers use async query terminals), so this
// returns a Promise.
export async function synchronizeTablesScript(replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const connector = Connector.current();
    const schema = connector.schema;
    const sqlBuilder = connector.sqlBuilder;
    const isPostgres = connector.isPostgres;

    // Model tables keyed by full name (views live in schema.views, not schema.tables, so
    // they are naturally excluded).
    const modelTables = new Map<string, Table>();
    for (const t of schema.tables.values())
        modelTables.set(t.name.toString(), t);

    let databaseTables = isPostgres ? await getPostgresDescription() : await getSqlServerDescription();

    replacements.askForReplacements(new Set(databaseTables.keys()), new Set(modelTables.keys()), Replacements.keyTables);
    databaseTables = replacements.applyReplacementsToOld(databaseTables, Replacements.keyTables);

    // Per-table column renames (Signum's modelTables.JoinDictionaryForeach). Mutates each
    // matched diff table's `columns` in place to apply the learned column replacements.
    for (const [tn, tab] of modelTables) {
        const diff = databaseTables.get(tn);
        if (diff == null)
            continue;
        const key = Replacements.keyColumnsForTable(tn);
        replacements.askForReplacements(new Set(Object.keys(diff.columns)), new Set(Object.keys(tab.columns)), key);
        diff.columns = applyColumnReplacements(diff.columns, replacements, key);
    }

    // A diff FK's TargetTable, mapped through table renames to the model table name.
    const getNewTableName = (objectName: ObjectName): ObjectName => {
        const name = replacements.apply(Replacements.keyTables, objectName.toString());
        return modelTables.get(name)?.name ?? objectName;
    };

    // ---- drop foreign keys that changed or whose owner column was removed ----
    const dropForeignKeys = Synchronizer.synchronizeScript(
        Spacing.Double,
        modelTables,
        databaseTables,
        undefined,
        (tn, dif) => SqlPreCommand.combine(Spacing.Simple,
            ...Object.values(dif.columns).map(c => c.foreignKey != null ? sqlBuilder.alterTableDropConstraint(dif.name, c.foreignKey.name) : undefined),
            ...dif.multiForeignKeys.map(fk => sqlBuilder.alterTableDropConstraint(dif.name, fk.name))),
        (tn, tab, dif) => Synchronizer.synchronizeScript(
            Spacing.Simple,
            colMap(tab.columns),
            colMap(dif.columns),
            undefined,
            (cn, colDb) => colDb.foreignKey != null ? sqlBuilder.alterTableDropConstraint(dif.name, colDb.foreignKey.name) : undefined,
            (cn, colModel, colDb) => colDb.foreignKey == null ? undefined :
                (colModel.referenceTable == null || colModel.avoidForeignKey
                    || colModel.referenceTable.name.toString() !== getNewTableName(colDb.foreignKey.targetTable).toString()
                    || !dbTypeEqualsActive(colDb.dbType, colModel.dbType, isPostgres))
                    ? sqlBuilder.alterTableDropConstraint(dif.name, colDb.foreignKey.name)
                    : undefined),
    );

    // ---- drop indexes that changed, or whose column was removed/modified -----
    // Runs before column changes (an index must be dropped before its column can be dropped
    // or altered). Mirrors Signum's dropIndices. Primary-key indexes are excluded (the PK is
    // handled separately); a controlled index (IX_/UIX_/CIX_) that no longer matches the model
    // is dropped and recreated in addIndices.
    const dropIndices = Synchronizer.synchronizeScript(
        Spacing.Double,
        modelTables,
        databaseTables,
        undefined,
        (tn, dif) => SqlPreCommand.combine(Spacing.Simple,
            ...Object.values(dif.indices).filter(ix => !ix.isPrimary).map(ix => sqlBuilder.dropIndex(dif.name, ix.indexName))),
        (tn, tab, dif) => Synchronizer.synchronizeScript(
            Spacing.Simple,
            modelIndexMap(sqlBuilder, tab),
            diffIndexMap(dif),
            undefined,
            (i, dix) => dix.isControlledIndex(isPostgres) || dix.columns.some(c => isColumnRemovedOrModified(tab, dif, c))
                ? sqlBuilder.dropIndex(dif.name, dix.indexName)
                : undefined,
            (i, mix, dix) => !dix.indexEquals(dif, mix, isPostgres) ? sqlBuilder.dropIndex(dif.name, dix.indexName) : undefined,
        ),
    );

    // ---- create / drop / alter tables ---------------------------------------
    const tables = Synchronizer.synchronizeScript(
        Spacing.Double,
        modelTables,
        databaseTables,
        (tn, tab) => sqlBuilder.createTableSql(tab),
        (tn, dif) => sqlBuilder.dropTable(dif.name),
        (tn, tab, dif) => {
            const rename = dif.name.toString() !== tab.name.toString() ? sqlBuilder.renameTable(dif.name, tab.name.name) : undefined;

            const columnBoth = Synchronizer.synchronizeScript(
                Spacing.Simple,
                colMap(tab.columns),
                colMap(dif.columns),
                (cn, tabCol) => alterTableAddColumn(sqlBuilder, tab, tabCol),
                (cn, difCol) => SqlPreCommand.combine(Spacing.Simple,
                    difCol.defaultConstraint?.name != null ? sqlBuilder.alterTableDropConstraint(tab.name, difCol.defaultConstraint.name) : undefined,
                    sqlBuilder.alterTableDropColumn(tab.name, cn)),
                (cn, tabCol, difCol) => {
                    if (!difCol.compatibleTypes(tabCol) || difCol.identity !== tabCol.identity) {
                        // Incompatible: drop and recreate the column.
                        return SqlPreCommand.combine(Spacing.Simple,
                            difCol.defaultConstraint != null ? sqlBuilder.alterTableDropDefaultConstaint(tab.name, difCol.name, difCol.defaultConstraint.name) : undefined,
                            sqlBuilder.alterTableDropColumn(tab.name, difCol.name),
                            alterTableAddColumn(sqlBuilder, tab, tabCol));
                    }

                    const columnEquals = difCol.columnEquals(tabCol, /* ignorePrimaryKey */ true, /* ignoreIdentity */ false);
                    const defaultEquals = difCol.defaultEquals(tabCol);

                    return SqlPreCommand.combine(Spacing.Simple,
                        difCol.name === tabCol.name ? undefined : sqlBuilder.renameColumn(tab.name, difCol.name, tabCol.name),
                        (!columnEquals || !defaultEquals) && difCol.defaultConstraint != null ? sqlBuilder.alterTableDropDefaultConstaint(tab.name, difCol.name, difCol.defaultConstraint.name) : undefined,
                        columnEquals ? undefined : sqlBuilder.alterTableAlterColumn(tab, tabCol, difCol),
                        (!columnEquals || !defaultEquals) && tabCol.default != null ? sqlBuilder.alterTableAddDefaultConstraint(tab.name, sqlBuilder.getDefaultConstaint(tab.name, tabCol)!) : undefined);
                },
            );

            return SqlPreCommand.combine(Spacing.Simple, rename, columnBoth);
        },
    );

    // ---- add foreign keys ----------------------------------------------------
    const addForeignKeys = Synchronizer.synchronizeScript(
        Spacing.Double,
        modelTables,
        databaseTables,
        (tn, tab) => sqlBuilder.alterTableForeignKeys(tab),
        undefined,
        (tn, tab, dif) => Synchronizer.synchronizeScript(
            Spacing.Simple,
            colMap(tab.columns),
            colMap(dif.columns),
            (cn, colModel) => colModel.referenceTable == null || colModel.avoidForeignKey ? undefined :
                sqlBuilder.alterTableAddConstraintForeignKey(tab.name, colModel.name, colModel.referenceTable.name, colModel.referenceTable.primaryKey.column.name),
            undefined,
            (cn, tabCol, difCol) => {
                if (tabCol.referenceTable == null || tabCol.avoidForeignKey)
                    return undefined;

                if (difCol.foreignKey == null
                    || tabCol.referenceTable.name.toString() !== getNewTableName(difCol.foreignKey.targetTable).toString()
                    || !dbTypeEqualsActive(difCol.dbType, tabCol.dbType, isPostgres))
                    return sqlBuilder.alterTableAddConstraintForeignKey(tab.name, tabCol.name, tabCol.referenceTable.name, tabCol.referenceTable.primaryKey.column.name);

                const name = sqlBuilder.foreignKeyName(tab.name.name, tabCol.name);
                return name !== difCol.foreignKey.name.name
                    ? sqlBuilder.renameForeignKey(tab.name, difCol.foreignKey.name, name)
                    : undefined;
            },
        ),
    );

    // ---- add indexes missing in the database (or recreate changed ones) ------
    // Runs after columns/FKs exist. Mirrors Signum's addIndices: a brand-new model table gets
    // all its (non-primary) indexes; for an existing table, an index missing in the DB is
    // created, and one whose columns changed is recreated (a plain rename when only the name
    // differs — but our names are the dictionary keys, so a match here means identical names).
    const addIndices = Synchronizer.synchronizeScript(
        Spacing.Double,
        modelTables,
        databaseTables,
        (tn, tab) => SqlPreCommand.combine(Spacing.Simple,
            ...tab.indexes.map(index => sqlBuilder.createIndex(index))),
        undefined,
        (tn, tab, dif) => Synchronizer.synchronizeScript(
            Spacing.Simple,
            modelIndexMap(sqlBuilder, tab),
            diffIndexMap(dif),
            (i, mix) => sqlBuilder.createIndex(mix),
            undefined,
            (i, mix, dix) => !dix.indexEquals(dif, mix, isPostgres) ? sqlBuilder.createIndex(mix) : undefined,
        ),
    );

    return SqlPreCommand.combine(Spacing.Triple, dropForeignKeys, dropIndices, tables, addForeignKeys, addIndices);
}

// ---- helpers ----------------------------------------------------------------

function colMap(columns: { [name: string]: IColumn } | { [name: string]: DiffColumn }): Map<string, any> {
    return new Map(Object.entries(columns));
}

// The model table's indexes keyed by their computed name (the same name SqlBuilder emits in
// CREATE INDEX), so they align with the DB indexes read by the catalog readers. Uniqueness and
// the WHERE/INCLUDE signature are folded into that name, so a change to either surfaces as a
// key mismatch (drop + create) rather than a merge.
function modelIndexMap(sqlBuilder: SqlBuilder, tab: Table): Map<string, TableIndex> {
    const m = new Map<string, TableIndex>();
    for (const ix of tab.indexes)
        m.set(sqlBuilder.indexName(ix), ix);
    return m;
}

// The DB table's indexes keyed by name, excluding the primary-key index (handled separately).
function diffIndexMap(dif: DiffTable): Map<string, DiffIndex> {
    const m = new Map<string, DiffIndex>();
    for (const [name, ix] of Object.entries(dif.indices))
        if (!ix.isPrimary)
            m.set(name, ix);
    return m;
}

// Whether a DB index column's underlying column was removed from the model, or its type
// changed (so the index must be dropped rather than kept). The DiffIndexColumn carries the DB
// (old) column name; map it through the applied column replacements to the model key, then
// compare (Signum's IsColumnRemovedOrModified).
function isColumnRemovedOrModified(tab: Table, dif: DiffTable, c: DiffIndexColumn): boolean {
    const newName = dif.columns[c.columnName] != null
        ? c.columnName
        : Object.entries(dif.columns).find(([, v]) => v.name === c.columnName)?.[0];
    if (newName == null)
        return true;
    const tc = tab.columns[newName];
    return tc == null || !dif.columns[newName].columnEquals(tc, /* ignorePrimaryKey */ true, /* ignoreIdentity */ true);
}

// Add a column, seeding a temporary default for a NOT NULL column so existing rows get a
// value (Signum's AlterTableAddColumnDefault, trimmed: no HasValue/PartitionId/history
// special cases — those don't occur when syncing a freshly generated DB).
function alterTableAddColumn(sqlBuilder: SqlBuilder, table: Table, column: IColumn): SqlPreCommand {
    if (column.nullable !== "No" || column.identity || column.default != null)
        return sqlBuilder.alterTableAddColumn(table.name, column);

    const defaultValue = defaultValueFor(column.dbType, sqlBuilder.isPostgres);
    const tempDefault = new DefaultConstraint(column.name, "DF_TEMP_" + column.name, sqlBuilder.quote(column.dbType, defaultValue));
    return SqlPreCommand.combine(Spacing.Simple,
        sqlBuilder.alterTableAddColumn(table.name, column, tempDefault),
        sqlBuilder.alterTableDropDefaultConstaint(table.name, column.name, tempDefault.name))!;
}

// A type-appropriate zero/empty default for backfilling a new NOT NULL column.
function defaultValueFor(dbType: AbstractDbType, isPostgres: boolean): string {
    if (dbType.isBoolean()) return isPostgres ? "false" : "0";
    if (dbType.isNumber()) return "0";
    if (dbType.isString()) return "''";
    if (dbType.isDate()) return isPostgres ? "now()" : "GetDate()";
    if (dbType.isGuid()) return isPostgres ? "gen_random_uuid()" : "NEWID()";
    if (dbType.isTime()) return "'00:00'";
    return "?";
}

// Compare only the active dialect's type name (Signum's AbstractDbType.Equals is single-
// dialect; altea stores both, and a DB-read column only fills the read dialect).
function dbTypeEqualsActive(a: AbstractDbType, b: AbstractDbType, isPostgres: boolean): boolean {
    return isPostgres ? a.postgres === b.postgres : a.sqlServer === b.sqlServer;
}

function applyColumnReplacements(columns: { [name: string]: DiffColumn }, replacements: Replacements, key: string): { [name: string]: DiffColumn } {
    const rep = replacements.tryGetC(key);
    if (rep == null)
        return columns;
    const result: { [name: string]: DiffColumn } = {};
    for (const [name, col] of Object.entries(columns))
        result[rep.get(name) ?? name] = col;
    return result;
}

// ---- schema (CREATE / DROP SCHEMA) sync -------------------------------------

// Port of the schema half of Signum's SynchronizeTablesScript (createSchemas). Creates any
// named (non-default) schema the model needs that the database lacks. The music model uses
// only the default schema, so this is a no-op there. (DROP SCHEMA of a removed named schema
// is deferred — it needs the late-ordering Signum gives it within the one combined script.)
export async function synchronizeSchemasScript(_replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const connector = Connector.current();
    const sqlBuilder = connector.sqlBuilder;

    const modelSchemas = new Set<string>();
    for (const t of connector.schema.tables.values())
        if (t.name.schema.name !== "")
            modelSchemas.add(t.name.schema.name);

    if (modelSchemas.size === 0)
        return undefined; // only the default schema — nothing to create

    const existing = await readSchemaNames(connector);
    const creates = [...modelSchemas]
        .filter(s => !existing.has(s))
        .map(s => sqlBuilder.createSchema(new SchemaName(s, new DatabaseName(""))));
    return SqlPreCommand.combine(Spacing.Double, ...creates);
}

async function readSchemaNames(connector: Connector): Promise<Set<string>> {
    const sql = connector.isPostgres
        ? "SELECT nspname AS name FROM pg_catalog.pg_namespace"
        : "SELECT name FROM sys.schemas";
    const rows = await connector.executeQuery(sql) as { name: string }[];
    return new Set(rows.map(r => r.name));
}

// ---- enum-row sync (SynchronizeEnumsScript) ---------------------------------

// Port of Signum's SchemaSynchronizer.SynchronizeEnumsScript. For every EnumEntity<T> table,
// diff the *rows*: the expected members (from the enum definition) vs the current DB rows,
// producing INSERT / UPDATE / DELETE. NOT a shortcut: it reads and writes EVERY column of the
// enum table (so an enum with a mixin syncs its mixin columns), and it reads the current rows
// tolerant of renamed columns (via the column Replacements the tables step also uses). Row
// renames (a member renamed) are asked via the enum Replacements; a member that changed id is
// re-inserted, its incoming references moved, and the old row deleted.
export async function synchronizeEnumsScript(replacements: Replacements): Promise<SqlPreCommand | undefined> {
    const connector = Connector.current();
    const schema = connector.schema;
    const sqlBuilder = connector.sqlBuilder;
    const commands: (SqlPreCommand | undefined)[] = [];

    for (const table of schema.tables.values()) {
        const enumObject = getBoundEnum(table.type);
        if (enumObject == null)
            continue;

        const nameCol = table.fields["name"].field.columns()[0].name;
        const pkCol = table.primaryKey.column.name;

        // should: the expected rows, as full entities (id + name; a mixin's columns come from
        // the entity's own defaults). insertSqlSync/updateSqlSync/rowImage cover mixins.
        const shouldByName = new Map<string, EnumEntity>();
        for (const m of enumEntityMembers(enumObject)) {
            const e = new EnumEntity(enumObject);
            e.id = m.id;
            e.name = m.name;
            shouldByName.set(m.name, e);
        }

        // current: the DB rows (every column, incl mixins; renamed columns read via the
        // tables step's column replacements), keyed by member name.
        const currentByName = new Map<string, { id: PrimaryKey; image: Map<string, unknown> }>();
        for (const row of await retrieveEnumRows(table, replacements))
            currentByName.set(String(row.get(nameCol)), { id: row.get(pkCol) as PrimaryKey, image: row });

        // Ask which removed member each new member renames (by name), then apply.
        const key = Replacements.keyEnumsForTable(table.name.name);
        replacements.askForReplacements(new Set(currentByName.keys()), new Set(shouldByName.keys()), key);
        const rep = replacements.tryGetC(key);
        const current = new Map<string, { id: PrimaryKey; image: Map<string, unknown> }>();
        for (const [name, v] of currentByName)
            current.set(rep?.get(name) ?? name, v);

        for (const name of new Set([...shouldByName.keys(), ...current.keys()])) {
            const should = shouldByName.get(name);
            const cur = current.get(name);

            if (should != null && cur == null) {
                commands.push(insertSqlSync(table, should));
            } else if (should == null && cur != null) {
                commands.push(deleteSqlSync(table, enumRowWithId(enumObject, cur.id)));
            } else if (should != null && cur != null) {
                if (should.id === cur.id) {
                    if (!imageEquals(rowImage(table, should), cur.image))
                        commands.push(updateSqlSync(table, should));
                } else {
                    // Re-id: insert the member at its new id, move every incoming reference,
                    // delete the old row. (The temporary-middle-id dance Signum uses to avoid
                    // a collision when the new id is still in use is not ported yet.)
                    commands.push(insertSqlSync(table, should));
                    commands.push(moveReferences(schema, sqlBuilder, table, cur.id, should.id));
                    commands.push(deleteSqlSync(table, enumRowWithId(enumObject, cur.id)));
                }
            }
        }
    }

    return SqlPreCommand.combine(Spacing.Double, ...commands);
}

// A bare EnumEntity carrying just an id, for building a DELETE (deleteSqlSync reads only id).
function enumRowWithId(enumObject: object, id: PrimaryKey): EnumEntity {
    const e = new EnumEntity(enumObject);
    e.id = id;
    return e;
}

// Reads every row of an enum table, one Map<physicalColumnName, value> per row. Selects each
// column by the name it currently has in the DB (the tables step's column replacement maps a
// DB-old name → model-new name; we invert it to read the old name AS the model name), so a
// column renamed in the model is still read correctly at generation time.
async function retrieveEnumRows(table: Table, replacements: Replacements): Promise<Map<string, unknown>[]> {
    const connector = Connector.current();
    const sqlBuilder = connector.sqlBuilder;
    const columns = Object.values(table.columns);

    const colRep = replacements.tryGetC(Replacements.keyColumnsForTable(table.name.name));
    const dbNameOf = (modelName: string): string => {
        if (colRep == null)
            return modelName;
        for (const [oldName, newName] of colRep)
            if (newName === modelName)
                return oldName;
        return modelName;
    };

    const select = columns.map(c => `${sqlBuilder.sqlEscape(dbNameOf(c.name))} AS ${sqlBuilder.sqlEscape(c.name)}`).join(", ");
    const rows = await connector.executeQuery(`SELECT ${select} FROM ${sqlBuilder.objectName(table.name)}`) as Record<string, unknown>[];
    return rows.map(r => new Map(columns.map(c => [c.name, r[c.name]])));
}

// Loose equality of two column-value images (keyed by physical column name). Values are
// coerced to string (null → "") since the DB round-trips numbers/strings loosely.
function imageEquals(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
    if (a.size !== b.size)
        return false;
    for (const [k, v] of a)
        if (norm(v) !== norm(b.get(k)))
            return false;
    return true;
}
function norm(v: unknown): string {
    return v == null ? "" : String(v);
}

// UPDATE every incoming reference to an enum row from oldId to newId (Signum's re-index move).
function moveReferences(schema: Schema, sqlBuilder: SqlBuilder, enumTable: Table, oldId: PrimaryKey, newId: PrimaryKey): SqlPreCommand | undefined {
    const cmds: SqlPreCommand[] = [];
    for (const t of schema.tables.values())
        for (const col of Object.values(t.columns))
            if (col.referenceTable === enumTable)
                cmds.push(new SqlPreCommandSimple(`UPDATE ${sqlBuilder.objectName(t.name)} SET ${sqlBuilder.sqlEscape(col.name)} = ${newId} WHERE ${sqlBuilder.sqlEscape(col.name)} = ${oldId};`));
    return SqlPreCommand.combine(Spacing.Simple, ...cmds);
}
