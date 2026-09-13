import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { test, beforeEach, afterEach, afterAll, type TestContext } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Connector, ConsoleSqlLogger, type SqlLogger } from "@altea/altea/server/connection/connector";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { GlobalLazy } from "@altea/altea/server/globalLazy";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { MusicLogic } from "./MusicLogic";
import { MusicStarter } from "./MusicStarter";

// Shared test bootstrap. The LINQ tests are ports of Signum.Test's LinqProvider
// suite; they need the Music schema built and a database that already holds the
// loaded sample graph.
//
// vitest isolates each test file in its own worker, so anything a suite's `beforeAll` does is paid
// once PER FILE. The expensive part — dropping/recreating the tables and loading the sample graph — is
// therefore split out into `generateMusicEnvironment()`, run ONCE out of band (the `gen:*` scripts).
// Suites only `start()` (connect + build the in-memory schema), so each file pays just the connection
// cost.
//
// Live execution is gated on the ALTEA_TEST_DB env var (same var MusicStarter reads). The vitest
// config loads `.env.postgres` into the workers, so it is set whenever that file exists; with it unset
// the DB-backed suites skip, and the file still *compiles* (the stable-API gate) without a database.

export const hasDb = !!process.env.ALTEA_TEST_DB;

// Whether this run is allowed to DESTROY the test database — drop every table and reload the sample
// graph. Set by test/destructive.env, which the shared vitest config loads only when the run is
// SEQUENTIAL (fileParallelism: false, which is the default here).
//
// The gap between drop and reload is the whole problem: run files in parallel and it lands in the middle
// of ~95 others reading the same tables, which then fail with "relation … does not exist". Rolling back
// would not help — the damage is done in a `beforeAll`, outside any test body, and a reload is not a
// transaction. Sequentially the gap falls BETWEEN files, where it is harmless.
export const canDestroyDb = hasDb && process.env.ALTEA_TEST_DESTRUCTIVE === "1";

// A test that MUTATES the shared sample database (the bulk `executeUpdate` /
// `executeDelete` / `executeInsert` suites). Its body runs inside a
// `Transaction.noCommit` scope: the writes happen (and the body sees them, so
// post-mutation assertions still work), but the transaction is rolled back at the
// end, so nothing persists. This keeps the suites from contaminating the shared
// graph the read-only suites run against. Use exactly like `test(...)`.
export function txTest(name: string, fn: (t: TestContext) => void | Promise<void>): void {
    test(name, async (t) => {
        await Transaction.noCommit(async () => { await fn(t); });
    });
}

// ---- Per-test SQL dump (SQL_DUMP=1) --------------------------------------
// Writes each test's generated SQL to `<SQL_DUMP_DIR>/<Class>.<Test>.<pg|ss>.sql`,
// for cross-checking against the C# Signum LinqProvider suite (which dumps the same
// shape via its SqlDumpTextWriter). The describe/test names already match Signum's
// class/method names, so the files line up 1:1. Inert unless SQL_DUMP=1.
const sqlDumpEnabled = process.env.SQL_DUMP === "1";
const sqlDumpDir = process.env.SQL_DUMP_DIR ?? "D:/Altea/eastwind/sqlcmp/altea";
let sqlDumpSuffix = "unknown";
let sqlDumpBuffer: string[] = [];
let sqlDumpName: { cls: string, test: string } | undefined;

class FileSqlLogger implements SqlLogger {
    log(sql: string, parameters: unknown[]): void {
        sqlDumpBuffer.push(sql);
        if (parameters.length)
            sqlDumpBuffer.push(`-- params: ${JSON.stringify(parameters)}`);
    }
}

if (sqlDumpEnabled) {
    beforeEach((ctx) => {
        // vitest's task carries the leaf name and its suite chain; Signum's dump is named
        // <Class>.<Test>, so the outermost suite is the class and the task is the method.
        const leaf = ctx.task.name;
        let suite: { name: string; suite?: { name: string } } | undefined = ctx.task.suite;
        while (suite?.suite != null)
            suite = suite.suite;
        sqlDumpName = { cls: suite?.name ?? leaf, test: leaf };
        sqlDumpBuffer = [];
    });
    afterEach(() => {
        if (sqlDumpName && sqlDumpBuffer.length) {
            fs.mkdirSync(sqlDumpDir, { recursive: true });
            const file = path.join(sqlDumpDir, `${sqlDumpName.cls}.${sqlDumpName.test}.${sqlDumpSuffix}.sql`);
            fs.writeFileSync(file, sqlDumpBuffer.join("\n") + "\n");
        }
        sqlDumpName = undefined;
        sqlDumpBuffer = [];
    });
}

