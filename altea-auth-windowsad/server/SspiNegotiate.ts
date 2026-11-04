import type { NegotiateProvider } from "./WindowsADServer";
import { negotiateToken } from "./WindowsADServer";

// A `WindowsADServer.negotiateProvider` for a WINDOWS host, for DEVELOPMENT: Windows itself checks the browser's
// token (SSPI, through the `node-expose-sspi` package), as it does for the Signum application under Kestrel or IIS.
//
// Why it needs nothing from the domain's AD team: the workstation is a domain member. A browser on it that opens
// `http://localhost:…` gets no Kerberos ticket (there is no SPN for localhost) and answers with NTLM, which Windows
// checks against a domain controller over the machine's own secure channel. No SPN, no keytab.
//
// What it does NOT prove: the production path. The Linux host checks a Kerberos ticket with a keytab
// (KerberosNegotiate); only a host with the AD team's SPN and keytab tests that.
//
// NTLM takes two round trips (NEGOTIATE → CHALLENGE → AUTHENTICATE), and Windows keeps the half-done context
// between them. It is kept per CONNECTION, as NTLM requires — so a proxy in front of the API (vite's dev proxy)
// must send both requests of one handshake over the same upstream connection; see the seminarmanagement vite config.
//
// `node-expose-sspi` is an OPTIONAL, Windows-only dependency (its package declares `os: win32`, so a Linux install,
// the container image included, never gets it), loaded on first use.

/** The part of `node-expose-sspi`'s `sspi` this provider uses. */
export interface SspiLike {
    AcquireCredentialsHandle(input: { packageName: string; credentialUse?: string }): { credential: unknown; tsExpiry: Date };
    FreeCredentialsHandle(credential: unknown): void;
    AcceptSecurityContext(input: {
        credential: unknown;
        SecBufferDesc: { ulVersion: number; buffers: ArrayBuffer[] };
        contextHandle?: unknown;
    }): { SECURITY_STATUS: string; contextHandle: unknown; SecBufferDesc: { buffers: ArrayBuffer[] } };
    QueryContextAttributes(contextHandle: unknown, attribute: string): { sUserName?: string };
    LookupAccountName(userName: string): { sid: string; domain: string };
    DeleteSecurityContext(contextHandle: unknown): void;
}

export interface SspiNegotiateOptions {
    /** Loads `node-expose-sspi`'s `sspi`; replaceable in tests. */
    loadModule?: () => Promise<SspiLike>;
}

interface SocketLike {
    once(event: "close", listener: () => void): unknown;
}

/** The first message of a handshake: an SPNEGO wrapper ("YI…", ASN.1 0x60) or a bare NTLM NEGOTIATE. */
function isFirstMessage(token: string): boolean {
    return token.startsWith("YI") || token.startsWith("TlRMTVNTUAAB");
}

export function sspiNegotiateProvider(options: SspiNegotiateOptions = {}): NegotiateProvider {
    if (process.platform !== "win32")
        throw new Error("The SSPI Negotiate provider runs on Windows only (it is for local development; a Linux host uses KerberosNegotiate).");

    let sspiPromise: Promise<SspiLike> | undefined;
    const load = (): Promise<SspiLike> => sspiPromise ??= (options.loadModule ?? loadSspi)();

    let credential: { credential: unknown; tsExpiry: Date } | undefined;
    const serverCredential = (sspi: SspiLike): unknown => {
        if (credential == null || credential.tsExpiry < new Date()) {
            if (credential != null)
                sspi.FreeCredentialsHandle(credential.credential);
            credential = sspi.AcquireCredentialsHandle({ packageName: "Negotiate", credentialUse: "SECPKG_CRED_INBOUND" });
        }
        return credential.credential;
    };

    // The half-done handshake of each connection; released when the connection closes or completes.
    const pending = new WeakMap<object, unknown>();
    // The connections whose `close` already releases their entry — one listener per connection, however many
    // sign-ins a kept-alive connection carries.
    const watched = new WeakSet<object>();

    const release = (sspi: SspiLike, key: object): void => {
        const handle = pending.get(key);
        if (handle != null) {
            pending.delete(key);
            deleteContext(sspi, handle);
        }
    };

    return async req => {
        const token = negotiateToken(req);
        if (token == null)
            return null;

        const sspi = await load();
        const socket = (req as { socket?: SocketLike & object }).socket;
        const key: object = socket ?? (req as object);

        if (isFirstMessage(token))
            release(sspi, key);

        const previous = pending.get(key);
        // The handshake's state leaves `pending` HERE, whatever happens next: SSPI answers each step with a new
        // handle object for the same context, so the entry is replaced (another round trip) or freed below —
        // never left behind for the connection's close to free a second time.
        pending.delete(key);
        const result = sspi.AcceptSecurityContext({
            credential: serverCredential(sspi),
            SecBufferDesc: { ulVersion: 0, buffers: [toArrayBuffer(Buffer.from(token, "base64"))] },
            ...(previous != null ? { contextHandle: previous } : {}),
        });
        const output = result.SecBufferDesc.buffers[0];
        const outputToken = output != null && output.byteLength > 0 ? Buffer.from(output).toString("base64") : null;

        if (result.SECURITY_STATUS === "SEC_I_CONTINUE_NEEDED") {
            if (outputToken == null) {
                deleteContext(sspi, result.contextHandle);
                throw new Error("SSPI asked for another round trip without a token to send.");
            }
            pending.set(key, result.contextHandle);
            if (socket != null && !watched.has(socket)) {
                watched.add(socket);
                socket.once("close", () => release(sspi, socket));
            }
            return { continueToken: outputToken };
        }

        if (result.SECURITY_STATUS !== "SEC_E_OK") {
            if (previous != null)
                deleteContext(sspi, previous);
            throw new Error(`Windows refused the browser's Negotiate token: ${result.SECURITY_STATUS}`);
        }

        try {
            const userName = sspi.QueryContextAttributes(result.contextHandle, "SECPKG_ATTR_NAMES").sUserName;
            if (!userName)
                return null;
            // `DOMAIN\user`, and its SID — the handshake's identity, so the user is found by SID like under IIS.
            const sid = sspi.LookupAccountName(userName).sid || null;
            return { userName, sid, responseToken: outputToken };
        } finally {
            deleteContext(sspi, result.contextHandle);
        }
    };
}

/**
 * Never throws: it runs from a socket's `close` event too, where an exception would end the process, and a
 * context that cannot be freed is no reason to fail a sign-in.
 */
function deleteContext(sspi: SspiLike, handle: unknown): void {
    try {
        sspi.DeleteSecurityContext(handle);
    } catch (e) {
        console.warn(`[SspiNegotiate] could not free a security context: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function loadSspi(): Promise<SspiLike> {
    // A variable, not a literal: the optional package is resolved at run time only, never by the compiler.
    const name = "node-expose-sspi";
    try {
        const module = await import(name) as { sspi?: SspiLike; default?: { sspi?: SspiLike } };
        const sspi = module.sspi ?? module.default?.sspi;
        if (sspi == null)
            throw new Error("it exports no `sspi`");
        return sspi;
    } catch (e) {
        throw new Error("The 'node-expose-sspi' package is not installed or did not load (it is Windows-only).", { cause: e });
    }
}
