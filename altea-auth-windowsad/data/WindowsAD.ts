import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { part, backReference, implementedBy, format } from "@altea/altea/data/decorators";
import { noRepeatValidator, stringLengthValidator, validate, ValidationMessage } from "@altea/altea/data/validators";
import type { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { msg } from "@altea/altea/data/utils/localization";
import { BaseADConfigurationEmbedded, RoleMappingEntity } from "@altea/altea-auth/data/BaseAD";
import { SimpleTaskSymbol } from "@altea/altea-scheduler/data/Scheduler";

// How to reach an on-premises Active Directory domain.
//
// `loginWithWindowsAuthenticator` (integrated Kerberos/NTLM SSO) is KEPT as a setting, but a Node host can
// only honour it by supplying a Negotiate provider — see WindowsADServer's `negotiateProvider`. Nothing
// about the entity changes; the capability does.
//
// Port of Signum.Authorization.WindowsAD's WindowsADConfigurationEmbedded.cs — see
// port/AuthDirectory.md.

@reflect
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
    @validate<WindowsADConfigurationEmbedded>(c =>
        (c.loginWithWindowsAuthenticator || c.loginWithActiveDirectoryRegistry) && !hasText(c.domainName)
            ? ValidationMessage._0IsNotSet.niceToString("Domain Name")
            : null)
    @stringLengthValidator({ max: 200 })
    domainName: string | null = null;

    /** The service account used for directory LOOKUPS (searching users, reading groups and photos) when the
     *  host process itself is not a domain member. */
    directoryRegistry_Username: string | null = null;

    @format("Password")
    directoryRegistry_Password: string | null = null;

    /**
     * The LDAP URL to connect to — NEW here, because `PrincipalContext(ContextType.Domain, name)`
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

    /** The bind name for the lookup account: `user@domain`. */
    getRegistryBindName(): string | null {
        return hasText(this.directoryRegistry_Username)
            ? `${this.directoryRegistry_Username}@${this.domainName}`
            : null;
    }
    /** This configuration's own @part rows (the row type
     *  is per module, see BaseAD's header). */
    @noRepeatValidator<WindowsADRoleMappingEntity>(a => a.adNameOrGuid)
    roleMapping: WindowsADRoleMappingEntity[];

    override roleMappings(): RoleMappingEntity[] { return this.roleMapping; }

}

// This configuration's own role-mapping rows (see BaseAD's RoleMappingEntity).
@part
export class WindowsADRoleMappingEntity extends RoleMappingEntity {
    // The rows belong to the ENTITY holding this configuration — the application's settings row, which a
    // framework package must not name. The app widens this in its EntityOverrides (see BaseAD's header);
    // SchemaBuilder verifies it resolves to exactly one owner.
    @backReference @implementedBy(() => []) configuration: Lite<Entity>;
}

function hasText(s: string | null | undefined): boolean {
    return s != null && s.trim() !== "";
}

/** The module's scheduled tasks. */
export namespace WindowsADTask {
    export const DeactivateUsers: SimpleTaskSymbol = init();
}

/** Readable by an ANONYMOUS caller: these strings appear on the login screen. */
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

setDefaultDatabaseSchema("auth");
