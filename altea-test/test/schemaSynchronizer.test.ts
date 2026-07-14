import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { generateMusicEnvironment, hasDb, txTest } from "./setup";
import { Connector } from "@altea/altea/logic/connection/connector";
import { getDatabaseDescription as getSqlServerDescription } from "@altea/altea/logic/sync/sqlServer/sysTablesSchema";
import { getDatabaseDescription as getPostgresDescription } from "@altea/altea/logic/sync/postgres/postgresCatalogSchema";
import { Replacements, type AutoReplacementContext, type Selection } from "@altea/altea/logic/sync/synchronizer";
import type { SqlPreCommand } from "@altea/altea/logic/sync/sqlPreCommand";
import { ObjectName } from "@altea/altea/logic/schema/objectName";
import { ValueColumn } from "@altea/altea/logic/schema/column";
import { TableIndex } from "@altea/altea/logic/schema/tableIndex";
import { getIndexWhere } from "@altea/altea/logic/schema/indexWhere";
import type { Quoted } from "quote-transformer/quoted";

// A filtered-index predicate, captured by the quote-transformer (assigned to a Quoted-typed
// const). Used to build a *filtered* controlled index in the DB and prove the reader reads it
// back (filter_definition / indpred) and the synchronizer round-trips it.
const albumRecent: Quoted<(a: AlbumEntity) => boolean> = a => a.year == 2000;
import { AbstractDbType, IsNullable } from "@altea/altea/logic/schema/dbType";
import { AlbumEntity, ArtistEntity_Friends, FolderEntity } from "../entities/music";
import { getBoundEnum } from "@altea/altea/entities/enumEntity";

