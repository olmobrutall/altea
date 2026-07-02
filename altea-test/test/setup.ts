import { test, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Connector, ConsoleSqlLogger, type SqlLogger } from "@altea/altea/logic/connection/connector";
import { Transaction } from "@altea/altea/logic/connection/transaction";
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

// A test that MUTATES the shared sample database (the bulk `executeUpdate` /
// `executeDelete` / `executeInsert` suites). Its body runs inside a
// `Transaction.noCommit` scope: the writes happen (and the body sees them, so
// post-mutation assertions still work), but the transaction is rolled back at the
// end, so nothing persists. This keeps the suites from contaminating the shared
// graph the read-only suites run against in parallel. Use exactly like `test(...)`.
export function txTest(name: string, fn: (t: unknown) => void | Promise<void>): void {
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
    beforeEach((t) => {
        const full = (t as { fullName?: string; name: string }).fullName ?? t.name;
        const parts = full.split(" > ");
        sqlDumpName = { cls: parts[0], test: parts[parts.length - 1] };
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

let started: Promise<Connector> | undefined;

// Connects and builds the in-memory schema — and nothing else. No DDL, no data
// load. This is all a test SUITE needs in its `before`; the sample data is
// generated separately by `generateEnvironment()`. Memoised per process.
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
