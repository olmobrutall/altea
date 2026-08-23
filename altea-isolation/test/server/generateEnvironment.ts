import { generateIsolationEnvironment } from "./setup";

// One-shot: generate the test database (schema DDL + the row fixture) so the per-file processes that
// `node --test` spawns only have to connect (`start()`). Run via the `gen:postgres` / `gen:sqlserver`
// scripts. NOT a `*.test.ts`, so the normal test glob skips it.
generateIsolationEnvironment()
    .then(() => { console.log("[OK] altea-isolation test environment generated"); process.exit(0); })
    .catch(err => { console.error(`[FAILED] ${err?.stack ?? err}`); process.exit(1); });