// The synchronizer pipeline end to end against a REAL database (no fakes): generate the
// schema, introspect it with the IView catalog readers, and diff. DB-gated; SKIPs without
// ALTEA_TEST_DB. `before` generates once (clean DDL + sample load); both tests reuse it.
describe("SchemaSynchronizer (live DB)", { skip: !hasDb }, () => {
    let connector: Connector;
    // generateMusicEnvironment sets Connector.default, so the sync helpers below resolve it
    // via Connector.current() — no withConnector wrapper needed.
    before(async () => { connector = await generateMusicEnvironment(); });

    // The IView reader (SysTablesSchema / PostgresCatalogSchema GetDatabaseDescription) really
    // SELECTs from the system catalog and builds DiffTables — check it recovers the generated
    // schema's shape. Assertions stay dialect-agnostic (SQL Server PascalCase vs Postgres
    // snake_case column names differ).
    test("GetDatabaseDescription", async () => {
        const db = await (connector.isPostgres ? getPostgresDescription() : getSqlServerDescription());

        assert.ok(db.size >= 20, "expected the full schema to be introspected");
        const tables = [...db.values()];
        assert.ok(tables.some(t => Object.values(t.columns).some(c => c.identity)), "some column is an identity PK");
        assert.ok(tables.some(t => Object.values(t.columns).some(c => c.foreignKey != null)), "some column has a foreign key");
        assert.ok(tables.some(t => t.primaryKeyName != null), "some table has a primary-key constraint name");
    });

    // Signum's self-consistency check: a freshly generated schema needs zero migration, so
    // synchronizeTablesScript (generate → introspect → diff) must produce an empty script.
    // A stubbed reader or diff would emit ADD/DROP/ALTER and fail this.
    test("SynchronizeTablesScriptEmpty", async () => {
        const replacements = new Replacements();
        replacements.interactive = false; // any needed rename ⇒ throw (a real mismatch), never a prompt

        const script = await connector.schema.synchronizationScript(replacements);

        if (script != null)
            console.log("\n[synchronizer] UNEXPECTED non-empty sync script:\n" + script.plainSql() + "\n");

        assert.equal(script, undefined, "a freshly generated schema must need no synchronization");
    });

    // ---- negative round-trips: manually drift the DB, then prove the synchronizer both
    // DETECTS the drift (non-empty script) and FIXES it (empty on re-sync after applying it).
    // Each runs inside txTest (Transaction.noCommit) so the DDL is visible to the sync reader
    // but rolled back afterwards — the shared baseline is untouched. This is the guard that
    // the empty-script assertion above isn't trivially empty.

    const sync = (autoReplacement?: (ctx: AutoReplacementContext) => Selection | null): Promise<SqlPreCommand | undefined> => {
        const r = new Replacements();
        r.interactive = false; // never prompt; a rename either resolves via autoReplacement or throws
        if (autoReplacement != null)
            r.autoReplacement = autoReplacement;
        return connector.schema.synchronizationScript(r);
    };
    const run = async (cmd: SqlPreCommand | undefined): Promise<void> => { if (cmd != null) await cmd.executeNonQuery(); };
    // Physical column name of a model field (dialect-cased).
    const colOf = (entity: any, field: string): string => connector.schema.table(entity).fields[field].field.columns()[0].name;

    // Answers the rename prompt: a `<name>_ren` old name maps back to `<name>` (so the
    // synchronizer emits a real RENAME rather than drop+create).
    const renameBack = (ctx: AutoReplacementContext): Selection | null => {
        const stripped = ctx.oldValue.replace(/_ren$/, "");
        return ctx.newValues?.includes(stripped) ? { oldValue: ctx.oldValue, newValue: stripped } : null;
    };

    async function assertRoundTrip(mutate: () => Promise<void>, autoReplacement?: (ctx: AutoReplacementContext) => Selection | null): Promise<void> {
        await mutate();
        const drift = await sync(autoReplacement);
        assert.ok(drift != null, "the synchronizer must detect the manual drift (non-empty script)");
        await run(drift);
        const after = await sync(autoReplacement);
        if (after != null)
            console.log("\n[synchronizer] drift not fully repaired:\n" + after.plainSql() + "\n");
        assert.equal(after, undefined, "re-sync after applying the fix must be empty");
    }

    // ---- tables --------------------------------------------------------------

    txTest("DropExtraTable", async () => {
        const schema = connector.schema.table(AlbumEntity).name.schema;
        const extra = new ObjectName("SyncNegExtraTable", schema);
        await assertRoundTrip(async () => {
            await connector.executeNonQuery(`CREATE TABLE ${connector.sqlBuilder.objectName(extra)} (${connector.sqlBuilder.sqlEscape("id")} int NOT NULL)`);
        });
    });

    txTest("CreateMissingTable", async () => {
        const friends = connector.schema.table(ArtistEntity_Friends);
        await assertRoundTrip(() => run(connector.sqlBuilder.dropTable(friends.name)));
    });

    txTest("RenameTable", async () => {
        const friends = connector.schema.table(ArtistEntity_Friends);
        await assertRoundTrip(() => run(connector.sqlBuilder.renameTable(friends.name, friends.name.name + "_ren")), renameBack);
    });

    // ---- columns -------------------------------------------------------------

    txTest("DropExtraColumn", async () => {
        const album = connector.schema.table(AlbumEntity);
        const extraCol = new ValueColumn("SyncNegExtraCol", new AbstractDbType("int", "int4"), IsNullable.Yes);
        await assertRoundTrip(() => run(connector.sqlBuilder.alterTableAddColumn(album.name, extraCol)));
    });

    txTest("CreateMissingColumn", async () => {
        const album = connector.schema.table(AlbumEntity);
        await assertRoundTrip(() => run(connector.sqlBuilder.alterTableDropColumn(album.name, colOf(AlbumEntity, "year"))));
    });

    txTest("RenameColumn", async () => {
        const album = connector.schema.table(AlbumEntity);
        const year = colOf(AlbumEntity, "year");
        await assertRoundTrip(() => run(connector.sqlBuilder.renameColumn(album.name, year, year + "_ren")), renameBack);
    });

    // ---- indexes -------------------------------------------------------------

    // Drop one of the model's own (controlled) indexes from the DB → the synchronizer must
    // detect it's missing and re-CREATE it (proving addIndices' create path + that the readers
    // read indexes back with the exact name SqlBuilder emits, so a match is a no-op).
    txTest("CreateMissingIndex", async () => {
        const album = connector.schema.table(AlbumEntity);
        const ix = album.indexes.find(i => i.columns.length >= 1);
        assert.ok(ix != null, "AlbumEntity should have at least one generated index (its FK columns)");
        const name = connector.sqlBuilder.indexName(ix!);
        await assertRoundTrip(() => run(connector.sqlBuilder.dropIndex(album.name, name)));
    });

    // A controlled (IX_/UIX_/CIX_-named) index present in the DB but not in the model → the
    // synchronizer must DROP it (dropIndices' removeOld honours IsControlledIndex). We index a
    // plain value column, which never gets an automatic model index, so it's genuinely extra.
    txTest("DropExtraControlledIndex", async () => {
        const album = connector.schema.table(AlbumEntity);
        const target = Object.values(album.columns).find(c => !c.identity && c.referenceTable == null);
        assert.ok(target != null, "AlbumEntity should have a plain value column to index");
        const extra = new TableIndex(album, [target!]);
        await assertRoundTrip(() => run(connector.sqlBuilder.createIndex(extra)));
    });

    // Same, but a FILTERED (partial) index: the WHERE predicate lambda is translated to SQL by
    // IndexWhereExpressionVisitor, emitted in CREATE INDEX, read back by the catalog reader
    // (filter_definition / indpred), and the extra controlled index is then dropped.
    txTest("DropExtraFilteredIndex", async () => {
        const album = connector.schema.table(AlbumEntity);
        const target = Object.values(album.columns).find(c => !c.identity && c.referenceTable == null);
        assert.ok(target != null, "AlbumEntity should have a plain value column to index");
        const extra = new TableIndex(album, [target!], { where: getIndexWhere(albumRecent, album, connector.isPostgres) });
        const create = connector.sqlBuilder.createIndex(extra);
        assert.match(create.plainSql(), / WHERE /, "the filtered index emits a WHERE clause");
        await assertRoundTrip(() => run(create));
    });

    // ---- enum rows -----------------------------------------------------------

    // A spurious enum row not in the enum definition → the enum-row sync must DELETE it
    // (proving synchronizeEnumsScript detects and fixes row drift, not just the DDL steps).
    txTest("SyncExtraEnumRow", async () => {
        const sb = connector.sqlBuilder;
        const enumTable = [...connector.schema.tables.values()].find(t => getBoundEnum(t.type) != null);
        assert.ok(enumTable != null, "the schema should contain at least one enum table");
        const pk = sb.sqlEscape(enumTable!.primaryKey.column.name);
        const nameCol = sb.sqlEscape(enumTable!.fields["name"].field.columns()[0].name);
        await assertRoundTrip(async () => {
            await connector.executeNonQuery(`INSERT INTO ${sb.objectName(enumTable!.name)} (${pk}, ${nameCol}) VALUES (999, 'SyncNegEnum')`);
        });
    });

    // ---- functions (SchemaAssets.SyncProcedures) -----------------------------
    // The full pipeline already round-trips the registered UDFs to empty (SynchronizeTablesScriptEmpty
    // covers MinimumTableValued / MinimumScalar). These prove the function-sync path also DETECTS
    // and FIXES drift, exercising createNew (missing) and mergeBoth (changed body).

    const minimumScalar = () => {
        const p = [...connector.schema.assets.storeProcedures.values()].find(x => x.name.name === "MinimumScalar");
        assert.ok(p != null, "MinimumScalar UDF should be registered");
        return p!;
    };

    // A dropped UDF → the (before-tables) function sync must recreate it.
    txTest("SyncMissingFunction", async () => {
        await assertRoundTrip(async () => { await run(minimumScalar().dropSql()); });
    });

    // A UDF whose body drifted → the function sync must ALTER it back to the model definition.
    txTest("SyncChangedFunction", async () => {
        const p = minimumScalar();
        // Redefine the body to something different but valid (returns p1 unconditionally).
        const drifted = connector.isPostgres
            ? `(p1 integer, p2 integer)\n RETURNS integer\n LANGUAGE plpgsql\nAS $function$\nBEGIN\nRETURN p1;\nEND\n$function$`
            : `(@Param1 Integer, @Param2 Integer)\nRETURNS Integer\nAS\nBEGIN\n   RETURN @Param1;\nEND`;
        await assertRoundTrip(async () => {
            const sql = connector.isPostgres
                ? `CREATE OR REPLACE FUNCTION ${connector.sqlBuilder.objectName(p.name)} ${drifted}`
                : `ALTER FUNCTION ${connector.sqlBuilder.objectName(p.name)} ${drifted}`;
            await connector.executeNonQuery(sql);
        });
    });

    // ---- system-versioned (temporal) tables ---------------------------------
    // FolderEntity is @systemVersioned, and the two dialects are maintained very differently, so
    // their drift tests differ. SQL Server keeps versioning ON and PROPAGATES every main-table
    // column change to the history table automatically — so its tests just confirm a column
    // round-trips, with no explicit history handling in the synchronizer. Postgres has no native
    // support: altea keeps an explicit `(LIKE main)` history table plus a trigger that carries the
    // column list, so its tests exercise the dedicated history-table + versioning-trigger sync
    // passes (a column added/dropped must be mirrored on the history table AND the trigger
    // re-emitted). `onlyPostgres` / `onlySqlServer` skip at run time (the connector is only known
    // after `before`).

    const onlyPostgres = (t: unknown): boolean => {
        if (connector.isPostgres) return true;
        (t as { skip(m?: string): void }).skip("Postgres-only versioning drift");
        return false;
    };
    const onlySqlServer = (t: unknown): boolean => {
        if (!connector.isPostgres) return true;
        (t as { skip(m?: string): void }).skip("SQL Server-only versioning drift");
        return false;
    };

    // SQL Server: dropping a column from a versioned table (versioning ON) auto-drops it from the
    // history table; the synchronizer re-adds it to the main table and SQL Server auto-adds it
    // back to history — round-trip empty, no history handling needed.
    txTest("Versioned_CreateMissingColumn_SqlServer", async (t) => {
        if (!onlySqlServer(t)) return;
        const folder = connector.schema.table(FolderEntity);
        await assertRoundTrip(() => run(connector.sqlBuilder.alterTableDropColumn(folder.name, colOf(FolderEntity, "name"))));
    });

    // SQL Server: an extra column added to the versioned main table (auto-added to history) → the
    // synchronizer drops it (auto-dropped from history).
    txTest("Versioned_DropExtraColumn_SqlServer", async (t) => {
        if (!onlySqlServer(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const extra = new ValueColumn("SyncNegVersionedCol", new AbstractDbType("int", "int4"), IsNullable.Yes);
        await assertRoundTrip(() => run(connector.sqlBuilder.alterTableAddColumn(folder.name, extra)));
    });

    // Postgres: the versioning trigger is dropped → the versioning-trigger sync pass recreates it.
    txTest("Versioned_MissingTrigger_Postgres", async (t) => {
        if (!onlyPostgres(t)) return;
        const folder = connector.schema.table(FolderEntity);
        await assertRoundTrip(async () => {
            await connector.executeNonQuery(`DROP TRIGGER versioning_trigger ON ${connector.sqlBuilder.objectName(folder.name)}`);
        });
    });

    // Postgres: the `(LIKE main)` history table is dropped → the history-table sync pass recreates
    // it (the trigger, which references it by name, stays and is valid again once it exists).
    txTest("Versioned_MissingHistoryTable_Postgres", async (t) => {
        if (!onlyPostgres(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const hist = folder.systemVersioned!.historyTableName;
        await assertRoundTrip(() => run(connector.sqlBuilder.dropTable(hist)));
    });

    // Postgres: a column dropped from BOTH the main and history tables → the main pass re-adds it
    // to the main table, the history pass re-adds it to the history table, and (the column list
    // having changed) the trigger is re-emitted with CREATE OR REPLACE.
    txTest("Versioned_CreateMissingColumn_Postgres", async (t) => {
        if (!onlyPostgres(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const hist = folder.systemVersioned!.historyTableName;
        const nameCol = colOf(FolderEntity, "name");
        await assertRoundTrip(async () => {
            await run(connector.sqlBuilder.alterTableDropColumn(folder.name, nameCol));
            await run(connector.sqlBuilder.alterTableDropColumn(hist, nameCol));
        });
    });

    // Postgres: an extra column present on BOTH the main and history tables → dropped from both,
    // and the trigger re-emitted.
    txTest("Versioned_DropExtraColumn_Postgres", async (t) => {
        if (!onlyPostgres(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const hist = folder.systemVersioned!.historyTableName;
        const extra = new ValueColumn("SyncNegVersionedCol", new AbstractDbType("int", "int4"), IsNullable.Yes);
        await assertRoundTrip(async () => {
            await run(connector.sqlBuilder.alterTableAddColumn(folder.name, extra));
            await run(connector.sqlBuilder.alterTableAddColumn(hist, extra));
        });
    });

    // Postgres: the trigger's stored argument list drifts from the model (a stale column list) →
    // the versioning-trigger pass must CREATE OR REPLACE it. Exercises the tgargs decode +
    // comparison (SqlBuilder.versioningTriggerArgs vs the reader's decoded pg_trigger.tgargs):
    // re-create the trigger with a deliberately truncated column list, then sync must restore it.
    txTest("Versioned_TriggerArgsDrift_Postgres", async (t) => {
        if (!onlyPostgres(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const sb = connector.sqlBuilder;
        const [sysPeriod, histName] = sb.versioningTriggerArgs(folder); // reuse the real sys_period + history name
        await assertRoundTrip(async () => {
            await connector.executeNonQuery(`DROP TRIGGER versioning_trigger ON ${sb.objectName(folder.name)}`);
            // A stale column list ('id' only) — differs from the model's full list, forcing a replace.
            await connector.executeNonQuery(
                `CREATE TRIGGER versioning_trigger BEFORE INSERT OR UPDATE OR DELETE ON ${sb.objectName(folder.name)} ` +
                `FOR EACH ROW EXECUTE FUNCTION versioning('${sysPeriod}', '${histName}', 'id')`);
        });
    });

    // Postgres: a nullability change on both the main and history tables → the main pass restores
    // NOT NULL on the main table, and the history pass restores it on the history table
    // (exercising the history-table ALTER-column branch, which add/drop tests don't reach).
    txTest("Versioned_AlterColumn_Postgres", async (t) => {
        if (!onlyPostgres(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const hist = folder.systemVersioned!.historyTableName;
        const nameCol = colOf(FolderEntity, "name");
        await assertRoundTrip(async () => {
            await connector.executeNonQuery(`ALTER TABLE ${connector.sqlBuilder.objectName(folder.name)} ALTER COLUMN ${connector.sqlBuilder.sqlEscape(nameCol)} DROP NOT NULL`);
            await connector.executeNonQuery(`ALTER TABLE ${connector.sqlBuilder.objectName(hist)} ALTER COLUMN ${connector.sqlBuilder.sqlEscape(nameCol)} DROP NOT NULL`);
        });
    });

    // SQL Server: a nullability change on the versioned main table (versioning ON) is propagated
    // to history automatically; the synchronizer restores NOT NULL on the main table and SQL
    // Server restores it on history — round-trip empty.
    txTest("Versioned_AlterColumn_SqlServer", async (t) => {
        if (!onlySqlServer(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const nameModelCol = folder.fields["name"].field.columns()[0];
        const nameCol = nameModelCol.name;
        const type = connector.sqlBuilder.getColumnType(nameModelCol);
        await assertRoundTrip(async () => {
            await connector.executeNonQuery(`ALTER TABLE ${connector.sqlBuilder.objectName(folder.name)} ALTER COLUMN ${connector.sqlBuilder.sqlEscape(nameCol)} ${type} NULL`);
        });
    });

    // ---- renames on versioned tables (the WithHistory fork preserves history data) ----------

    // Postgres: a column renamed on BOTH the main and history tables → the synchronizer must emit
    // a RENAME on EACH (via the SqlPreCommandWithHistory fork), NEVER a drop+re-add — that is the
    // whole point of the fork, so the history column keeps its data. Asserts the SQL shape
    // directly (two RENAME COLUMN, zero DROP COLUMN), then that it round-trips to empty.
    txTest("Versioned_RenameColumn_Postgres", async (t) => {
        if (!onlyPostgres(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const hist = folder.systemVersioned!.historyTableName;
        const nameCol = colOf(FolderEntity, "name");
        await run(connector.sqlBuilder.renameColumn(folder.name, nameCol, nameCol + "_ren"));
        await run(connector.sqlBuilder.renameColumn(hist, nameCol, nameCol + "_ren"));

        const drift = await sync(renameBack);
        assert.ok(drift != null, "the column rename must be detected");
        const sql = drift!.plainSql();
        assert.doesNotMatch(sql, /DROP COLUMN/, "a versioned column rename must RENAME the history column, never drop it (data preserved)");
        assert.equal((sql.match(/RENAME COLUMN/g) ?? []).length, 2, "the rename is applied to BOTH the main and history tables");

        await run(drift);
        const after = await sync(renameBack);
        assert.equal(after, undefined, "re-sync after applying the fix must be empty");
    });

    // SQL Server: renaming the main column propagates to the history table automatically
    // (versioning ON), so the synchronizer renames only the main column and it round-trips.
    txTest("Versioned_RenameColumn_SqlServer", async (t) => {
        if (!onlySqlServer(t)) return;
        const folder = connector.schema.table(FolderEntity);
        const nameCol = colOf(FolderEntity, "name");
        await assertRoundTrip(() => run(connector.sqlBuilder.renameColumn(folder.name, nameCol, nameCol + "_ren")), renameBack);
    });

    // Postgres: the versioned MAIN table itself is renamed → the synchronizer renames it back. The
    // versioning trigger follows the table rename and still targets the (unchanged) history table,
    // so no trigger re-emit is needed — the round-trip is empty.
    txTest("Versioned_RenameTable_Postgres", async (t) => {
        if (!onlyPostgres(t)) return;
        const folder = connector.schema.table(FolderEntity);
        await assertRoundTrip(() => run(connector.sqlBuilder.renameTable(folder.name, folder.name.name + "_ren")), renameBack);
    });

    // SQL Server: renaming a system-versioned table (its history link is by object id, not name)
    // round-trips — the synchronizer renames it back with versioning left intact.
    txTest("Versioned_RenameTable_SqlServer", async (t) => {
        if (!onlySqlServer(t)) return;
        const folder = connector.schema.table(FolderEntity);
        await assertRoundTrip(() => run(connector.sqlBuilder.renameTable(folder.name, folder.name.name + "_ren")), renameBack);
    });
});
