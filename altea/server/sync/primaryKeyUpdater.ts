import type { IColumn } from '../schema/column';
import { ImplementedByAllIdColumn, ImplementedByAllTypeColumn } from '../schema/column';
import type { Table } from '../schema/table';
import { ObjectName } from '../schema/objectName';
import type { AbstractDbType } from '../schema/dbType';
import type { DiffTable, DiffColumn } from './diffModels';
import { SqlPreCommand, SqlPreCommandSimple, SqlPreCommandWithHistory, Spacing } from './sqlPreCommand';
import type { SqlBuilder } from './sqlBuilder';
import type { Schema } from '../schema/schema';
import type { Replacements } from './synchronizer';
import { readLineSync } from './synchronizer';
import { isNullableToBool } from '../schema/dbType';

// Port of Signum's PrimaryKeyUpdater (old/Framework/Signum/Engine/Sync/PrimaryKeyUpdater.cs). When an
// entity's primary key changes type (the common case: int-identity → guid) the PK column is renamed to
// `<pk>_old`, a fresh PK column is added (new guid/identity values), and every place that stored the OLD
// key value must be re-pointed to the NEW one by joining on the `_old` column. This class emits those
// data-migration UPDATEs:
//   - `updateForeignKeyTypeChanged` — a plain FK column in a dependent table (its type changed too, so it
//      was likewise renamed to `_old`); re-point it to the referenced row's new PK.
//   - `updateImplementedByAll` — the @implementedByAll id column (type-keyed) that stored the old key.
//   - `updateHistoryTable` — the system-versioned history rows' own PK.
//
// altea divergences: no GoBefore/GoAfter (the caller sequences these into a delayed phase); the UPDATE…JOIN
// is hand-emitted raw SQL (like schemaSynchronizer.moveReferences), dialect-branched (Postgres UPDATE …
// FROM … WHERE; SQL Server UPDATE t SET … FROM t JOIN s ON …).

export type PreRenameMap = Map<string /*tableKey*/, Map<string /*newColName*/, string /*oldColName*/>>;

export class PrimaryKeyUpdater {
    private readonly typeTable?: Table;
    private readonly typeIdCol?: string;
    private readonly typeTableNameCol?: string;

    constructor(
        private readonly isPostgres: boolean,
        private readonly sqlBuilder: SqlBuilder,
        private readonly modelTables: Map<string, Table>,
        schema: Schema,
    ) {
        // Resolve the TypeEntity table + its id / clean-name columns (needed by @implementedByAll, which
        // maps an id back to a concrete table through the type discriminator). Best-effort — a database
        // without @implementedByAll never calls updateImplementedByAll.
        const typeTable = [...schema.tables.values()].find(t => t.name.name === 'type' || t.name.name === 'Type');
        if (typeTable != null) {
            this.typeTable = typeTable;
            this.typeIdCol = typeTable.primaryKey.column.name;
            // TypeEntity stores the entity's table name (Signum's TypeEntity.TableName); altea's column is
            // `table_name` (snake) / `TableName`.
            this.typeTableNameCol = Object.keys(typeTable.columns).find(c => /table_?name/i.test(c));
        }
    }

    // ---- helpers -------------------------------------------------------------

    private esc(name: string): string { return this.sqlBuilder.sqlEscape(name); }
    private tbl(name: ObjectName): string { return this.sqlBuilder.objectName(name); }

    // UPDATE <target> SET <setClause> FROM/JOIN <source> ON <joinCondition>. `tgt`/`src` are the aliases the
    // set/join clauses must reference.
    private updateJoin(targetTable: ObjectName, setClause: string, sourceTable: ObjectName, joinCondition: string): SqlPreCommandSimple {
        const sql = this.isPostgres
            ? `UPDATE ${this.tbl(targetTable)} tgt SET\n    ${setClause}\nFROM ${this.tbl(sourceTable)} src\nWHERE ${joinCondition};`
            : `UPDATE tgt SET\n    ${setClause}\nFROM ${this.tbl(targetTable)} tgt\nJOIN ${this.tbl(sourceTable)} src ON ${joinCondition};`;
        return new SqlPreCommandSimple(sql);
    }

