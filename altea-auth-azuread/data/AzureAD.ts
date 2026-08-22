import { reflect, init } from "@altea/altea/data/reflection";
import { entity, backReference } from "@altea/altea/data/decorators";
import { noRepeatValidator } from "@altea/altea/data/validators";
import type { Lite } from "@altea/altea/data/lite";
import { niceName, stringLengthValidator } from "@altea/altea/data/decorators";
import { fieldValidation } from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import { BaseADConfigurationEmbedded, RoleMappingEmbedded } from "@altea/altea-auth/data/BaseAD";
import { SimpleTaskSymbol } from "@altea/altea-scheduler/data/Scheduler";

// Port of Signum.Authorization.AzureAD's AzureADConfigurationEmbedded.cs + AzureADQuery.cs — how to talk to
// Microsoft Entra ID, in its three flavours.
//
// altea divergences, documented inline:
//  - `Guid ApplicationID / DirectoryID` are `string` (a uuid) rather than a Guid value type: they are only
//    ever formatted into URLs and compared to the token's `aud`, and altea's Guid support is a PK/column
//    concern. `@fieldValidation` keeps them well-formed.
//  - Signum's `StateValidator<AzureADConfigurationEmbedded, AzureADType>` (a per-type × per-field
//    required/forbidden MATRIX) becomes explicit `@fieldValidation` rules — altea has no StateValidator, and
//    the three rows of Signum's table are short enough to read directly. The matrix is reproduced verbatim
//    in `stateRule` below so a future Signum change is easy to re-apply.
//  - `ToAzureADConfigTS(scopes)` → `toClientConfig(scopes?)`, and the DTO is served by an anonymous endpoint
//    instead of being injected into Index.cshtml (altea has no server-rendered page — see
//    AzureADAuthenticationServer).

/** Signum's AzureADType — which Microsoft identity product this configuration targets. */
export enum AzureADType {
    /** A work/school tenant (Entra ID). */
    AzureAD,
    /** Azure AD B2C — consumer identities, driven by named "user flows". */
    B2C,
    /** Entra External ID for customers (CIAM). */
    ExternalID,
}

@reflect
@entity("Part", "Master")
export class AzureADConfigurationEmbedded extends BaseADConfigurationEmbedded {
    enabled: boolean = false;

    type: AzureADType = AzureADType.AzureAD;

    @niceName("Application (client) ID")
    @fieldValidation<AzureADConfigurationEmbedded>(c =>
        c.enabled && !isUuid(c.applicationID) ? ValidationMessage._0DoesNotHaveAValid1Format.niceToString("Application (client) ID", "Guid") : null)
    applicationID: string = "";

    @niceName("Directory (tenant) ID")
    @fieldValidation<AzureADConfigurationEmbedded>(c =>
        c.enabled && !isUuid(c.directoryID) ? ValidationMessage._0DoesNotHaveAValid1Format.niceToString("Directory (tenant) ID", "Guid") : null)
    directoryID: string = "";

    @stringLengthValidator({ max: 100 })
    @fieldValidation<AzureADConfigurationEmbedded>(c => {
        const state = stateRule(c, "tenantName");
        if (state != null)
            return state;
        // Signum: for ExternalID the tenant name must be a b2clogin/ciamlogin DOMAIN, not a bare name.
        if (c.enabled && c.type === AzureADType.ExternalID && hasText(c.tenantName) && !c.tenantName!.includes("."))
            return ValidationMessage._0DoesNotHaveAValid1Format.niceToString("Tenant Name", "b2clogin domain");
        return null;
    })
    tenantName: string | null = null;

