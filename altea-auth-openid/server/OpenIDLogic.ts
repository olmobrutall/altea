import type { SchemaBuilder } from "@altea/altea/server/schema";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { OpenIDConfigurationEmbedded } from "../data/OpenID";
import { OpenIDAuthorizer } from "./OpenIDAuthorizer";
import { OpenIDAuthenticationServer } from "./OpenIDAuthenticationServer";

// The module's start-up. `start(sb, getConfig)` is the ONE call a host makes — including wiring
// `AuthLogic.authorizer`, because the authorizer is what every route here resolves its configuration
// through.
//
// See port/AuthDirectory.md.

export namespace OpenIDLogic {

    /** The authorizer this module installed (also reachable as `AuthLogic.authorizer`). */
    export let authorizer: OpenIDAuthorizer | undefined;

    /**
     * The module's start-up, including wiring `AuthLogic.authorizer`.
     * `getConfig` is a CALLBACK so a host that stores the
     * configuration in the database sees an edit without a restart.
     *
     * `installAuthorizer` (altea addition, default true) exists because `AuthLogic.authorizer` is a single
     * slot: a host that offers SEVERAL directory modules but wants a different one to own the login flow
     * can still start this one — the routes exist and `/api/auth/openIDConfig` answers null, which is what
     * makes the client's boot probe a clean 200 instead of a 404. Signum needs no equivalent: its Starter
     * assigns the one authorizer by hand and does not start the modules it is not using.
     */
    export function start(sb: SchemaBuilder, getConfig: () => OpenIDConfigurationEmbedded | null,
        options?: { installAuthorizer?: boolean }): void {
        if (sb.alreadyDefined(start))
            return;

        authorizer = new OpenIDAuthorizer(getConfig);
        if (options?.installAuthorizer ?? true)
            AuthLogic.authorizer = authorizer;

        if (sb.webBuilder)
            OpenIDAuthenticationServer.start(sb.webBuilder);
    }
}
