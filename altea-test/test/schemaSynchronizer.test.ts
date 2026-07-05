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
import { AlbumEntity, ArtistEntity_Friends } from "../entities/music";
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
});
