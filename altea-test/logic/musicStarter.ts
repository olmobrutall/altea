import "@altea/altea/logic/context.node"; // register server context storage first
import { Connector } from "@altea/altea/logic/connection/connector";
import { PostgresConnector } from "@altea/altea/logic/connection/postgresConnector";
import { SqlServerConnector } from "@altea/altea/logic/connection/sqlServerConnector";
import { buildMusicSchema } from "./musicLogic";

// Mirrors Signum.Test's MusicStarter: builds the schema, binds a connector, and
// generates the database. The connection string comes from ALTEA_TEST_DB; a
// value starting with "postgres" selects Postgres, otherwise SQL Server (mssql
// config string). The chosen connector is set as Connector.default so the
// generation steps pick up its dialect.
function makeConnector(): Connector {
    const sb = buildMusicSchema();

    const connStr = process.env["ALTEA_TEST_DB"];
    if (connStr == null || connStr === "")
        throw new Error(
            "Set ALTEA_TEST_DB to a connection string. Start it with 'postgres' for PostgreSQL; otherwise it is treated as a SQL Server connection string.",
        );

    const connector = connStr.startsWith("postgres")
        ? new PostgresConnector(sb.schema, connStr)
        : new SqlServerConnector(sb.schema, connStr);

    Connector.default = connector;
    return connector;
}

// Builds the schema, prints the create script, and executes it against the live
// database (the "Generate" half of Signum's Administrator.TotalGeneration). Save
// and data load (MusicLoader) come once the ORM/save layer lands.
export async function startAndGenerate(): Promise<void> {
    const connector = makeConnector();

    const script = connector.schema.generationScript();
    if (script == null) {
        console.log("[MusicStarter] Schema is empty — nothing to generate.");
        return;
    }

    console.log("[MusicStarter] Generation script:\n");
    console.log(script.plainSql());

    console.log("\n[MusicStarter] Executing against the database…");
    await connector.executeScript(script);
    console.log("[MusicStarter] Done.");

    await connector.closeConnection();
}

// Convenience for tests/tools that only want the DDL text without a live DB.
// Wraps the (parameterless) connector so generationScript() can read its dialect.
export function generationScript(dialect: "postgres" | "sqlserver"): string {
    const sb = buildMusicSchema();
    const connector = dialect === "postgres"
        ? new PostgresConnector(sb.schema, "postgres://unused")
        : new SqlServerConnector(sb.schema, "Server=unused");
    return Connector.withConnector(connector, () => sb.schema.generationScript()?.plainSql() ?? "");
}

// Allow `node musicStarter.js` to run a live generation directly.
if (import.meta.url === `file://${process.argv[1]}`) {
    startAndGenerate().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
