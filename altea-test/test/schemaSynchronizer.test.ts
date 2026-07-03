import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateEnvironment, hasDb } from "./setup";
import { Connector } from "@altea/altea/logic/connection/connector";
import { synchronizeTablesScript } from "@altea/altea/logic/sync/schemaSynchronizer";
import { Replacements } from "@altea/altea/logic/sync/synchronizer";

// The whole synchronizer pipeline, end to end, against a REAL database (no fakes):
//   1. generate — clean the DB and run the model's generation script (CREATE TABLE / FK / …)
//   2. introspect — the real IView catalog readers SELECT from sys.* to build DiffTables
//   3. diff — SchemaSynchronizer.synchronizeTablesScript compares model vs DB
//   4. assert the script is EMPTY — a freshly generated schema needs zero migration.
// If the generator and the synchronizer disagree, the diff emits ADD/DROP/ALTER and this
// assertion fails (a stubbed reader or diff could not produce an empty script by luck).
describe("SchemaSynchronizer end-to-end (live DB)", { skip: !hasDb }, () => {
    test("sync immediately after generate produces an empty script", async () => {
        const connector = await generateEnvironment();
        if (connector.isPostgres) return; // SQL Server only until the Postgres reader lands (M3-PG)

        const replacements = new Replacements();
        replacements.interactive = false; // any needed rename ⇒ throw (a real mismatch), never a prompt

        const script = await Connector.withConnector(connector, () => synchronizeTablesScript(replacements));

        if (script != null)
            console.log("\n[synchronizer] UNEXPECTED non-empty sync script:\n" + script.plainSql() + "\n");

        assert.equal(script, undefined, "a freshly generated schema must need no synchronization");
    });
});
