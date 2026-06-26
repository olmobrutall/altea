import "@altea/altea/logic/context.node"; // register server context storage first
import { Connector } from "@altea/altea/logic/connection/connector";
import { PostgresConnector } from "@altea/altea/logic/connection/postgresConnector";
import { SqlServerConnector } from "@altea/altea/logic/connection/sqlServerConnector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { MusicLogic } from "./MusicLogic";
import { MusicLoader } from "./MusicLoader";

// Mirrors Signum.Test's MusicStarter: builds the schema, binds a connector,
// generates the database, and loads the sample data. The connection string comes
// from ALTEA_TEST_DB; a value starting with "postgres" selects Postgres,
// otherwise SQL Server. The chosen connector is set as Connector.default so the
// generation + save steps pick up its dialect through Connector.current().
export namespace MusicStarter {
    export async function start(): Promise<void> {
        const sb = new SchemaBuilder();

        const connStr = process.env["ALTEA_TEST_DB"];
        if (connStr == null || connStr === "")
            throw new Error(
                "Set ALTEA_TEST_DB to a connection string. Start it with 'postgres' for PostgreSQL; otherwise it is treated as a SQL Server connection string.",
            );

        const connector = connStr.startsWith("postgres")
            ? new PostgresConnector(sb.schema, connStr)
            : new SqlServerConnector(sb.schema, connStr);
        Connector.default = connector;

        MusicLogic.start(sb);
        sb.complete();

        // Generate (the "Generate" half of Signum's Administrator.TotalGeneration)
        // and then load the sample object graph.
        await sb.schema.generationScript()?.executeNonQuery();

        await MusicLoader.load();

        await connector.closeConnection();
    }
}

// Allow `node MusicStarter.js` to run a live start directly.
if (import.meta.url === `file://${process.argv[1]}`) {
    MusicStarter.start().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
