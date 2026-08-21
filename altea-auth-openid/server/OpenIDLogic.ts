import type { SchemaBuilder } from "@altea/altea/server/schema";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { OpenIDConfigurationEmbedded } from "../data/OpenID";
import { OpenIDAuthorizer } from "./OpenIDAuthorizer";
import { OpenIDAuthenticationServer } from "./OpenIDAuthenticationServer";

// Port of Signum.Authorization.OpenID's OpenIDLogic.cs — the module's start-up.
//
// altea divergences, documented inline:
//  - `Lite.RegisterLiteModelConstructor((UserEntity u) => new UserLiteModel { … ExternalId … })` is NOT
//    ported: altea has no lite-model entity (see CLAUDE.md), so a `Lite<UserEntity>` carries just its id
//    and toString. Nothing in this module needs the external id off a lite.
//  - `ReflectionServer.RegisterLike(typeof(UserADMessage) / typeof(OpenIDMessage), () => true)` is NOT
//    ported: altea's message containers are plain objects bundled with the client, not blob entries, so
//    there is nothing to register (and nothing an anonymous visitor is missing).
//  - Signum leaves wiring `AuthLogic.Authorizer` to the application's Starter; altea does it here, because
//    the authorizer is what every route in this module resolves its configuration through — so
//    `start(sb, getConfig)` is the ONE call a host makes.

export namespace OpenIDLogic {

    /** The authorizer this module installed (also reachable as `AuthLogic.authorizer`). */
    export let authorizer: OpenIDAuthorizer | undefined;

    /**
     * Signum's `OpenIDLogic.Start(sb)` plus the Starter's `AuthLogic.Authorizer = new OpenIDAuthorizer(…)`.
     * `getConfig` is a CALLBACK (Signum's `Func<OpenIDConfigurationEmbedded?>`) so a host that stores the
     * configuration in the database sees an edit without a restart.
     *
     * `installAuthorizer` (altea addition, default true) exists because `AuthLogic.authorizer` is a single
     * slot: a host that offers SEVERAL directory modules but wants a different one to own the login flow
     * can still start this one — the routes exist and `/api/auth/openIDConfig` answers null, which is what
     * makes the client's boot probe a clean 200 instead of a 404. Signum never needs it: its Starter
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
