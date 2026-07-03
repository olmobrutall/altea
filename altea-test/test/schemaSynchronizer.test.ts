import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { generateMusicEnvironment, hasDb } from "./setup";
import { Connector } from "@altea/altea/logic/connection/connector";
import { getDatabaseDescription as getSqlServerDescription } from "@altea/altea/logic/sync/sqlServer/sysTablesSchema";
import { getDatabaseDescription as getPostgresDescription } from "@altea/altea/logic/sync/postgres/postgresCatalogSchema";
import { synchronizeTablesScript } from "@altea/altea/logic/sync/schemaSynchronizer";
import { Replacements } from "@altea/altea/logic/sync/synchronizer";

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

        const script = await synchronizeTablesScript(replacements);

        if (script != null)
            console.log("\n[synchronizer] UNEXPECTED non-empty sync script:\n" + script.plainSql() + "\n");

        assert.equal(script, undefined, "a freshly generated schema must need no synchronization");
    });
});
