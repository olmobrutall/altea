import { generateEnvironment } from "./setup";

// One-shot: generate the test database (schema DDL + sample data) so the
// per-file processes that `node --test` spawns only have to connect (`start()`).
// Run via the `gen:postgres` / `gen:sqlserver` scripts, or the "Generate
// altea-test DB" launch config. NOT a `*.test.ts`, so the normal test glob
// (`dist/test/**/*.test.js`) skips it.
generateEnvironment()
    .then(() => { console.log("[OK] altea-test environment generated"); process.exit(0); })
    .catch(err => { console.error(`[FAILED] ${err?.message ?? err}`); process.exit(1); });
