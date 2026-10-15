import { test, describe, beforeAll, type TestContext } from "vitest";
import assert from "node:assert/strict";
import { SchemaBuilder } from "@altea/altea/server/schema";
import type { Connector } from "@altea/altea/server/connection/connector";
import { PostgresConnector } from "@altea/altea/server/connection/postgresConnector";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { DatabaseName, ObjectName, SchemaName, defaultSchemaName } from "@altea/altea/server/schema/objectName";
import { Administrator } from "@altea/altea/server/Administrator";
import { getDatabaseDescription, getSchemaNames } from "@altea/altea/server/sync/postgres/postgresCatalogSchema";
import { synchronizeSchemasScript, synchronizeTablesScript } from "@altea/altea/server/sync/schemaSynchronizer";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { hasDb, start } from "../setup";

// Signum's Schema.ExecuteAs: the role generation / migrations run as, and the owner a Postgres sync
// hands every schema and table to.

describe("ExecuteAs SQL", () => {
    // Never connects: only its SqlBuilder is used.
    const sqlBuilder = new PostgresConnector(new SchemaBuilder().schema, "postgres://nobody@localhost/none").sqlBuilder;

    test("AlterTableChangeOwner", () => {
        const name = new ObjectName("Album", new SchemaName("music", new DatabaseName("")));
        assert.equal(sqlBuilder.alterTableChangeOwner(name, "azure_pg_admin").plainSql(), `ALTER TABLE music."Album" OWNER TO azure_pg_admin;`);
        assert.equal(sqlBuilder.alterTableChangeOwner(new ObjectName("album", defaultSchemaName), "Owner Role").plainSql(), `ALTER TABLE album OWNER TO "Owner Role";`);
    });

    test("AlterSchemaChangeOwner", () => {
        assert.equal(sqlBuilder.alterSchemaChangeOwner(defaultSchemaName, "azure_pg_admin").plainSql(), "ALTER SCHEMA public OWNER TO azure_pg_admin;");
        assert.equal(sqlBuilder.alterSchemaChangeOwner(new SchemaName("music", new DatabaseName("")), "azure_pg_admin").plainSql(), "ALTER SCHEMA music OWNER TO azure_pg_admin;");
    });

    test("RemoveAllScript drops the schemas executeAs owns", () => {
        assert.ok(PostgresConnector.removeAllScript().includes("AND (pr.rolname=current_user)"));
        assert.ok(PostgresConnector.removeAllScript("azure_pg_admin").includes("AND (pr.rolname=current_user OR pr.rolname='azure_pg_admin')"));
        assert.ok(PostgresConnector.removeAllScript("o'brien").includes("OR pr.rolname='o''brien')"));
    });
});

describe.skipIf(!hasDb)("ExecuteAs (live DB)", () => {
    let connector: Connector;
    let currentUser: string;
    beforeAll(async () => {
        connector = await start();
        currentUser = ((await connector.executeQuery("SELECT current_user AS u")) as { u: string }[])[0].u;
    });

    async function withExecuteAs<T>(executeAs: string | undefined, fn: () => Promise<T>): Promise<T> {
        const previous = connector.schema.executeAs;
        connector.schema.executeAs = executeAs;
        try {
            return await fn();
        } finally {
            connector.schema.executeAs = previous;
        }
    }

    function postgresOnly(t: TestContext): void {
        if (!connector.isPostgres)
            t.skip();
    }

    test("Reads the owners", async t => {
        postgresOnly(t);
        const tables = [...(await getDatabaseDescription()).values()];
        assert.ok(tables.length > 0);
        assert.ok(tables.every(a => a.owner != null), "every table has an owner");
        assert.ok(tables.some(a => a.owner === currentUser), "the test user owns the tables it generated");
        assert.ok((await getSchemaNames()).get("")?.owner != null, "the default schema has an owner");
    });

    test("Sync hands schemas and tables to executeAs", async t => {
        postgresOnly(t);
        const replacements = new Replacements();
        replacements.interactive = false;

        await withExecuteAs("altea_owner_probe", async () => {
            assert.match((await synchronizeTablesScript(replacements))?.plainSql() ?? "", /ALTER TABLE \S+ OWNER TO altea_owner_probe;/);
            assert.match((await synchronizeSchemasScript(replacements))?.plainSql() ?? "", /ALTER SCHEMA public OWNER TO altea_owner_probe;/);
        });

        await withExecuteAs(currentUser, async () => {
            assert.doesNotMatch((await synchronizeTablesScript(replacements))?.plainSql() ?? "", /OWNER TO/);
        });
    });

    test("WithExecuteAs sets the role for the transaction only", async t => {
        postgresOnly(t);
        const [{ rolsuper }] = await connector.executeQuery("SELECT rolsuper FROM pg_roles WHERE rolname = current_user") as { rolsuper: boolean }[];
        if (!rolsuper)
            t.skip();

        const selectUser = async (): Promise<string> => ((await connector.executeQuery("SELECT current_user AS u")) as { u: string }[])[0].u;

        await withExecuteAs("altea_execute_as_probe", async () => {
            await assert.rejects(() => Administrator.withExecuteAs(selectUser), /inside a transaction/);

            await Transaction.noCommit(async () => {
                await connector.executeNonQuery("CREATE ROLE altea_execute_as_probe");
                assert.equal(await Administrator.withExecuteAs(selectUser), "altea_execute_as_probe");
            });
        });

        assert.equal(await selectUser(), currentUser, "the role does not outlive the transaction");
    });
});
