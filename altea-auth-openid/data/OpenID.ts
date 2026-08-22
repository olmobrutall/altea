import { reflect } from "@altea/altea/data/reflection";
import { entity, backReference } from "@altea/altea/data/decorators";
import { noRepeatValidator } from "@altea/altea/data/validators";
import type { Lite } from "@altea/altea/data/lite";
import { stringLengthValidator } from "@altea/altea/data/decorators";
import { urlValidator, ValidationMessage } from "@altea/altea/data/validators";
import { fieldValidation } from "@altea/altea/data/decorators";
import { msg } from "@altea/altea/data/utils/localization";
import { BaseADConfigurationEmbedded, RoleMappingEmbedded } from "@altea/altea-auth/data/BaseAD";

// Port of Signum.Authorization.OpenID's OpenIDConfigurationEmbedded.cs — how to talk to a standards-only
// OpenID Connect provider (Keycloak, Dex, Auth0, …) with the authorization-code flow.
//
// altea divergences, documented inline:
//  - Signum's `PropertyValidation` override becomes per-field `@fieldValidation` (altea has no
//    entity-level validation hook). Same rule: `authority` and `clientId` are required once `enabled`.
//  - `ToOpenIDConfigTS()` (the DTO the server serialises into Index.cshtml) becomes the
//    `OpenIDClientConfig` interface below, served by an anonymous endpoint — altea has no server-rendered
//    HTML page to inject `window.__openIDConfig` into (see OpenIDAuthenticationServer).
//  - `GetScopes()` / `GetDiscoveryEndpoint()` stay on the entity: they are pure string work over its own
//    fields and both the server and the config DTO need them.

@reflect
@entity("Part", "Master")
export class OpenIDConfigurationEmbedded extends BaseADConfigurationEmbedded {
    enabled: boolean = false;

    /** The provider's base URL, e.g. `https://keycloak.example.com/realms/myrealm`. */
    @urlValidator()
    @stringLengthValidator({ max: 300 })
    @fieldValidation<OpenIDConfigurationEmbedded>(c =>
        c.enabled && !hasText(c.authority) ? ValidationMessage._0IsNotSet.niceToString("Authority") : null)
    authority: string | null = null;

    @stringLengthValidator({ max: 200 })
    @fieldValidation<OpenIDConfigurationEmbedded>(c =>
        c.enabled && !hasText(c.clientId) ? ValidationMessage._0IsNotSet.niceToString("Client Id") : null)
    clientId: string | null = null;

    @stringLengthValidator({ max: 300 })
    clientSecret: string | null = null;

    /** Where the roles live in the id_token: a claim name (`roles`, `groups`) or a dotted path into a
     *  JSON-valued claim (`realm_access.roles`). */
    @stringLengthValidator({ max: 200 })
    roleClaimPath: string | null = null;

    /** Space-separated scopes; empty means `openid profile email`. */
    @stringLengthValidator({ max: 500 })
    scopes: string | null = null;

    /** Accept ANY server certificate when talking to the provider. Development only. */
    avoidSSLVerify: boolean = false;

    /** Signum's GetDiscoveryEndpoint. */
    getDiscoveryEndpoint(): string {
        return `${this.authority!.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    }

    /** Signum's GetScopes — the configured scopes, or the OIDC defaults. */
    getScopes(): string[] {
        return hasText(this.scopes) ? this.scopes!.split(" ").filter(s => s !== "") : ["openid", "profile", "email"];
    }

    /** Signum's ToOpenIDConfigTS — what the browser needs to start the flow (never the client secret). */
    toClientConfig(): OpenIDClientConfig | null {
        return !this.enabled ? null : {
            authority: this.authority!,
            clientId: this.clientId!,
            scopes: this.getScopes(),
        };
    }
    /** Signum's `MList<RoleMappingEmbedded> RoleMapping` — this configuration's own @part rows (the row type
     *  is per module, see BaseAD's header). */
    @noRepeatValidator()
    roleMapping: OpenIDConfigurationEmbedded_RoleMapping[];

    override roleMappings(): RoleMappingEmbedded[] { return this.roleMapping; }

}

// Signum's RoleMappingEmbedded rows for this configuration (see BaseAD's RoleMappingEmbedded).
@entity("Part", "Master")
export class OpenIDConfigurationEmbedded_RoleMapping extends RoleMappingEmbedded {
    @backReference configuration: Lite<OpenIDConfigurationEmbedded>;
}

function hasText(s: string | null | undefined): boolean {
    return s != null && s.trim() !== "";
}

/** Signum's OpenIDConfigTS — the browser-visible half of the configuration. */
export interface OpenIDClientConfig {
    authority: string;
    clientId: string;
    scopes: string[];
}

/** The provider endpoints the browser needs, read from the discovery document server-side. */
export interface OpenIDEndpoints {
    authorizationEndpoint: string;
    endSessionEndpoint?: string;
}

/** Signum's `[AllowUnauthenticated] enum OpenIDMessage`. */
export const OpenIDMessage = {
    SignInWithOpenID: msg("Sign in with OpenID"),
};