    // ---- foreign-key columns (Signum's UpdateForeignKeyTypeChanged) ----------

    // The dependent table's FK column `tabCol` (new type) referenced the migrated table; its OLD values are
    // in `difCol` (the `_old`-renamed column). Re-point it to the referenced row's NEW primary key by
    // joining the old FK value against the referenced table's renamed old PK.
    updateForeignKeyTypeChanged(depTable: Table, tabCol: IColumn, difCol: DiffColumn, preRename: PreRenameMap): SqlPreCommand | undefined {
        const refTable = tabCol.referenceTable;
        if (refTable == null || tabCol.avoidForeignKey)
            return undefined;

        const newPk = refTable.primaryKey.column.name;
        const oldPk = preRename.get(refTable.name.toString())?.get(newPk);
        if (oldPk == null)
            return undefined; // the referenced table's PK didn't migrate — nothing to cascade

        const result = this.updateJoin(
            depTable.name,
            `${this.esc(tabCol.name)} = src.${this.esc(newPk)}`,
            refTable.name,
            `tgt.${this.esc(difCol.name)} = src.${this.esc(oldPk)}`,
        );

        if (depTable.systemVersioned == null)
            return result;

        // System-versioned dependent: repeat the re-point on the history rows.
        const history = this.updateJoin(
            depTable.systemVersioned.historyTableName,
            `${this.esc(tabCol.name)} = src.${this.esc(newPk)}`,
            refTable.name,
            `tgt.${this.esc(difCol.name)} = src.${this.esc(oldPk)}`,
        );
        return SqlPreCommand.combine(Spacing.Double, result, history);
    }

    // ---- @implementedByAll id columns (Signum's UpdateImplementedByAll) ------

    // Every table that holds an @implementedByAll reference stores the target's PK in a per-pk-type id
    // column + a type discriminator. When a referenced entity's PK migrates, the matching-type id column of
    // rows pointing at THAT entity must be re-pointed. altea's ImplementedByAllIdColumn is type-keyed (no
    // per-target referenceTable), so — like Signum — we scope by joining the type discriminator to the
    // migrated entity's TypeEntity row (matched by table name).
    updateImplementedByAll(migratedTable: Table, oldTableName: ObjectName, newIdCol: IColumn, oldPkDbType: AbstractDbType, oldIdColName: string,
        replacements: Replacements): SqlPreCommand | undefined {
        if (this.typeTable == null || this.typeIdCol == null || this.typeTableNameCol == null)
            return undefined;

        const commands: (SqlPreCommand | undefined)[] = [];
        for (const holder of this.modelTables.values()) {
            const typeCol = Object.values(holder.columns).find(c => c instanceof ImplementedByAllTypeColumn) as ImplementedByAllTypeColumn | undefined;
            if (typeCol == null)
                continue;
            // The reference moves from the OLD-pk-type id column to the NEW-pk-type one (Signum reads the
            // matching-old-type ibaId and writes the matching-new-type ibaId, nulling the old).
            const ibaOldId = Object.values(holder.columns).find(
                c => c instanceof ImplementedByAllIdColumn && (c as IColumn).dbType.equals(oldPkDbType)) as IColumn | undefined;
            const ibaNewId = Object.values(holder.columns).find(
                c => c instanceof ImplementedByAllIdColumn && (c as IColumn).dbType.equals(newIdCol.dbType)) as IColumn | undefined;
            if (ibaOldId == null || ibaNewId == null || ibaOldId === ibaNewId)
                continue;

            commands.push(this.updateIBAOne(migratedTable, oldTableName, newIdCol, oldIdColName, holder, typeCol, ibaOldId, ibaNewId, replacements));
            if (holder.systemVersioned != null)
                commands.push(this.updateIBAOne(migratedTable, oldTableName, newIdCol, oldIdColName, holder, typeCol, ibaOldId, ibaNewId, replacements, holder.systemVersioned.historyTableName));
        }
        return SqlPreCommand.combine(Spacing.Double, ...commands);
    }

