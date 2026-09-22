import { UserWithClaims } from "@altea/altea/data/security";
import {
    setAuthenticateRequest, type AuthRequestLike, type AuthResponseLike,
} from "@altea/altea/server/filters/userScope";
import { AuthTokenServer } from "../AuthTokenServer";
import { AuthLogic } from "../AuthLogic";

// Signum's `SignumAuthenticationFilter` — the auth half of it.
//
// The SCOPE is core's, mounted by the WebBuilder constructor so it is in place before any module runs
// (see @altea/altea/server/filters/userScope for why that has to be true). What is left here is naming
// WHO the request is, which is the one part core cannot know — the same shape as the authorization gate
// and the culture provider this module also fills.

async function authenticate(req: AuthRequestLike, res: AuthResponseLike): Promise<UserWithClaims | undefined> {
    const reqLike = {
        header: (n: string) => req.header(n) ?? undefined,
        hasQuery: (n: string) => req.query[n] != null,
        // Express gives a repeated parameter as an array and a single one as a string; normalise to
        // an array so an authenticator can see "more than one" (see AuthRequestLike.query).
        query: (n: string) => {
            const v = req.query[n];
            return v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
        },
    };
    const resLike = { setHeader: (n: string, v: string) => { res.setHeader(n, v); } };
    for (const authenticator of AuthTokenServer.authenticators) {
        const result = await authenticator(reqLike, resLike);
        if (result != null)
            return result;
    }
    // Permissive fallback: a configured AnonymousUser, else undefined (request proceeds anonymous).
    const anon = await AuthLogic.anonymousUser();
    return anon != null ? new UserWithClaims(anon) : undefined;
}

/**
 * Hand core the authenticator chain.
 *
 * Authenticating is not authorizing: a request with no valid token simply proceeds with no user, and the
 * authorization filter is what rejects it unless the route is `allowAnonymous`.
 *
 * Order-free, unlike the middleware this replaced: the scope is already mounted, so a route registered
 * before this call is authenticated just the same.
 */
export function installAuthenticator(): void {
    setAuthenticateRequest(authenticate);
}
