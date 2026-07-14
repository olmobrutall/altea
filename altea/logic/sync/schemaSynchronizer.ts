import { Connector } from "../connection/connector";
import type { IColumn } from "../schema/column";
import { ObjectName, SchemaName, DatabaseName } from "../schema/objectName";
import type { Table } from "../schema/table";
import type { Schema } from "../schema/schema";
import type { TableIndex } from "../schema/tableIndex";
import { AbstractDbType } from "../schema/dbType";
import { DiffColumn, DiffTable, DiffIndex, DiffIndexColumn } from "./diffModels";
import { SqlBuilder, DefaultConstraint } from "./sqlBuilder";
import { SqlPreCommand, SqlPreCommandSimple, SqlPreCommandWithHistory, Spacing } from "./sqlPreCommand";
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

    // A system-versioned table's history table (SQL Server auto-creates it via SYSTEM_VERSIONING;
    // Postgres has an explicit `(LIKE main)` copy) exists in the database but is NOT a standalone
    // model table — so drop it from the main diff, else it reads as an "extra" table and gets
    // dropped (Signum's modelTablesHistory). Its columns track the main table's: automatically on
    // SQL Server, and — since Postgres has no native support — via a dedicated history-table drift
    // pass below. Capture the diffed history tables (keyed by history name) and a parallel map of
    // the owning MODEL tables so that pass can diff them; both are Postgres-only.
    const modelTablesHistory = new Map<string, Table>();
    const databaseTablesHistory = new Map<string, DiffTable>();
    for (const t of schema.tables.values()) {
        if (t.systemVersioned == null)
            continue;
        const historyKey = t.systemVersioned.historyTableName.toString();
        if (isPostgres) {
            modelTablesHistory.set(historyKey, t);
            const diffHistory = databaseTables.get(historyKey);
            if (diffHistory != null)
                databaseTablesHistory.set(historyKey, diffHistory);
        }
        databaseTables.delete(historyKey);
    }

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
    // On Postgres a system-versioned table's column changes must also be applied to its explicit
    // `(LIKE main)` history table. Following Signum, the column diff is built ONCE and each command
    // is a SqlPreCommandWithHistory carrying a `normal` (main table) and `history` (history table)
    // variant; `forNormal` feeds the main script here, `forHistory` is collected into
    // `delayedHistoryColumns` and replayed on the history table after the main tables. SQL Server
    // keeps versioning ON and propagates automatically, so it is never built with-history. (Signum
    // additionally forks for its SS disable/enable strong-change path — deferred in altea.)
    const delayedHistoryColumns: (SqlPreCommand | undefined)[] = [];

    const tables = Synchronizer.synchronizeScript(
        Spacing.Double,
        modelTables,
        databaseTables,
        (tn, tab) => sqlBuilder.createTableSql(tab),
        (tn, dif) => sqlBuilder.dropTable(dif.name),
        (tn, tab, dif) => {
            const rename = dif.name.toString() !== tab.name.toString() ? sqlBuilder.renameTable(dif.name, tab.name.name) : undefined;

            // Fork column changes to the history table only when the model is versioned AND the DB
            // is actually versioned (the trigger is present) — Signum's `withHistory` gate. On a
            // freshly-versioned table with no trigger yet, the history table is created afresh
            // (LIKE main) by the historyTables pass, so there is nothing to replay.
            const withHistory = isPostgres && tab.systemVersioned != null && dif.versioningTrigger != null;

            const columnBoth = Synchronizer.synchronizeScript(
                Spacing.Simple,
                colMap(tab.columns),
                colMap(dif.columns),
                (cn, tabCol) => alterTableAddColumnDefault(sqlBuilder, tab, tabCol, withHistory),
                (cn, difCol) => SqlPreCommand.combine(Spacing.Simple,
                    difCol.defaultConstraint?.name != null ? sqlBuilder.alterTableDropConstraint(tab.name, difCol.defaultConstraint.name) : undefined,
                    sqlBuilder.alterTableDropColumn(tab, cn, withHistory)),
                (cn, tabCol, difCol) => {
                    if (!difCol.compatibleTypes(tabCol) || difCol.identity !== tabCol.identity) {
                        // Incompatible: drop and recreate the column (with a zero/empty backfill),
                        // forking both to the history table when versioned.
                        const addColumn = withHistory
                            ? new SqlPreCommandWithHistory(
                                alterTableAddColumnDefaultZero(sqlBuilder, tab, tabCol, /* forHistory */ false),
                                alterTableAddColumnDefaultZero(sqlBuilder, tab, tabCol, /* forHistory */ true))
                            : alterTableAddColumnDefaultZero(sqlBuilder, tab, tabCol, /* forHistory */ false);
                        return SqlPreCommand.combine(Spacing.Simple,
                            difCol.defaultConstraint != null ? sqlBuilder.alterTableDropDefaultConstaint(tab.name, difCol.name, difCol.defaultConstraint.name) : undefined,
                            sqlBuilder.alterTableDropColumn(tab, difCol.name, withHistory),
                            addColumn);
                    }

                    const columnEquals = difCol.columnEquals(tabCol, /* ignorePrimaryKey */ true, /* ignoreIdentity */ false);
                    const defaultEquals = difCol.defaultEquals(tabCol);

                    // NOTE: the default-constraint drop/add stay main-only (plain) — Signum forks
                    // the drop too, but altea's system-versioned entities never declare column
                    // defaults, so this branch can't fork in practice (documented divergence).
                    return SqlPreCommand.combine(Spacing.Simple,
                        difCol.name === tabCol.name ? undefined : sqlBuilder.renameColumn(tab, difCol.name, tabCol.name, withHistory),
                        (!columnEquals || !defaultEquals) && difCol.defaultConstraint != null ? sqlBuilder.alterTableDropDefaultConstaint(tab.name, difCol.name, difCol.defaultConstraint.name) : undefined,
                        columnEquals ? undefined : sqlBuilder.alterTableAlterColumn(tab, tabCol, difCol, withHistory),
                        (!columnEquals || !defaultEquals) && tabCol.default != null ? sqlBuilder.alterTableAddDefaultConstraint(tab.name, sqlBuilder.getDefaultConstaint(tab.name, tabCol)!) : undefined);
                },
            );

            const columns = SqlPreCommandWithHistory.forNormal(columnBoth);
            if (withHistory) {
                const columnsHistory = SqlPreCommandWithHistory.forHistory(columnBoth);
                if (columnsHistory != null)
                    delayedHistoryColumns.push(columnsHistory);
            }

            return SqlPreCommand.combine(Spacing.Simple, rename, columns);
        },
    );

    // ---- Postgres history tables + versioning triggers -----------------------
    // SQL Server maintains the history table automatically, so both passes are Postgres-only.
    // `historyTables` owns only the history table's own lifecycle — CREATE (LIKE main) when
    // missing, DROP when the model is no longer versioned — mirroring Signum's historyTables pass;
    // its COLUMNS are kept in step by the delayed `forHistory` replay above, not by an independent
    // diff. mergeBoth is a no-op: both maps are keyed by the model history name, so a match means
    // the DB history table already has the right name. A history-table RENAME (which only arises
    // when the entity's own table is renamed) would need the Replacements/RenameOrMove wiring
    // Signum uses to move rows across the old→new name; that is deferred, so an entity-table rename
    // currently recreates the history table (via createNew/removeOld) rather than renaming it.
    const historyTables = !isPostgres ? undefined : Synchronizer.synchronizeScript(
        Spacing.Double,
        modelTablesHistory,
        databaseTablesHistory,
        (hn, tab) => sqlBuilder.createHistoryTableSql(tab),
        (hn, dif) => sqlBuilder.dropTable(dif.name),
        (_hn, _tab, _dif) => undefined,
    );

    // The versioning trigger: create it when the model is versioned but the DB has none, drop it
    // when the model is no longer versioned, and CREATE OR REPLACE it when its stored arguments
    // (the sys_period column, history table, AND — Option C — the column list) drifted from what
    // the model would emit. The args come from the reader's decode of pg_trigger.tgargs; comparing
    // them (Signum compares the parsed history-table name via ParseVersionFunctionParam — altea
    // also compares the column list, which its generic function carries).
    const versioningTriggers = !isPostgres ? undefined : Synchronizer.synchronizeScript(
        Spacing.Double,
        modelTables,
        databaseTables,
        (tn, tab) => tab.systemVersioned != null ? sqlBuilder.createVersioningTrigger(tab) : undefined,
        undefined,
        (tn, tab, dif) => {
            if (tab.systemVersioned == null)
                return dif.versioningTrigger == null ? undefined : sqlBuilder.dropVersioningTrigger(tab.name, dif.versioningTrigger.tgname);
            if (dif.versioningTrigger == null)
                return sqlBuilder.createVersioningTrigger(tab);
            return triggerArgsEqual(dif.versioningTrigger.args, sqlBuilder.versioningTriggerArgs(tab))
                ? undefined
                : sqlBuilder.createVersioningTrigger(tab, /* replace */ true);
        },
    );

    const delayedHistory = SqlPreCommand.combine(Spacing.Double, ...delayedHistoryColumns);

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

    // Order: main tables, then the history tables' own lifecycle, then the delayed history-column
    // replay (targets history tables that now exist), then the trigger re-emit last (after the
    // history columns match). historyTables/delayedHistory/versioningTriggers are no-ops on SS.
    return SqlPreCommand.combine(Spacing.Triple, dropForeignKeys, dropIndices, tables, historyTables, delayedHistory, versioningTriggers, addForeignKeys, addIndices);
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

