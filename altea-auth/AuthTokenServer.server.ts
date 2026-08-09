import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { LiteImp, Lite } from "@altea/altea/data/lite";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { UserWithClaims, type IUserEntity } from "@altea/altea/data/security";
import { AuthenticationException } from "@altea/altea/server/exceptions";
import { table } from "@altea/altea/server/table";
import { UserEntity, UserState } from "./User.data";
import { RoleEntity } from "./Role.data";
import { LoginAuthMessage } from "./AuthMessages.data";
import { encodeHash } from "./AuthLogic.server";

// Port of Signum's AuthTokenServer (AuthToken/AuthTokensServer.cs). An OPAQUE bearer token: a JSON
// payload → AES-CBC (key = MD5(encryptionKey), random IV prepended) → base64. The client stores it and
// echoes it as `Authorization: Bearer <token>`; the server refreshes it periodically (New_Token header).
//
// altea divergences, documented inline:
//  - No Deflate compression around the JSON (Signum compresses; correctness-neutral, dropped for
//    simplicity). Still AES-CBC + IV-prefix + base64, byte-format otherwise as Signum.
//  - The payload is a COMPACT hand-rolled shape (user/role id + toStr + passwordHash + creationDate),
//    not the full entity Serializer graph — enough to rebuild a UserWithClaims and detect a password
//    change. `Lite<IUserEntity>` is rebuilt as a plain LiteImp.
//  - The authenticator CHAIN is exposed as a seam (`authenticators`) exactly like Signum, so the
//    deferred UserTicket / AD authenticators can be appended later.

interface TokenPayload {
    u: PrimaryKey;          // user id
    ut: string;             // user toString
    r: PrimaryKey | null;   // role id
    rt: string | null;      // role toString
    ph: string | null;      // passwordHash (base64) — to detect a password change
    c: string;              // creationDate (ISO PlainDateTime)
}

export interface AuthTokenConfiguration {
    refreshTokenEveryMinutes: number;
}

// One authenticator in the chain (Signum's SignumAuthenticationFilter.Authenticators). Returns the
// resolved user, `undefined` to fall through to the next, or throws to reject the request.
export type Authenticator = (req: AuthRequestLike, res: AuthResponseLike) => Promise<UserWithClaims | undefined>;

// Minimal request/response surface the authenticators need (kept framework-agnostic; the Express
// middleware in AuthServer adapts to it).
export interface AuthRequestLike {
    header(name: string): string | undefined;
    hasQuery(name: string): boolean;
}
export interface AuthResponseLike {
    setHeader(name: string, value: string): void;
}

export namespace AuthTokenServer {
    export let configuration: AuthTokenConfiguration = { refreshTokenEveryMinutes: 30 };
    export const authHeader = "Authorization";

    // The authenticator chain (Signum's Authenticators). TokenAuthenticator is the only built-in for
    // now; anonymous / allow-anonymous handling lives in the AuthServer middleware (permissive).
    export const authenticators: Authenticator[] = [];

    let cryptoKey: Buffer | null = null;

    export function start(encryptionKey: string, config?: Partial<AuthTokenConfiguration>): void {
        if (encryptionKey == null || encryptionKey === "")
            throw new Error("AuthTokenServer.start: encryptionKey is not set");
        cryptoKey = createHash("md5").update(Buffer.from(encryptionKey, "utf8")).digest(); // 16 bytes → AES-128
        if (config != null) configuration = { ...configuration, ...config };
        authenticators.push(tokenAuthenticator);
    }

    export function getTokenLimitDate(): Temporal.PlainDateTime {
        return Temporal.Now.plainDateTimeISO().subtract({ minutes: configuration.refreshTokenEveryMinutes });
    }

    // Signum's CreateToken(user).
    // A base64 fingerprint of the user's stored password hash (now raw binary bytes), embedded in the
    // token so a password change invalidates outstanding tokens (Signum's `ph` check).
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
        };
        return serializeToken(payload);
    }

    // Signum's TokenAuthenticator: validate the bearer token, refresh if stale, resolve the user.
    export const tokenAuthenticator: Authenticator = async (req, res) => {
        const header = req.header(authHeader);
        if (header == null || header === "")
            return undefined;

        const token = deserializeAuthHeaderToken(header);
        if (token == null)
            return undefined;

        const now = Temporal.Now.plainDateTimeISO();
        const creation = Temporal.PlainDateTime.from(token.c);

        // A token dated in the future is invalid (Signum's InvalidTokenDate).
        if (Temporal.PlainDateTime.compare(now.add({ seconds: 2 }), creation) < 0)
            throw new AuthenticationException(LoginAuthMessage.InvalidTokenDate0.niceToString(token.c));

        const requiresRefresh =
            Temporal.PlainDateTime.compare(creation, getTokenLimitDate()) < 0 ||
            req.hasQuery("refreshToken");

        if (requiresRefresh) {
            const { newToken, userWithClaims } = await refreshToken(token);
            res.setHeader("New_Token", newToken);
            return userWithClaims;
        }
        return toUserWithClaims(token);
    };

    // Signum's RefreshToken: re-read the user, re-check active/name/password, re-issue the token.
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
        const userLite = new LiteImp<UserEntity>(token.u, UserEntity, token.ut) as unknown as Lite<IUserEntity>;
        const claims: Record<string, unknown> = {};
        if (token.r != null)
            claims["Role"] = new LiteImp<RoleEntity>(token.r, RoleEntity, token.rt ?? "");
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

// re-exported for symmetry with Signum's PasswordEncoding boundary use.
export { encodeHash };
