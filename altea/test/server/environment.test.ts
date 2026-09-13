import { describe, test } from "vitest";
import { canDestroyDb, generateMusicEnvironment } from "./setup";

// The counterpart of eastwind's test/environment/environment.test.ts, and of Southwind's
// EnvironmentTest.GenerateTestEnvironment: the one test that BUILDS the database every other suite in
// this package starts from — clean DDL, then the Music sample graph.
//
// It exists to be CLICKED. Generating was previously only reachable from the `gen:*` scripts (buried in
// an NPM Scripts view that lists all 58 packages) or a launch config, and neither is where you already
// are when a suite has just told you the database is stale.
//
// DESTRUCTIVE, so it gates on canDestroyDb — the same flag the schema-synchronizer suite uses, set by
// test/destructive.env whenever the run is sequential. That is deliberately weaker than eastwind's gate:
// ALTEA_TEST_DB is a disposable fixture this very test rebuilds, so losing it costs one click, while
// eastwind's .env.local is a database someone develops against.
describe.skipIf(!canDestroyDb)("EnvironmentTest", () => {
    // Dropping every table and reloading the sample graph is far past vitest's default timeout.
    test("GenerateMusicEnvironment", { timeout: 600_000 }, async () => {
        await generateMusicEnvironment();
    });
});