// Port of Signum's AlterTableAddColumnDefault (scoped: no Forced/HasValue/PartitionId/Embedded
// paths — altea's columns are plain value / reference / identity-PK / period). Adds a column,
// seeding a temporary default so a NOT NULL column's existing rows are backfilled, then dropping
// it. When `withHistory`, returns a SqlPreCommandWithHistory whose history half retargets the same
// add at the history table — which HAS rows, so the backfill matters there too.
function alterTableAddColumnDefault(sqlBuilder: SqlBuilder, table: Table, column: IColumn, withHistory: boolean): SqlPreCommand {
    const addColumnWithHistory = (): SqlPreCommand => !withHistory
        ? sqlBuilder.alterTableAddColumn(table, column)
        : new SqlPreCommandWithHistory(
            sqlBuilder.alterTableAddColumn(table, column),
            sqlBuilder.alterTableAddColumn(table, column, undefined, /* forHistory */ true));

    if (!needsDefaultValue(column, /* forHistory */ false))
        return addColumnWithHistory();

    const tempDefault = tempDefaultFor(sqlBuilder, column);
    const mainPair = SqlPreCommand.combine(Spacing.Simple,
        sqlBuilder.alterTableAddColumn(table, column, tempDefault),
        sqlBuilder.alterTableDropDefaultConstaint(table.name, column.name, tempDefault.name))!;
    if (!withHistory)
        return mainPair;

    const historyName = table.systemVersioned!.historyTableName;
    const historyPair = SqlPreCommand.combine(Spacing.Simple,
        sqlBuilder.alterTableAddColumn(historyName, column, tempDefault, /* forHistory */ true),
        sqlBuilder.alterTableDropDefaultConstaint(historyName, column.name, tempDefault.name))!;
    return new SqlPreCommandWithHistory(mainPair, historyPair);
}

