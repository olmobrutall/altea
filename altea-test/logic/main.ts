import { MusicStarter } from "./MusicStarter";

// CLI entry for altea-test, bundled by vite.server.config.ts (mirrors eastwind's
// logic/main.ts). Connects (showing the server banner), generates the database
// and loads the sample data. Connection target comes from ALTEA_TEST_DB
// (use `node --env-file=.env.postgres ...`).
MusicStarter.start()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(`[FAILED] ${err?.message ?? err}`);
        process.exit(1);
    });
