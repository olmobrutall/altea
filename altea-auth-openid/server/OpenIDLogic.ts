import type { SchemaBuilder } from "@altea/altea/server/schema";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { OpenIDAuthorizer } from "./OpenIDAuthorizer";
import { OpenIDAuthenticationServer } from "./OpenIDAuthenticationServer";

// The module's start-up. It registers the routes; it does NOT install an authorizer — the application's
// Starter sets `AuthLogic.authorizer` (an `OpenIDAuthorizer` subclass, to sign in through OpenID), and
// every route here resolves its configuration through that object. With another authorizer installed the
// routes stay and `/api/auth/openIDConfig` answers null, so the client's boot probe is a clean 200.
//
// See port/AuthDirectory.md.

export namespace OpenIDLogic {

    /** The application's authorizer when it is an OpenID one, else undefined. */
    export function authorizer(): OpenIDAuthorizer | undefined {
        return AuthLogic.authorizer instanceof OpenIDAuthorizer ? AuthLogic.authorizer : undefined;
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        if (sb.webBuilder)
            OpenIDAuthenticationServer.start(sb.webBuilder);
    }
}
