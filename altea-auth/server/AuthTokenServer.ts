import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Lite } from "@altea/altea/data/lite";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { UserWithClaims, type IUserEntity } from "@altea/altea/data/security";
import { Serializer } from "@altea/altea/data/serializer";
import { AuthenticationException } from "@altea/altea/server/exceptions";
import { table } from "@altea/altea/server/table";
import { UserEntity, UserState } from "../data/User";
import { RoleEntity } from "../data/Role";
import { LoginAuthMessage } from "../data/AuthMessages";
import { AuthTokenConfigurationEmbedded } from "../data/AuthToken";
import { encodeHash } from "./AuthLogic";

// Port of Signum.Authorization's AuthToken/AuthTokensServer.cs — see port/Auth.md.
//
// An OPAQUE bearer token: a JSON payload → AES-CBC (key = MD5 of the encryption key, random IV
// prepended) → base64. The client stores it and echoes it as `Authorization: Bearer <token>`; the server
// refreshes it periodically through a New_Token header.
//
// The payload is a COMPACT hand-rolled shape — user / role id + toStr + passwordHash + creationDate —
// rather than a full serialized graph: enough to rebuild a UserWithClaims and detect a password change.
// It DOES carry the claims bag, and must: a claim is filled from the FULL user, which only the login and
// the refresh ever hold, so a claim that did not ride along would exist for one request and then vanish.
//
// No Deflate around the JSON (correctness-neutral); the byte format is otherwise Signum's.

interface TokenPayload {
    u: PrimaryKey;          // user id
    ut: string;             // user toString
    r: PrimaryKey | null;   // role id
    rt: string | null;      // role toString
    ph: string | null;      // passwordHash (base64) — to detect a password change
    c: string;              // creationDate (ISO PlainDateTime)
    cl?: string;            // the CLAIMS bag, Serializer-encoded
}

// One authenticator in the chain. Returns the
// resolved user, `undefined` to fall through to the next, or throws to reject the request.
export type Authenticator = (req: AuthRequestLike, res: AuthResponseLike) => Promise<UserWithClaims | undefined>;

// Minimal request/response surface the authenticators need (kept framework-agnostic; the Express
// middleware in AuthServer adapts to it).
export interface AuthRequestLike {
    header(name: string): string | undefined;
    hasQuery(name: string): boolean;
    /**
     * A query parameter's VALUE(s) — an array because a caller may repeat a parameter, and an
     * authenticator that authenticates ON a query parameter has to notice that (@altea/altea-rest
     * rejects a request carrying more than one API key rather than picking one). `hasQuery` above
     * stays: the token authenticator only asks whether `?refreshToken` is present.
     */
    query(name: string): string[];
}
export interface AuthResponseLike {
    setHeader(name: string, value: string): void;
}

export namespace AuthTokenServer {
    /**
     * The settings, read through a THUNK returning the cache's own promise, so they come off the
     * application's configuration ROW and an administrator's change takes effect without a restart.
     *
     * A thunk and not the promise itself: a captured promise keeps the value it was stamped with, so it
     * would go stale at the first invalidation. The host supplies it in `start`.
     */
    export let configuration: () => Promise<AuthTokenConfigurationEmbedded> =
        () => Promise.resolve(new AuthTokenConfigurationEmbedded());
    export const authHeader = "Authorization";

    // The authenticator chain. TokenAuthenticator is the only built-in for
    // now; anonymous / allow-anonymous handling lives in the AuthServer middleware (permissive).
    export const authenticators: Authenticator[] = [];

    let cryptoKey: Buffer | null = null;

    /**
     * @param encryptionKey  what the token is SIGNED with. From the environment, not the configuration
     *   row: it is needed to read the very first request, before any row can be loaded.
     * @param getConfiguration  the settings row's `authTokens` member. Omitted, the defaults apply.
     */
    export function start(encryptionKey: string,
        getConfiguration?: () => Promise<AuthTokenConfigurationEmbedded>): void {
        if (encryptionKey == null || encryptionKey === "")
            throw new Error("AuthTokenServer.start: encryptionKey is not set");
        cryptoKey = createHash("md5").update(Buffer.from(encryptionKey, "utf8")).digest(); // 16 bytes → AES-128
        if (getConfiguration != null) configuration = getConfiguration;
        authenticators.push(tokenAuthenticator);
    }

    export async function getTokenLimitDate(): Promise<Temporal.PlainDateTime> {
        const config = await configuration();
        return Temporal.Now.plainDateTimeISO().subtract({ minutes: config.refreshTokenEvery as number });
    }

    // A base64 fingerprint of the user's stored password hash (now raw binary bytes), embedded in the
    // token so a password change invalidates outstanding tokens.
    function phFingerprint(user: UserEntity): string | null {
        return user.passwordHash == null ? null : encodeHash(Buffer.from(user.passwordHash));
    }