    private updateIBAOne(
        migratedTable: Table, oldTableName: ObjectName, newIdCol: IColumn, oldIdColName: string,
        holder: Table, typeCol: ImplementedByAllTypeColumn, ibaOldId: IColumn, ibaNewId: IColumn,
        replacements: Replacements, holderHistory?: ObjectName,
    ): SqlPreCommand | undefined {
        const holderName = holderHistory ?? holder.name;
        const typeName = this.tbl(this.typeTable!.name);
        const oldTableLit = oldTableName.name.replace(/'/g, "''");
        // Re-point rows whose IBA reference targets the migrated entity: set the new-type id to the migrated
        // row's new pk, null the old-type id, matched by the type discriminator + the old id value.
        const setClause = `${this.esc(ibaNewId.name)} = src.${this.esc(newIdCol.name)}, ${this.esc(ibaOldId.name)} = NULL`;
        if (this.isPostgres) {
            // Postgres UPDATE…FROM cannot JOIN on the target in the FROM clause — list all sources in FROM
            // and put every join condition (incl. the ones on `tgt`) in WHERE.
            const sql =
                `UPDATE ${this.tbl(holderName)} tgt SET ${setClause}\n` +
                `FROM ${this.tbl(migratedTable.name)} src, ${typeName} ty\n` +
                `WHERE ty.${this.esc(this.typeIdCol!)} = tgt.${this.esc(typeCol.name)} AND ty.${this.esc(this.typeTableNameCol!)} = '${oldTableLit}'\n` +
                `  AND tgt.${this.esc(ibaOldId.name)} = src.${this.esc(oldIdColName)};`;
            return new SqlPreCommandSimple(sql);
        }
        const sql =
            `UPDATE tgt SET ${setClause}\n` +
            `FROM ${this.tbl(holderName)} tgt\n` +
            `JOIN ${this.tbl(migratedTable.name)} src ON tgt.${this.esc(ibaOldId.name)} = src.${this.esc(oldIdColName)}\n` +
            `JOIN ${typeName} ty ON ty.${this.esc(this.typeIdCol!)} = tgt.${this.esc(typeCol.name)} AND ty.${this.esc(this.typeTableNameCol!)} = '${oldTableLit}';`;
        return SqlPreCommand.combine(Spacing.Double,
            new SqlPreCommandSimple(sql),
            this.fixUnmatched(holderName, typeCol, ibaOldId, oldTableName, replacements));
    }

    /**
     * Deals with the rows the remap above could NOT reach: a row whose target entity had already been
     * deleted matches no `_old` value, so it would keep an id of the previous type for a type that is now
     * keyed differently. Reading such a row throws ("… requires ids of type uuid, not int"), and because
     * these references are usually loaded through a cached table or a global lazy, one stale row can break
     * every request rather than only the record that holds it.
     *
     * What to do with the row depends on whether the reference is OPTIONAL, which is what the type column
     * records: the id columns are always nullable when more than one primary key type is configured, so
     * they say nothing about the field. An optional reference (an operation log's target) just becomes
     * empty and the row, which is meaningful on its own, is kept. A required one (a translated instance)
     * cannot become empty, and a row with no id in any of its id columns is no more readable than the
     * stale one, so the row goes with its target — after asking, because deleting rows is not a decision
     * to take on the author's behalf.
     *
     * NOT in altea before now: the earlier port of the PK migration stopped at the remap, so an unmatched
     * row kept an id of the old type and the first read of it threw.
     */
    private fixUnmatched(holderName: ObjectName, typeCol: ImplementedByAllTypeColumn, ibaOldId: IColumn,
        oldTableName: ObjectName, replacements: Replacements): SqlPreCommand {

        const typeName = this.tbl(this.typeTable!.name);
        const oldTableLit = oldTableName.name.replace(/'/g, "''");
        const condition =
            `ty.${this.esc(this.typeIdCol!)} = tgt.${this.esc(typeCol.name)}\n` +
            `  AND ty.${this.esc(this.typeTableNameCol!)} = '${oldTableLit}'\n` +
            `  AND tgt.${this.esc(ibaOldId.name)} IS NOT NULL`;

        if (!isNullableToBool(typeCol.nullable) && this.askDeleteUnmatched(holderName, typeCol, oldTableName, replacements)) {
            const comment =
                `-- The target no longer exists, so the remap above could not reach this row, and ` +
                `${holderName.name}.${typeCol.name} cannot be null: the row is deleted\n`;
            const sql = this.isPostgres
                ? `${comment}DELETE FROM ${this.tbl(holderName)} tgt\nUSING ${typeName} ty\nWHERE ${condition};`
                : `${comment}DELETE tgt\nFROM ${this.tbl(holderName)} tgt\nJOIN ${typeName} ty ON ${condition};`;
            return new SqlPreCommandSimple(sql);
        }

        // Only the ID is cleared, not the row: the reference becomes empty instead of invalid.
        const setNull = `${this.esc(typeCol.name)} = NULL, ${this.esc(ibaOldId.name)} = NULL`;
        const sql = this.isPostgres
            ? `UPDATE ${this.tbl(holderName)} tgt SET ${setNull}\nFROM ${typeName} ty\nWHERE ${condition};`
            : `UPDATE tgt SET ${setNull}\nFROM ${this.tbl(holderName)} tgt\nJOIN ${typeName} ty ON ${condition};`;
        return new SqlPreCommandSimple(sql);
    }

    /** Answered once for the whole synchronization. Unattended the rows are deleted — the script is still
     *  reviewed before it is run. */
    private deleteUnmatchedIBARows?: boolean;

    private askDeleteUnmatched(holderName: ObjectName, typeCol: ImplementedByAllTypeColumn,
        oldTableName: ObjectName, replacements: Replacements): boolean {

        if (!replacements.interactive)
            return true;

        if (this.deleteUnmatchedIBARows != null)
            return this.deleteUnmatchedIBARows;

        console.log();
        console.log(`Delete the rows of ${holderName} that point to a ${oldTableName} that no longer exists?`);
        console.log(`(${holderName.name}.${typeCol.name} is not nullable, so they cannot be emptied instead)`);
        console.log(` y: yes    y!: yes, always    n: no, clear the id instead    n!: no, always`);

        for (; ;) {
            const answer = (readLineSync() ?? "y").trim().toLowerCase();
            if (answer === "y" || answer === "")
                return true;
            if (answer === "y!")
                return this.deleteUnmatchedIBARows = true;
            if (answer === "n")
                return false;
            if (answer === "n!")
                return this.deleteUnmatchedIBARows = false;
        }
    }

    // ---- system-versioned history rows (Signum's UpdateHistoryTable) ---------

    // The migrated table's own history rows keep the OLD pk in `oldIdColName`; map each to the new pk by
    // joining the history row to its live main-table row (same old id), falling back to a deterministic
    // negative rank for history-only rows so they stay unique.
    updateHistoryTable(table: Table, newIdCol: IColumn, oldIdColName: string): SqlPreCommand | undefined {
        if (table.systemVersioned == null)
            return undefined;
        const history = this.tbl(table.systemVersioned.historyTableName);
        const main = this.tbl(table.name);
        const newId = this.esc(newIdCol.name);
        const oldId = this.esc(oldIdColName);
        // A history-only row (no surviving main row) has no new id to copy — generate a deterministic
        // negative one from the ordering so the column stays unique (Signum's -DENSE_RANK()).
        const fallback = newIdCol.default ?? (newIdCol.identity ? `-DENSE_RANK() OVER (ORDER BY his.${oldId})` : `NULL`);
        const cte =
            `WITH cte AS (\n` +
            `    SELECT his.${oldId} AS old_id, COALESCE(m.${newId}, ${fallback}) AS new_id\n` +
            `    FROM ${history} his LEFT JOIN ${main} m ON his.${oldId} = m.${oldId}\n` +
            `    GROUP BY his.${oldId}, m.${newId}\n)`;
        const upd = this.isPostgres
            ? `${cte}\nUPDATE ${history} tgt SET ${newId} = cte.new_id FROM cte WHERE tgt.${oldId} = cte.old_id;`
            : `${cte}\nUPDATE tgt SET ${newId} = cte.new_id FROM ${history} tgt JOIN cte ON tgt.${oldId} = cte.old_id;`;
        return new SqlPreCommandSimple(upd);
    }
}