    @stringLengthValidator({ max: 300 })
    @fieldValidation<AzureADConfigurationEmbedded>(c => {
        // Signum's B2C row is "either SignInSignUp_UserFlow or SignIn_UserFlow".
        if (c.enabled && c.type === AzureADType.B2C && !hasText(c.signInSignUp_UserFlow) && !hasText(c.signIn_UserFlow))
            return ValidationMessage._0IsNotSet.niceToString("Sign In Sign Up User Flow");
        const state = stateRule(c, "signInSignUp_UserFlow");
        if (state != null)
            return state;
        // For ExternalID it is an absolute URL (the CIAM authority), not a flow name.
        if (c.enabled && c.type === AzureADType.ExternalID && hasText(c.signInSignUp_UserFlow) && !/^https?:\/\//i.test(c.signInSignUp_UserFlow!))
            return ValidationMessage._0DoesNotHaveAValid1Format.niceToString("Sign In Sign Up User Flow", "URL");
        return null;
    })
    signInSignUp_UserFlow: string | null = null;

    @stringLengthValidator({ max: 300 })
    @fieldValidation<AzureADConfigurationEmbedded>(c => stateRule(c, "signIn_UserFlow"))
    signIn_UserFlow: string | null = null;

    @stringLengthValidator({ max: 300 })
    @fieldValidation<AzureADConfigurationEmbedded>(c => stateRule(c, "signUp_UserFlow"))
    signUp_UserFlow: string | null = null;

    @stringLengthValidator({ max: 300 })
    @fieldValidation<AzureADConfigurationEmbedded>(c => stateRule(c, "editProfile_UserFlow"))
    editProfile_UserFlow: string | null = null;

    @stringLengthValidator({ max: 300 })
    @fieldValidation<AzureADConfigurationEmbedded>(c => stateRule(c, "resetPassword_UserFlow"))
    resetPassword_UserFlow: string | null = null;

    /** Only needed for Microsoft Graph (directory queries, photos, the deactivate-users task) — NOT for
     *  signing in. Your App Registration → Certificates & secrets → + New client secret. */
    @niceName("Client Secret Value")
    @stringLengthValidator({ max: 100 })
    clientSecret: string | null = null;

    /** Read the signed-in user's groups with their OWN access token (delegated) rather than with the
     *  application's client credentials. */
    useDelegatedPermission: boolean = false;

    /** Signum's DefaultScopes. */
    defaultScopes(): string[] {
        switch (this.type) {
            case AzureADType.AzureAD: return ["user.read"];
            case AzureADType.B2C: return ["openid", "profile", "email"];
            case AzureADType.ExternalID: return ["user.read"];
            default: throw new Error(`Unexpected AzureADType ${String(this.type)}`);
        }
    }

    /** Signum's DefaultSignIn — the sign-in-or-sign-up flow, falling back to the sign-in-only one. */
    defaultSignIn(): string {
        return hasText(this.signInSignUp_UserFlow) ? this.signInSignUp_UserFlow! : this.signIn_UserFlow!;
    }

    /** Signum's GetDiscoveryEndpoint — where the token's signing keys and issuer are published. */
    getDiscoveryEndpoint(): string {
        switch (this.type) {
            case AzureADType.AzureAD:
                return "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration";
            case AzureADType.B2C:
                return `https://${this.tenantName}.b2clogin.com/${this.tenantName}.onmicrosoft.com/`
                    + `${this.defaultSignIn()}/v2.0/.well-known/openid-configuration?p=${this.defaultSignIn()}`;
            case AzureADType.ExternalID:
                return `${this.signInSignUp_UserFlow}/v2.0/.well-known/openid-configuration?appid=${this.applicationID}`;
            default: throw new Error(`Unexpected AzureADType ${String(this.type)}`);
        }
    }

    /**
     * Signum's issuer choice: for a work/school tenant the discovery document is the MULTI-TENANT "common"
     * one, whose advertised issuer is templated — so the real tenant is substituted. B2C / External ID
     * publish their own concrete issuer.
     */
    getIssuer(discoveredIssuer: string): string {
        return this.type === AzureADType.AzureAD
            ? `https://login.microsoftonline.com/${this.directoryID}/v2.0`
            : discoveredIssuer;
    }

    /** Signum's ToAzureADConfigTS — the browser-visible half (never the client secret). */
    toClientConfig(scopes?: string[]): AzureADClientConfig | null {
        return !this.enabled ? null : {
            type: AzureADType[this.type] as keyof typeof AzureADType,
            applicationId: this.applicationID,
            tenantId: this.directoryID,
            tenantName: this.tenantName ?? undefined,
            signInSignUp_UserFlow: this.signInSignUp_UserFlow ?? undefined,
            signIn_UserFlow: this.signIn_UserFlow ?? undefined,
            signUp_UserFlow: this.signUp_UserFlow ?? undefined,
            editProfile_UserFlow: this.editProfile_UserFlow ?? undefined,
            resetPassword_UserFlow: this.resetPassword_UserFlow ?? undefined,
            scopes: scopes ?? this.defaultScopes(),
        };
    }
    /** Signum's `MList<RoleMappingEmbedded> RoleMapping` — this configuration's own @part rows (the row type
     *  is per module, see BaseAD's header). */
    @noRepeatValidator()
    roleMapping: AzureADConfigurationEmbedded_RoleMapping[];

    override roleMappings(): RoleMappingEmbedded[] { return this.roleMapping; }

}

// Signum's RoleMappingEmbedded rows for this configuration (see BaseAD's RoleMappingEmbedded).
@entity("Part", "Master")
export class AzureADConfigurationEmbedded_RoleMapping extends RoleMappingEmbedded {
    @backReference configuration: Lite<AzureADConfigurationEmbedded>;
}

/**
 * Signum's `StateValidator<AzureADConfigurationEmbedded, AzureADType>` table, verbatim:
 *
 * ```
 *                      tenantName  signInSignUp  signIn  signUp  editProfile  resetPassword
 *   AzureAD            false       false         false   false   false        false
 *   B2C                true        null (either) null    null    null         null
 *   ExternalID         true        true          false   false   false        false
 * ```
 *
 * `true` = must be set, `false` = must NOT be set, `null` = no rule. Only checked while `enabled`.
 */
const stateMatrix: Record<AzureADType, Partial<Record<StateField, boolean | null>>> = {
    [AzureADType.AzureAD]: {
        tenantName: false, signInSignUp_UserFlow: false, signIn_UserFlow: false,
        signUp_UserFlow: false, editProfile_UserFlow: false, resetPassword_UserFlow: false,
    },
    [AzureADType.B2C]: {
        tenantName: true, signInSignUp_UserFlow: null, signIn_UserFlow: null,
        signUp_UserFlow: null, editProfile_UserFlow: null, resetPassword_UserFlow: null,
    },
    [AzureADType.ExternalID]: {
        tenantName: true, signInSignUp_UserFlow: true, signIn_UserFlow: false,
        signUp_UserFlow: false, editProfile_UserFlow: false, resetPassword_UserFlow: false,
    },
};

type StateField = "tenantName" | "signInSignUp_UserFlow" | "signIn_UserFlow"
    | "signUp_UserFlow" | "editProfile_UserFlow" | "resetPassword_UserFlow";

function stateRule(c: AzureADConfigurationEmbedded, field: StateField): string | null {
    if (!c.enabled)
        return null;

    const required = stateMatrix[c.type]?.[field];
    if (required == null)
        return null;

    const set = hasText(c[field]);
    if (required && !set)
        return ValidationMessage._0IsNotSet.niceToString(niceFieldName(field));
    if (!required && set)
        return ValidationMessage._0ShouldBeNull.niceToString(niceFieldName(field));

    return null;
}

function niceFieldName(field: StateField): string {
    return field.replace(/_/g, " ").replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim();
}

function hasText(s: string | null | undefined): boolean {
    return s != null && s.trim() !== "";
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string | null | undefined): boolean {
    return s != null && uuidRegex.test(s);
}

/** Signum's AzureADConfigTS — what the browser needs for the MSAL flow. */
export interface AzureADClientConfig {
    type: keyof typeof AzureADType;
    applicationId: string;
    tenantId: string;
    tenantName?: string;
    signInSignUp_UserFlow?: string;
    signIn_UserFlow?: string;
    signUp_UserFlow?: string;
    editProfile_UserFlow?: string;
    resetPassword_UserFlow?: string;
    scopes: string[];
}

/** Signum's `[AutoInit] static class AzureADTask` — the nightly "who left the company?" sweep. */
export namespace AzureADTask {
    export const DeactivateUsers: SimpleTaskSymbol = init();
}

/** altea-only: the message the directory-query converter raises for a filter Graph cannot express. */
export const AzureADMessage = {
    _0IsNotImplementedInMicrosoftGraph: msg("{0} is not implemented in the Microsoft Graph API"),
    UnableToMixFilterAndSearchInAnOr: msg("Unable to convert filter (mixing $filter and $search inside an OR)"),
};
