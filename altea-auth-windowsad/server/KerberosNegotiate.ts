import { negotiateToken, type NegotiatedIdentity } from "./WindowsADServer";

// A `WindowsADServer.negotiateProvider` for a LINUX host: it accepts the browser's Kerberos ticket itself, with
// the `kerberos` package (GSSAPI) and the service's KEYTAB — what IIS does for the Signum application.
//
// What the host needs (none of it is code):
//   - an SPN `HTTP/<the host name users open>` registered on a service account in the domain;
//   - that account's keytab, mounted as a secret, its path in `KRB5_KTNAME` (the standard GSSAPI variable);
//   - a krb5.conf naming the realm and its KDCs (`/etc/krb5.conf`, or `KRB5_CONFIG`);
//   - the site in the browsers' intranet zone / Negotiate allow-list, or they never send the ticket.
//
// It does not run on a Windows workstation: the package's server side is GSSAPI, and a workstation has no
// keytab for the production SPN anyway.
//
// `kerberos` is an OPTIONAL dependency, loaded on first use, so an install without the Kerberos libraries
// (any host that never configures this provider) is unaffected.

/** The part of the `kerberos` package this provider uses. */
export interface KerberosServerLike {
    step(challenge: string): Promise<string>;
    readonly username: string | undefined;
    readonly response: string | undefined;
    readonly contextComplete: boolean;
}
export interface KerberosModuleLike {
    initializeServer(service: string): Promise<KerberosServerLike>;
}

export interface KerberosNegotiateOptions {
    /** The GSSAPI service name, `HTTP@<host name>` — the SPN `HTTP/<host name>` in GSSAPI's spelling. */
    service: string;
    /** Loads the `kerberos` module; replaceable in tests. */
    loadModule?: () => Promise<KerberosModuleLike>;
}

/** NTLM, not Kerberos: what a browser sends when it could not get a ticket for the SPN. */
const ntlmPrefix = "TlRMTVNTUA";

export function kerberosNegotiateProvider(options: KerberosNegotiateOptions): (req: unknown) => Promise<NegotiatedIdentity | null> {
    let modulePromise: Promise<KerberosModuleLike> | undefined;
    const load = (): Promise<KerberosModuleLike> =>
        modulePromise ??= (options.loadModule ?? loadKerberos)();

    return async req => {
        const token = negotiateToken(req);
        if (token == null)
            return null;

        if (token.startsWith(ntlmPrefix))
            throw new Error("The browser answered the Negotiate challenge with NTLM, not Kerberos: it got no ticket for "
                + `'${options.service}'. Check the SPN, the host name the user opened, and the browser's intranet settings.`);

        const kerberos = await load();
        const server = await kerberos.initializeServer(options.service);
        await server.step(token);

        if (!server.contextComplete || !server.username)
            return null;

        // `user@REALM`: no SID — WindowsADServer asks the directory for it only when it has to.
        return { userName: server.username, sid: null, responseToken: server.response || null };
    };
}

async function loadKerberos(): Promise<KerberosModuleLike> {
    // A variable, not a literal: the optional package is resolved at run time only, never by the compiler.
    const name = "kerberos";
    try {
        return await import(name) as KerberosModuleLike;
    } catch (e) {
        throw new Error("The 'kerberos' package is not installed or its native part did not load (it needs the "
            + "Kerberos libraries, e.g. libkrb5 / krb5-libs, on the host).", { cause: e });
    }
}
