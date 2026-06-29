import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { MusicLogic } from "../logic/MusicLogic";
import { MusicStarter } from "../logic/MusicStarter";

// Shared test bootstrap. The LINQ tests are ports of Signum.Test's LinqProvider
// suite; they need the Music schema built and a database that already holds the
// loaded sample graph.
//
// `node --test` runs each test file in its own process, so anything a suite's
// `before` does is paid once PER FILE. The expensive part — dropping/recreating
// the tables and loading the sample graph — is therefore split out into
// `generateEnvironment()`, run ONCE out of band (the `gen:*` scripts). Suites
// only `start()` (connect + build the in-memory schema), so each file pays just
// the connection cost.
//
// Live execution is gated on the ALTEA_TEST_DB env var (same var MusicStarter
// reads): set it (e.g. via `node --env-file=.env.postgres`) to run against a
// real database. With it unset, `withDb()`-wrapped suites are skipped, so the
// file still *compiles* (the stable-API gate) without a database.

export const hasDb = !!process.env.ALTEA_TEST_DB;

let started: Promise<Connector> | undefined;

// Connects and builds the in-memory schema — and nothing else. No DDL, no data
// load. This is all a test SUITE needs in its `before`; the sample data is
// generated separately by `generateEnvironment()`. Memoised per process.
export function start(): Promise<Connector> {
    return (started ??= (async () => {
        const sb = new SchemaBuilder();
        const connector = await MusicStarter.connectorFromEnv(sb.schema, process.env.ALTEA_TEST_DB!);
        Connector.default = connector;
        sb.settings.isPostgres = connector.isPostgres;
        MusicLogic.start(sb);
        sb.complete();
        return connector;
    })());
}

// Drops/recreates the tables and loads the full sample graph. Run ONCE before a
// test run (the `gen:*` scripts / the "Generate altea-test DB" launch config);
// the suites themselves only `start()`.
export async function generateEnvironment(): Promise<Connector> {
    const connector = await start();
    await connector.cleanDatabase();
    await connector.schema.generationScript()?.executeNonQuery();
    const { MusicLoader } = await import("../logic/MusicLoader");
    await MusicLoader.load();
    return connector;
}
