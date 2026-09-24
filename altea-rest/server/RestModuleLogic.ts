import "@altea/altea/server";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { RestApiKeyLogic } from "./RestApiKeyLogic";
import { RestApiKeyServer } from "./RestApiKeyServer";
import { RestLogLogic } from "./RestLogLogic";
import { RestLogServer } from "./RestLogServer";

// The module's single entry point.
//
// The two halves are independent — a public API may be logged without being key-authenticated, and an
// API key may authenticate without anything being logged (Signum starts RestLogLogic and RestApiKeyLogic
// separately) — so `log: false` / `apiKeys: false` each leave that half's table and routes out entirely.
export namespace RestModuleLogic {

    let started = false;

    export function start(sb: SchemaBuilder, options?: { log?: boolean; apiKeys?: boolean }): void {
        if (started)
            return;
        started = true;

        const log = options?.log ?? true;
        const apiKeys = options?.apiKeys ?? true;

        if (log)
            RestLogLogic.start(sb);

        if (apiKeys)
            RestApiKeyLogic.start(sb);

        if (sb.webBuilder != null) {
            if (log)
                RestLogServer.start(sb.webBuilder);
            if (apiKeys)
                RestApiKeyServer.start(sb.webBuilder);
        }
    }
}
