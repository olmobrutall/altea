import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { start, hasDb } from "./setup";
import { Connector } from "@altea/altea/logic/connection/connector";
import { getDatabaseDescription } from "@altea/altea/logic/sync/sqlServer/sysTablesSchema";

// Probe: run the real SQL Server IView catalog reader against the live (generated) DB and
// dump what it found. Verifies the introspection produces sensible DiffTables before the
// synchronizer diffs them. DB-gated; SKIPs without ALTEA_TEST_DB.
describe("SysTablesSchema reader (live SQL Server)", { skip: !hasDb }, () => {
    test("introspects the generated schema", async () => {
        const connector = await start();
        if (connector.isPostgres) return; // SQL Server only for now

        const db = await Connector.withConnector(connector, () => getDatabaseDescription());

        console.log(`\n[reader] ${db.size} tables introspected`);
        const names = [...db.keys()].sort();
        console.log("[reader] tables: " + names.join(", "));

        const album = db.get("Album");
        if (album != null) {
            console.log("[reader] Album columns:");
            for (const c of Object.values(album.columns))
                console.log(`   ${c.name} : ${c.dbType.sqlServer}${c.length !== -1 ? `(${c.length})` : ""} ${c.nullable ? "NULL" : "NOT NULL"}${c.identity ? " IDENTITY" : ""}${c.primaryKey ? " PK" : ""}${c.foreignKey ? ` FK->${c.foreignKey.targetTable}` : ""}`);
            console.log("[reader] Album PK name: " + album.primaryKeyName);
        }

        assert.ok(db.size > 0, "expected at least one table");
    });
});
