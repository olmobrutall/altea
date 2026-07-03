import { Connector } from "../connection/connector";
import type { IColumn } from "../schema/column";
import type { ObjectName } from "../schema/objectName";
import type { Table } from "../schema/table";
import { AbstractDbType } from "../schema/dbType";
import { DiffColumn, DiffTable } from "./diffModels";
import { SqlBuilder, DefaultConstraint } from "./sqlBuilder";
import { SqlPreCommand, SqlPreCommandSimple, Spacing } from "./sqlPreCommand";
import { Synchronizer, Replacements } from "./synchronizer";
import { getDatabaseDescription as getSqlServerDescription } from "./sqlServer/sysTablesSchema";

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

    if (isPostgres)
        throw new Error("SchemaSynchronizer: the Postgres catalog reader is not ported yet (M3-Postgres). SQL Server only for now.");

    let databaseTables = await getSqlServerDescription();

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

    return SqlPreCommand.combine(Spacing.Triple, dropForeignKeys, tables, addForeignKeys);
}

// ---- helpers ----------------------------------------------------------------

function colMap(columns: { [name: string]: IColumn } | { [name: string]: DiffColumn }): Map<string, any> {
    return new Map(Object.entries(columns));
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
