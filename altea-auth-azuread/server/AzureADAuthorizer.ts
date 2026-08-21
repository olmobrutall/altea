import type { JWTPayload } from "jose";
import {
    ADAuthorizer, type DirectoryGroup, type ExternalUser, type IAutoCreateUserContext, type IDirectoryInviter,
} from "@altea/altea-auth/server/ADAuthorizer";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { AzureADConfigurationEmbedded, AzureADType } from "../data/AzureAD";
import { AzureADLogic } from "./AzureADLogic";
import type { GraphUser } from "./MicrosoftGraph";

// Port of Signum.Authorization.AzureAD's Authorizer/AzureADAuthorizer.cs +
// Authorizer/AzureClaimsAutoCreateUserContext.cs.
//
// As in the OpenID module, everything shared with the other directory authorizers lives in altea-auth's
// `ADAuthorizer`; what remains is the claim NAMES (which differ per Azure product) and the Graph group
// lookup.
//
// altea divergences, documented inline:
//  - `ClaimsPrincipal` → the verified JWT payload.
//  - `Func<string? adVariant, AzureADConfigurationEmbedded?> GetConfig` — Signum's per-VARIANT lookup, so
//    one application can offer several Azure configurations (a work tenant and a B2C tenant side by side).
//    altea keeps the variant: `ADAuthorizer.getConfig` takes no argument, so this class adds
//    `getConfigFor(adVariant)` and implements `getConfig()` as `getConfigFor(null)` (the default variant).

/** Signum's AzureClaimsAutoCreateUserContext — a work/school-tenant token. */
export class AzureClaimsContext implements IAutoCreateUserContext {

    constructor(
        readonly claims: JWTPayload,
        readonly accessToken: string,
        readonly config: AzureADConfigurationEmbedded,
    ) { }

    getClaim(type: string): string {
        const value = this.tryGetClaim(type);
        if (value == null)
            throw new Error(`The id_token has no '${type}' claim`);
        return value;
    }

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
        return this.tryGetClaim("http://schemas.microsoft.com/identity/claims/objectidentifier")
            ?? this.tryGetClaim("oid"); // AAD v2.0
    }

    get userName(): string { return this.getClaim("preferred_username"); }
    get emailAddress(): string | null { return this.getClaim("preferred_username"); }
    get fullName(): string | null { return this.tryGetClaim("name"); }

    /** Signum splits a "Last, First" or "First Last" display name; "Unknown" when there is nothing. */
    get firstName(): string {
        const name = this.fullName;
        if (name == null)
            return "Unknown";
        if (name.includes(","))
            return after(name, ",").trim();
        return tryBefore(name, " ")?.trim() ?? (name === "" ? "Unknown" : name);
    }

    get lastName(): string {
        const name = this.fullName;
        if (name == null)
            return "Unknown";
        if (name.includes(","))
            return before(name, ",").trim();
        return tryAfter(name, " ")?.trim() ?? "Unknown";
    }
}

/** Signum's AzureExternalIDAutoCreateUserContext — same claims as a work tenant. */
export class AzureExternalIDClaimsContext extends AzureClaimsContext { }

/** Signum's AzureB2CClaimsAutoCreateUserContext — B2C puts the identity in different claims. */
export class AzureB2CClaimsContext extends AzureClaimsContext {
    override get userName(): string { return this.getClaim("emails"); }
    override get emailAddress(): string | null { return this.getClaim("emails"); }
    override get fullName(): string | null {
        return this.tryGetClaim("name") ?? [this.firstName, this.lastName].filter(a => a).join(" ");
    }
    override get firstName(): string { return this.getClaim("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"); }
    override get lastName(): string { return this.getClaim("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"); }
    override get externalId(): string | null { return this.getClaim("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"); }
}

/** Signum's MicrosoftGraphCreateUserContext — a directory record fetched from Graph (the invite flow). */
export class MicrosoftGraphCreateUserContext implements IAutoCreateUserContext {
    constructor(readonly user: GraphUser, readonly config: AzureADConfigurationEmbedded) { }

    get userName(): string { return this.user.userPrincipalName!; }
    get emailAddress(): string | null { return this.user.userPrincipalName ?? null; }
    get firstName(): string { return this.user.givenName ?? tryBefore(this.user.displayName ?? null, " ") ?? this.user.displayName!; }
    get lastName(): string { return this.user.surname ?? tryAfter(this.user.displayName ?? null, " ") ?? this.user.displayName!; }
    get externalId(): string | null { return this.user.id ?? null; }
}

export class AzureADAuthorizer extends ADAuthorizer<AzureADConfigurationEmbedded> implements IDirectoryInviter {

    /**
     * Signum's `Func<string?, AzureADConfigurationEmbedded?> GetConfig` — resolve the configuration for one
     * AD VARIANT ("default", or an application-specific name). The base class's `getConfig()` is the
     * default variant.
     */
    constructor(readonly getConfigFor: (adVariant: string | null) => AzureADConfigurationEmbedded | null) {
        super(() => getConfigFor(null));
    }

    /**
     * Signum's group lookup: the signed-in identity's TRANSITIVE group membership, read either with the
     * application's own credentials or — when `useDelegatedPermission` — with the user's own access token
     * (`/me/transitiveMemberOf`, which needs no directory-wide application permission).
     */
    protected override async getDirectoryGroups(ctx: IAutoCreateUserContext): Promise<DirectoryGroup[] | null> {
        if (ctx.externalId == null)
            return null;

        const config = ctx.config as AzureADConfigurationEmbedded;

        if (ctx instanceof AzureClaimsContext && config.useDelegatedPermission)
            return await AzureADLogic.currentADGroupsDelegated(config, ctx.accessToken);

        return await AzureADLogic.currentADGroups(config, ctx.externalId);
    }

    // ---- IDirectoryInviter (the "find a user in the directory and import them" flow) ------------------

    findUser(subString: string, count: number, signal?: AbortSignal): Promise<ExternalUser[]> {
        return AzureADLogic.findActiveDirectoryUsers(subString, count, signal);
    }

    createFromExternalUser(user: ExternalUser): Promise<UserEntity> {
        return AzureADLogic.createUserFromAD(user);
    }
}

/** Build the right claims context for the configured Azure product (Signum's `config.Type switch`). */
export function claimsContextFor(config: AzureADConfigurationEmbedded, claims: JWTPayload, accessToken: string): AzureClaimsContext {
    switch (config.type) {
        case AzureADType.AzureAD: return new AzureClaimsContext(claims, accessToken, config);
        case AzureADType.B2C: return new AzureB2CClaimsContext(claims, accessToken, config);
        case AzureADType.ExternalID: return new AzureExternalIDClaimsContext(claims, accessToken, config);
        default: throw new Error(`Unexpected AzureADType ${String(config.type)}`);
    }
}

function tryBefore(value: string | null, separator: string): string | null {
    if (value == null) return null;
    const i = value.indexOf(separator);
    return i < 0 ? null : value.substring(0, i);
}
function tryAfter(value: string | null, separator: string): string | null {
    if (value == null) return null;
    const i = value.indexOf(separator);
    return i < 0 ? null : value.substring(i + separator.length);
}
function before(value: string, separator: string): string {
    return value.substring(0, value.indexOf(separator));
}
function after(value: string, separator: string): string {
    return value.substring(value.indexOf(separator) + separator.length);
}