// Close the pooled connection when the file's tests finish. vitest gives each test file its own
// worker; the pg Pool / mssql ConnectionPool keeps the event loop alive, so without this the worker
// idles until the pool's idle-timeout (~10s on pg) before exiting — ×N files that dominated the whole
// run. Closing the pool lets each worker finish as soon as its tests are done.
//
// Only UNDER vitest, and that is not a nicety: this module is also imported by the standalone generator
// (generateEnvironment.ts, the `gen:*` scripts and the "altea test (generate DB)" launch config), and
// vitest's afterAll throws when it is called outside a suite. node:test's `after` tolerated it, so the
// move to vitest turned importing this module from a plain script into a crash. The generator exits by
// itself anyway, so there is no pool to tidy there.
if (process.env["VITEST"])
    afterAll(async () => { await Connector.default?.closeConnection(); });

let started: Promise<Connector> | undefined;

// Connects and builds the in-memory schema — and nothing else. No DDL, no data
// load. This is all a test SUITE needs in its `beforeAll`; the sample data is
// generated separately by `generateMusicEnvironment()`. Memoised per process.
export function start(): Promise<Connector> {
    return (started ??= (async () => {
        // altea analog of Signum's `Connector.CurrentLogger = new DebugTextWriter()`:
        // when debugging a single file the "Debug altea-test (current file)" launch
        // config sets ALTEA_TEST_LOG_SQL, so every generated SQL statement is echoed
        // to the integrated terminal. Left off for full runs to keep output clean.
        if (process.env.ALTEA_TEST_LOG_SQL)
            Connector.currentLogger = new ConsoleSqlLogger();

        const sb = new SchemaBuilder();
        const connector = await MusicStarter.connectorFromEnv(sb.schema, process.env.ALTEA_TEST_DB!);

        // Per-test SQL dump wins over the console logger when enabled.
        if (sqlDumpEnabled) {
            Connector.currentLogger = new FileSqlLogger();
            sqlDumpSuffix = connector.isPostgres ? "pg" : "ss";
        }
        Connector.default = connector;
        sb.settings.isPostgres = connector.isPostgres;
        MusicLogic.start(sb);
        sb.complete();
        // Read the persisted TypeEntity ids into the caches (the DB is generated out of band by
        // the gen:* scripts, so by the time a suite runs the rows exist). Harmless on a fresh DB:
        // TypeLogic.load falls back to the deterministic bootstrap when the table is absent.
        await connector.schema.initialize();
        return connector;
    })());
}

// Drops/recreates the tables and loads the full sample graph. Run ONCE before a
// test run (the `gen:*` scripts / the "Generate altea-test DB" launch config);
// the suites themselves only `start()`.
export async function generateMusicEnvironment(): Promise<Connector> {
    // start() initializes the schema, which READS the type table — against a database this run is
    // about to drop. A column the code has and the database does not (a new TypeEntity member) is
    // fatal there, so a model change could only be generated by dropping the database by hand.
    // Generating is exactly the case where the database trailing the code is not an error.
    const { result: connector } = await StartParameters.withIgnoredDatabaseMismatches(() => start());
    // Every global lazy was warmed by the start() above, against the database the next line DROPS — so
    // whatever they hold is about to become ids that no longer exist. Dropping every table is the
    // ultimate invalidation, but nothing tells them that (`invalidateWith` hooks entity events, and
    // cleanDatabase fires none). Left stale, PropertyRouteLogic's cache hands the seed a route that
    // looks SAVED, its `isNew` check skips the insert, and the rule pointing at it fails on the foreign
    // key — on every OTHER run, since a failed run leaves the table empty and the next one then works.
    GlobalLazy.resetAll(false);
    await connector.cleanDatabase();
    await connector.schema.generationScript()?.executeNonQuery();
    // Read back the TypeEntity ids the DB just assigned (start()'s earlier init saw the
    // pre-clean state), so the loader's @implementedByAll saves resolve real discriminators.
    await connector.schema.initialize();
    const { MusicLoader } = await import("./MusicLoader");
    await MusicLoader.load();
    return connector;
}