    export function createToken(user: UserEntity): string {
        const role = user.role as Lite<RoleEntity> | null;
        const payload: TokenPayload = {
            u: user.id,
            ut: user.toString(),
            r: role?.id ?? null,
            rt: role?.toString() ?? null,
            ph: phFingerprint(user),
            c: Temporal.Now.plainDateTimeISO().toString(),
            // Every claim a module derived from the full user rides along, so
            // a LATER request — which only ever decodes this token — sees the same bag the login did.
            // Without it a claim existed for exactly one request and `EmployeeEntity.current()` answered
            // null for the rest of the session. `Serializer.stringify`, not JSON: a claim is typically a
            // Lite, whose `entityType` is a CONSTRUCTOR that a plain stringify drops.
            cl: Serializer.stringify(new UserWithClaims(user).claims),
        };
        return serializeToken(payload);
    }

    // Validate the bearer token, refresh if stale, resolve the user.
    export const tokenAuthenticator: Authenticator = async (req, res) => {
        const header = req.header(authHeader);
        if (header == null || header === "")
            return undefined;

        const token = deserializeAuthHeaderToken(header);
        if (token == null)
            return undefined;

        const now = Temporal.Now.plainDateTimeISO();
        const creation = Temporal.PlainDateTime.from(token.c);

        // A token dated in the future is invalid.
        if (Temporal.PlainDateTime.compare(now.add({ seconds: 2 }), creation) < 0)
            throw new AuthenticationException(LoginAuthMessage.InvalidTokenDate0.niceToString(token.c));

        // Too old, minted before the configured cut-off, or asked for explicitly.
        const config = await configuration();
        const previousTo = config.refreshAnyTokenPreviousTo;
        const requiresRefresh =
            Temporal.PlainDateTime.compare(creation, await getTokenLimitDate()) < 0 ||
            (previousTo != null && Temporal.PlainDateTime.compare(creation, previousTo) < 0) ||
            req.hasQuery("refreshToken");

        if (requiresRefresh) {
            const { newToken, userWithClaims } = await refreshToken(token);
            res.setHeader("New_Token", newToken);
            return userWithClaims;
        }
        return toUserWithClaims(token);
    };

    // Re-read the user, re-check active/name/password, re-issue the token.
    async function refreshToken(oldToken: TokenPayload): Promise<{ newToken: string; userWithClaims: UserWithClaims }> {
        const user = await table(UserEntity).filter(u => u.id == oldToken.u).singleOrNull() as UserEntity | null;
        if (user == null)
            throw new AuthenticationException(LoginAuthMessage.TheUserIsNotLongerInTheDatabase.niceToString());
        if (user.state !== UserState.Active)
            throw new AuthenticationException(LoginAuthMessage.User0IsDeactivated.niceToString(user.toString()));
        if (user.toString() !== oldToken.ut)
            throw new AuthenticationException(LoginAuthMessage.InvalidUsername.niceToString());
        if ((phFingerprint(user) ?? "") !== (oldToken.ph ?? ""))
            throw new AuthenticationException(LoginAuthMessage.InvalidPassword.niceToString());

        return { newToken: createToken(user), userWithClaims: new UserWithClaims(user) };
    }

    function toUserWithClaims(token: TokenPayload): UserWithClaims {
        const userLite = UserEntity.newLite(token.u, token.ut);

        // The Role fallback covers a token minted before the bag
        // was carried (an open session across a deploy): rebuilding it from the id/toString the payload has
        // always had keeps that session working until its next refresh.
        const claims = token.cl != null
            ? Serializer.parse(token.cl) as Record<string, unknown>
            : token.r != null ? { Role: RoleEntity.newLite(token.r, token.rt ?? "") } : {};

        return new UserWithClaims(userLite, claims);
    }

    export function deserializeAuthHeaderToken(authHeader: string): TokenPayload | null {
        try {
            const raw = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : authHeader;
            return deserializeToken(raw);
        } catch {
            return null;
        }
    }

    function serializeToken(payload: TokenPayload): string {
        const json = Buffer.from(JSON.stringify(payload), "utf8");
        return encrypt(json).toString("base64");
    }

    function deserializeToken(token: string): TokenPayload {
        try {
            const decrypted = decrypt(Buffer.from(token, "base64"));
            return JSON.parse(decrypted.toString("utf8")) as TokenPayload;
        } catch {
            throw new AuthenticationException("Invalid token");
        }
    }

    function encrypt(data: Buffer): Buffer {
        if (cryptoKey == null) throw new Error("AuthTokenServer.start was not called");
        const iv = randomBytes(16);
        const cipher = createCipheriv("aes-128-cbc", cryptoKey, iv);
        return Buffer.concat([iv, cipher.update(data), cipher.final()]);
    }

    function decrypt(data: Buffer): Buffer {
        if (cryptoKey == null) throw new Error("AuthTokenServer.start was not called");
        const iv = data.subarray(0, 16);
        const decipher = createDecipheriv("aes-128-cbc", cryptoKey, iv);
        return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
    }
}

// re-exported for symmetry.
export { encodeHash };
