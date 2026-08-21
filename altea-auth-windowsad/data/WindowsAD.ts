import { reflect, init } from "@altea/altea/data/reflection";
import { stringLengthValidator, format } from "@altea/altea/data/decorators";
import { fieldValidation } from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import { BaseADConfigurationEmbedded } from "@altea/altea-auth/data/BaseAD";
import { SimpleTaskSymbol } from "@altea/altea-scheduler/data/Scheduler";

// Port of Signum.Authorization.WindowsAD's WindowsADConfigurationEmbedded.cs — how to reach an on-premises
// Active Directory domain.
//
// altea divergences, documented inline:
//  - Signum's `PropertyValidation` override becomes per-field `@fieldValidation`: the domain name is
//    required as soon as either login mode is on.
//  - `LoginWithWindowsAuthenticator` (integrated Kerberos/NTLM SSO) is KEPT as a setting, but a Node host
//    can only honour it by supplying a Negotiate provider — see WindowsADServer's `negotiateProvider`.
//    Nothing about the entity changes; the capability does.

@reflect
export class WindowsADConfigurationEmbedded extends BaseADConfigurationEmbedded {
    /**
     * Sign in with the browser's own Windows credentials (SPNEGO / Kerberos), no password typed.
     *
     * On a Node host this requires the host to install a Negotiate provider
     * (`WindowsADServer.negotiateProvider`); without one the endpoint answers a clear error. See that
     * module's header.
     */
    loginWithWindowsAuthenticator: boolean = false;

    /** Sign in with a typed user name + password, validated by binding to the directory. */
    loginWithActiveDirectoryRegistry: boolean = false;

    @stringLengthValidator({ max: 200 })
    @fieldValidation<WindowsADConfigurationEmbedded>(c =>
        (c.loginWithWindowsAuthenticator || c.loginWithActiveDirectoryRegistry) && !hasText(c.domainName)
            ? ValidationMessage._0IsNotSet.niceToString("Domain Name")
            : null)
    domainName: string | null = null;

    /** The service account used for directory LOOKUPS (searching users, reading groups and photos) when the
     *  host process itself is not a domain member. Signum's DirectoryRegistry_Username. */
    directoryRegistry_Username: string | null = null;

    @format("Password")
    directoryRegistry_Password: string | null = null;

    /**
     * altea addition: the LDAP URL to connect to. Signum's `PrincipalContext(ContextType.Domain, name)`
     * lets Windows discover a domain controller through DNS SRV records; Node has no such discovery, so the
     * URL is explicit — defaulting to `ldap://<domainName>`, which is what a domain's DNS name resolves to.
     */
    @stringLengthValidator({ max: 300 })
    ldapUrl: string | null = null;

    /**
     * altea addition, for the same reason: the search BASE DN (`DC=example,DC=com`).
     * `System.DirectoryServices` derives it from the bound domain; an LDAP search must be told. Defaults to
     * the domain name split into DC components.
     */
    @stringLengthValidator({ max: 300 })
    baseDN: string | null = null;

    /** The effective LDAP URL (see `ldapUrl`). */
    getLdapUrl(): string {
        return hasText(this.ldapUrl) ? this.ldapUrl! : `ldap://${this.domainName}`;
    }

    /** The effective search base (see `baseDN`): `example.com` → `DC=example,DC=com`. */
    getBaseDN(): string {
        if (hasText(this.baseDN))
            return this.baseDN!;
        return (this.domainName ?? "").split(".").filter(p => p !== "").map(p => `DC=${p}`).join(",");
    }

    /** The bind name for the lookup account: Signum binds as `user@domain`. */
    getRegistryBindName(): string | null {
        return hasText(this.directoryRegistry_Username)
            ? `${this.directoryRegistry_Username}@${this.domainName}`
            : null;
    }
}

function hasText(s: string | null | undefined): boolean {
    return s != null && s.trim() !== "";
}

/** Signum's `[AutoInit] static class WindowsADTask`. */
export namespace WindowsADTask {
    export const DeactivateUsers: SimpleTaskSymbol = init();
}

/** Signum's `[AllowUnauthenticated] enum WindowsADMessage`. */
export const WindowsADMessage = {
    TheUser0IsConnectedToActiveDirectoryAndCanNotHaveALocalPasswordSet:
        msg("The user {0} is connected to Active Directory and can not have a local password set"),
    LoginWithWindowsUser: msg("Login with Windows user"),
    NoWindowsUserFound: msg("No Windows user found"),
    LooksLikeYourWindowsUserIsNotAllowedToUseThisApplication:
        msg("Looks like your Windows user is not allowed to use this application"),
    /** altea addition — see WindowsADServer's `negotiateProvider`. */
    WindowsIntegratedAuthenticationIsNotConfiguredOnThisHost:
        msg("Windows integrated authentication is not configured on this host"),
};
