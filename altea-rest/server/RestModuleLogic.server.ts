import "@altea/altea/server";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { RestApiKeyLogic } from "./RestApiKeyLogic.server";
import { RestApiKeyServer } from "./RestApiKeyServer.server";
import { RestLogLogic } from "./RestLogLogic.server";
import { RestLogServer } from "./RestLogServer.server";

// The module's single entry point. Southwind calls `RestLogLogic.Start(sb)` and `RestApiKeyLogic.Start(sb)`
// as two lines; altea packages expose one `start` per module (the shape TreeModuleLogic / HelpModuleLogic
// use), so an app writes one line and cannot half-install the module.
//
// The RestLog half is independent of the API-key half — a public API may be logged without being
// key-authenticated — so `apiKeys: false` leaves the key table and the authenticator out entirely.
export namespace RestModuleLogic {

    let started = false;

    export function start(sb: SchemaBuilder, options?: { apiKeys?: boolean }): void {
        if (started)
            return;
        started = true;

        RestLogLogic.start(sb);

        if (options?.apiKeys !== false)
            RestApiKeyLogic.start(sb);

        if (sb.webBuilder != null) {
            RestLogServer.start(sb.webBuilder);
            if (options?.apiKeys !== false)
                RestApiKeyServer.start(sb.webBuilder);
        }
    }
}
