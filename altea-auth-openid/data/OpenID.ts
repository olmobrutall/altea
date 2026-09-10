import { reflect, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { part, backReference, implementedBy } from "@altea/altea/data/decorators";
import {
    noRepeatValidator, stringLengthValidator, urlValidator, ValidationMessage, validate,
} from "@altea/altea/data/validators";
import type { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { msg } from "@altea/altea/data/utils/localization";
import { BaseADConfigurationEmbedded, RoleMappingEntity } from "@altea/altea-auth/data/BaseAD";

// How to talk to a standards-only OpenID Connect provider (Keycloak, Dex, Auth0, …) with the
// authorization-code flow.
//
// `OpenIDClientConfig` below is what the BROWSER is given — never the client secret — served by an
// anonymous endpoint. `getScopes()` / `getDiscoveryEndpoint()` stay on the entity: pure string work over
// its own fields, needed by both the server and that DTO.
//
// Port of Signum.Authorization.OpenID's OpenIDConfigurationEmbedded.cs — see docs/port/AuthDirectory.md.

@reflect
@reflect
export class OpenIDConfigurationEmbedded extends BaseADConfigurationEmbedded {
    enabled: boolean = false;

    /** The provider's base URL, e.g. `https://keycloak.example.com/realms/myrealm`. */
    @urlValidator()
    @stringLengthValidator({ max: 300 })
    @validate<OpenIDConfigurationEmbedded>(c =>
        c.enabled && !hasText(c.authority) ? ValidationMessage._0IsNotSet.niceToString("Authority") : null)
    authority: string | null = null;

    @stringLengthValidator({ max: 200 })
    @validate<OpenIDConfigurationEmbedded>(c =>
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

    /** The provider's `.well-known/openid-configuration` URL, derived from `authority`. */
    getDiscoveryEndpoint(): string {
        return `${this.authority!.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    }

    /** The configured scopes, or the OIDC defaults. */
    getScopes(): string[] {
        return hasText(this.scopes) ? this.scopes!.split(" ").filter(s => s !== "") : ["openid", "profile", "email"];
    }

    /** What the browser needs to start the flow (never the client secret). */
    toClientConfig(): OpenIDClientConfig | null {
        return !this.enabled ? null : {
            authority: this.authority!,
            clientId: this.clientId!,
            scopes: this.getScopes(),
        };
    }
    /** This configuration's own @part rows (the row type
     *  is per module, see BaseAD's header). */
    @noRepeatValidator()
    roleMapping: OpenIDRoleMappingEntity[];

    override roleMappings(): RoleMappingEntity[] { return this.roleMapping; }

}

// This configuration's own role-mapping rows (see BaseAD's RoleMappingEntity).
@part
export class OpenIDRoleMappingEntity extends RoleMappingEntity {
    // The rows belong to the ENTITY holding this configuration — the application's settings row, which a
    // framework package must not name. The app widens this in its EntityOverrides (see BaseAD's header);
    // SchemaBuilder verifies it resolves to exactly one owner.
    @backReference @implementedBy(() => []) configuration: Lite<Entity>;
}

function hasText(s: string | null | undefined): boolean {
    return s != null && s.trim() !== "";
}

/** The browser-visible half of the configuration. */
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

/** Readable by an ANONYMOUS caller: these strings appear on the login screen. */
export const OpenIDMessage = {
    SignInWithOpenID: msg("Sign in with OpenID"),
};

setDefaultDatabaseSchema("openid");