// Port of Signum's AlterTableAddColumnDefaultZero — the incompatible-type recreate path. Adds the
// column (retargeted to the history table when `forHistory`) with a zero/empty temporary default
// backfilling a NOT NULL column, then drops it.
function alterTableAddColumnDefaultZero(sqlBuilder: SqlBuilder, table: Table, column: IColumn, forHistory: boolean): SqlPreCommand {
    const tableName = forHistory ? table.systemVersioned!.historyTableName : table.name;
    if (!needsDefaultValue(column, forHistory))
        return sqlBuilder.alterTableAddColumn(tableName, column, undefined, forHistory);

    const tempDefault = tempDefaultFor(sqlBuilder, column);
    return SqlPreCommand.combine(Spacing.Simple,
        sqlBuilder.alterTableAddColumn(tableName, column, tempDefault, forHistory),
        sqlBuilder.alterTableDropDefaultConstaint(tableName, column.name, tempDefault.name))!;
}

// Whether adding `column` needs a temporary backfill default (Signum's NeedsDefaultValue, scoped).
// A nullable column never does; an identity or defaulted column needs one only on the history
// table (which has no identity/default of its own but holds rows); everything else (a NOT NULL
// plain column) does.
function needsDefaultValue(column: IColumn, forHistory: boolean): boolean {
    if (column.nullable !== "No")
        return false;
    if (column.identity || column.default != null)
        return forHistory;
    return true;
}

// The DF_TEMP_ zero/empty default used to backfill a new NOT NULL column's existing rows.
function tempDefaultFor(sqlBuilder: SqlBuilder, column: IColumn): DefaultConstraint {
    const defaultValue = defaultValueFor(column.dbType, sqlBuilder.isPostgres);
    return new DefaultConstraint(column.name, "DF_TEMP_" + column.name, sqlBuilder.quote(column.dbType, defaultValue));
}

// Element-wise equality of a DB trigger's decoded args vs the model's expected args (undefined
// DB args ⇒ not equal, so the trigger is re-emitted).
function triggerArgsEqual(dbArgs: string[] | undefined, modelArgs: string[]): boolean {
    return dbArgs != null && dbArgs.length === modelArgs.length && dbArgs.every((v, i) => v === modelArgs[i]);
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
