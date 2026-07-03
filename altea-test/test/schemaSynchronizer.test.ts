import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { generateEnvironment, hasDb } from "./setup";
import { Connector } from "@altea/altea/logic/connection/connector";
import { getDatabaseDescription } from "@altea/altea/logic/sync/sqlServer/sysTablesSchema";
import { synchronizeTablesScript } from "@altea/altea/logic/sync/schemaSynchronizer";
import { Replacements } from "@altea/altea/logic/sync/synchronizer";

// The synchronizer pipeline end to end against a REAL database (no fakes): generate the
// schema, introspect it with the IView catalog readers, and diff. DB-gated; SKIPs without
// ALTEA_TEST_DB. `before` generates once (clean DDL + sample load); both tests reuse it.
describe("SchemaSynchronizer (live SQL Server)", { skip: !hasDb }, () => {
    let connector: Connector;
    before(async () => { connector = await generateEnvironment(); });

    // The IView reader (SysTablesSchema.GetDatabaseDescription) really SELECTs from sys.*
    // and builds DiffTables — check it recovers the generated schema's shape.
    test("GetDatabaseDescription", async () => {
        if (connector.isPostgres) return; // SQL Server only until the Postgres reader lands (M3-PG)

        const db = await Connector.withConnector(connector, () => getDatabaseDescription());

        assert.ok(db.size > 0, "expected tables to be introspected");
        const album = db.get("Album");
        assert.ok(album != null, "Album table introspected");
        assert.equal(album!.columns["ID"]?.identity, true, "Album.ID is an identity column");
        assert.ok(album!.columns["LabelID"]?.foreignKey != null, "Album.LabelID has a foreign key");
        assert.ok(album!.primaryKeyName != null, "Album has a primary-key constraint name");
    });

    // Signum's self-consistency check: a freshly generated schema needs zero migration, so
    // synchronizeTablesScript (generate → introspect → diff) must produce an empty script.
    // A stubbed reader or diff would emit ADD/DROP/ALTER and fail this.
    test("SynchronizeTablesScriptEmpty", async () => {
        if (connector.isPostgres) return;

        const replacements = new Replacements();
        replacements.interactive = false; // any needed rename ⇒ throw (a real mismatch), never a prompt

        const script = await Connector.withConnector(connector, () => synchronizeTablesScript(replacements));

        if (script != null)
            console.log("\n[synchronizer] UNEXPECTED non-empty sync script:\n" + script.plainSql() + "\n");

        assert.equal(script, undefined, "a freshly generated schema must need no synchronization");
    });
});
