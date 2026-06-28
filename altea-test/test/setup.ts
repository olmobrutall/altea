import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { MusicLogic } from "../logic/MusicLogic";
import { MusicStarter } from "../logic/MusicStarter";

// Shared test bootstrap. The LINQ tests are ports of Signum.Test's LinqProvider
// suite; like Signum's `MusicStarter.StartAndLoad()` in each test-class ctor,
// they need the Music schema built and the sample graph loaded ONCE.
//
// Live execution is gated on the ALTEA_TEST_DB env var (same var MusicStarter
// reads): set it (e.g. via `node --env-file=.env.postgres`) to run against a
// real database. With it unset, `withDb()`-wrapped suites are skipped, so the
// file still *compiles* (the stable-API gate) without a database.

export const hasDb = !!process.env.ALTEA_TEST_DB;

let started: Promise<Connector> | undefined;

// Builds the schema, connects, generates + loads the sample data exactly once
// per process, and returns the connector to scope queries with.
export function startAndLoad(): Promise<Connector> {
    return (started ??= (async () => {
        const sb = new SchemaBuilder();
        const connector = await MusicStarter.connectorFromEnv(sb.schema, process.env.ALTEA_TEST_DB!);
        Connector.default = connector;
        sb.settings.isPostgres = connector.isPostgres;
        MusicLogic.start(sb);
        sb.complete();
        await connector.cleanDatabase();
        await sb.schema.generationScript()?.executeNonQuery();
        const { MusicLoader } = await import("../logic/MusicLoader");
        await MusicLoader.load();
        return connector;
    })());
}
