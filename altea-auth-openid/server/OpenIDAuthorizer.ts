import type { JWTPayload } from "jose";
import { ADAuthorizer, type DirectoryGroup, type IAutoCreateUserContext } from "@altea/altea-auth/server/ADAuthorizer";
import { OpenIDConfigurationEmbedded } from "../data/OpenID";

// Port of Signum.Authorization.OpenID's Authorizer/OpenIDAuthorizer.cs +
// Authorizer/OpenIDClaimsAutoCreateUserContext.cs.
//
// Everything shared with the Azure AD / Windows AD authorizers (create / update / match / role fallback)
// lives in altea-auth's `ADAuthorizer`; what remains here is the two things that are genuinely OIDC:
// which CLAIMS identify the user, and how the roles are read out of the token.
//
// altea divergences, documented inline:
//  - `ClaimsPrincipal` → the verified JWT payload (a plain claims object). `GetClaim` / `TryGetClaim`
//    become property reads; a claim that is an ARRAY (some providers repeat `email`) takes its first
//    string, which is what `SingleOrDefaultEx` over ASP.NET's claim collection effectively did for the
//    single-valued claims read here.
//  - `ExtractRoles` becomes `directoryGroups` below, feeding altea-auth's ONE role-mapping
//    implementation instead of Signum's per-module copy.

/** Signum's OpenIDClaimsAutoCreateUserContext — the id_token's claims, read as a directory identity. */
export class OpenIDClaimsContext implements IAutoCreateUserContext {

    constructor(
        readonly claims: JWTPayload,
        readonly accessToken: string,
        readonly config: OpenIDConfigurationEmbedded,
    ) { }

    /** Signum's GetClaim — throws when the claim is absent. */
    getClaim(type: string): string {
        const value = this.tryGetClaim(type);
        if (value == null)
            throw new Error(`The id_token has no '${type}' claim`);
        return value;
    }

    /** Signum's TryGetClaim. */
    tryGetClaim(type: string): string | null {
        const raw = this.claims[type];
        if (raw == null)
            return null;
        if (typeof raw === "string")
            return raw;
        if (Array.isArray(raw)) {
            const first = raw.find(v => typeof v === "string");
            return first == null ? null : first as string;
        }
        return String(raw);
    }

    get externalId(): string | null {
        return this.tryGetClaim("sub");
    }

    get userName(): string {
        return this.tryGetClaim("preferred_username")
            ?? this.tryGetClaim("email")
            ?? this.getClaim("sub");
    }

    get emailAddress(): string | null {
        const email = this.tryGetClaim("email");
        if (email != null)
            return email;
        const preferred = this.tryGetClaim("preferred_username");
        return preferred != null && preferred.includes("@") ? preferred : null;
    }

    get fullName(): string | null {
        return this.tryGetClaim("name");
    }

    get firstName(): string {
        return this.tryGetClaim("given_name")
            ?? tryBefore(this.fullName, " ")
            ?? this.userName;
    }

    get lastName(): string {
        return this.tryGetClaim("family_name")
            ?? tryAfter(this.fullName, " ")
            ?? "Unknown";
    }
}

export class OpenIDAuthorizer extends ADAuthorizer<OpenIDConfigurationEmbedded> {

    /** Signum's `ExtractRoles(principal, roleClaimPath)`, adapted to altea-auth's group shape. A role
     *  string from the token is matched against a `roleMapping` entry's `adNameOrGuid` BY NAME. */
    protected override getDirectoryGroups(ctx: IAutoCreateUserContext): Promise<DirectoryGroup[] | null> {
        if (!(ctx instanceof OpenIDClaimsContext))
            return Promise.resolve(null);

        const path = ctx.config.roleClaimPath;
        if (path == null || path.trim() === "")
            return Promise.resolve(null);

        return Promise.resolve(extractRoles(ctx.claims, path).map(r => ({ id: null, displayName: r })));
    }
}

/**
 * Signum's `OpenIDAuthorizer.ExtractRoles`. A SIMPLE path ("roles", "groups") is a claim name; a DOTTED
 * path ("realm_access.roles", "resource_access.myclient.roles") navigates INTO a claim's JSON value.
 *
 * altea divergence: a JWT payload is already parsed JSON, so navigation is plain property access — Signum
 * has to `JsonDocument.Parse` the claim's string value first, because ASP.NET flattens every claim to a
 * string. A provider that really does send the claim as a JSON STRING is still handled (the string is
 * parsed) so the behaviour is a superset of Signum's.
 */
export function extractRoles(claims: JWTPayload, roleClaimPath: string): string[] {
    const parts = roleClaimPath.split(".");

    let current: unknown = claims[parts[0]!.trim()];

    if (typeof current === "string" && parts.length > 1) {
        try {
            current = JSON.parse(current);
        } catch {
            return [];
        }
    }

    for (let i = 1; i < parts.length; i++) {
        if (current == null || typeof current !== "object")
            return [];
        current = (current as Record<string, unknown>)[parts[i]!];
    }

    if (Array.isArray(current))
        return current.filter((v): v is string => typeof v === "string");

    if (typeof current === "string")
        return [current];

    return [];
}

function tryBefore(value: string | null, separator: string): string | null {
    if (value == null)
        return null;
    const i = value.indexOf(separator);
    return i < 0 ? null : value.substring(0, i).trim();
}

function tryAfter(value: string | null, separator: string): string | null {
    if (value == null)
        return null;
    const i = value.indexOf(separator);
    return i < 0 ? null : value.substring(i + separator.length).trim();
}
