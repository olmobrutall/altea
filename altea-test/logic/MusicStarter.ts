import "@altea/altea/logic/context.node"; // register server context storage first
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import type { Schema } from "@altea/altea/logic/schema";
import { MusicLogic } from "./MusicLogic";
import { MusicLoader } from "./MusicLoader";

// Mirrors Signum.Test's MusicStarter: builds the schema, binds a connector,
// generates the database, and loads the sample data. The connection string comes
// from ALTEA_TEST_DB; a value starting with "postgres" selects Postgres,
// otherwise SQL Server. The chosen connector is set as Connector.default so the
// generation + save steps pick up its dialect through Connector.current().
export namespace MusicStarter {
    // Reads + validates ALTEA_TEST_DB. Single source of truth for both run modes.
    function requireConnStr(): string {
        const connStr = process.env["ALTEA_TEST_DB"];
        if (connStr == null || connStr === "")
            throw new Error(
                "Set ALTEA_TEST_DB to a connection string. Start it with 'postgres' for PostgreSQL; otherwise it is treated as a SQL Server connection string.",
            );
        return connStr;
    }

    // Builds the connector for the dialect named by the connection string. The
    // per-dialect connector is dynamically imported so a Postgres run never pulls
    // in the mssql driver and vice versa (Rollup keeps these as separate chunks).
    export async function connectorFromEnv(schema: Schema, connStr: string): Promise<Connector> {
        if (connStr.startsWith("postgres")) {
            const { PostgresConnector } = await import("@altea/altea/logic/connection/postgresConnector");
            return new PostgresConnector(schema, connStr);
        }
        const { SqlServerConnector } = await import("@altea/altea/logic/connection/sqlServerConnector");
        return new SqlServerConnector(schema, connStr);
    }

    // Builds the schema, connects (printing the server banner), generates the
    // database, and loads the sample object graph (the "Generate" half of
    // Signum's Administrator.TotalGeneration, plus the loader).
    export async function start(): Promise<void> {
        const sb = new SchemaBuilder();
        const connStr = requireConnStr();
        const connector = await connectorFromEnv(sb.schema, connStr);
        Connector.default = connector;

        const label = connector.isPostgres ? "PostgreSQL" : "SQL Server";
        const target = Connector.redactConnectionString(connStr);

        try {
            // Touch the database first: this triggers the actual connection, so a
            // bad host/credential fails here with a clear message instead of
            // halfway through generation. Also surfaces the server banner.
            console.log(`[${label}] connecting: ${target}`);
            try {
                const bannerSql = connector.isPostgres ? "select version() as v" : "select @@version as v";
                const rows = (await connector.executeQuery(bannerSql)) as Array<{ v: string }>;
                console.log(`[${label}] connected — ${rows[0]?.v?.split("\n")[0] ?? "(ok)"}`);
            } catch (err) {
                throw new Error(`Could not connect to ${label} (${target}): ${(err as Error)?.message ?? err}`);
            }

            // Drop any existing objects so a full generation is re-runnable
            // against a dirty database (mirrors Signum's clean-then-generate).
            console.log(`[${label}] cleaning database`);
            await connector.cleanDatabase();

            // Generate the schema, then load the sample object graph.
            MusicLogic.start(sb);
            sb.complete();
            await sb.schema.generationScript()?.executeNonQuery();
            // await MusicLoader.load(); // TODO: re-enable once the loader path is ready
            console.log(`[${label}] schema generation complete`);
        } finally {
            await connector.closeConnection();
        }
    }
}
