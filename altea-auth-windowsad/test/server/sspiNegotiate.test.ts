import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { sspiNegotiateProvider, type SspiLike } from "../../server/SspiNegotiate";

// The SSPI negotiate provider, with `node-expose-sspi` replaced: the two NTLM round trips, kept per connection,
// and what comes back. The real check needs a domain-joined Windows host, so it is exercised there, not here.

const b64 = (s: string): string => Buffer.from(s).toString("base64");

/**
 * A fake SSPI that behaves like Windows where it matters: every step answers a NEW handle object for the same
 * context, and freeing a context twice fails ("the handle specified is invalid"). A token "complete:*" finishes
 * the handshake at once; any other first token asks for a second round.
 */
function fakeSspi(log: string[] = []): SspiLike {
    let next = 0;
    const live = new Map<number, string>();
    const idOf = (handle: unknown): number => (handle as { id: number }).id;
    return {
        AcquireCredentialsHandle: () => ({ credential: "cred", tsExpiry: new Date(Date.now() + 3_600_000) }),
        FreeCredentialsHandle: () => {},
        AcceptSecurityContext: ({ SecBufferDesc, contextHandle }) => {
            const token = Buffer.from(SecBufferDesc.buffers[0]!).toString();
            log.push(`accept ${token}${contextHandle != null ? ` on ${idOf(contextHandle)}` : ""}`);
            if (token === "bad")
                return { SECURITY_STATUS: "SEC_E_LOGON_DENIED", contextHandle: undefined, SecBufferDesc: { buffers: [] } };
            const id = contextHandle != null ? idOf(contextHandle) : ++next;
            if (contextHandle == null && !token.startsWith("complete:")) {
                live.set(id, token);
                return { SECURITY_STATUS: "SEC_I_CONTINUE_NEEDED", contextHandle: { id }, SecBufferDesc: { buffers: [new TextEncoder().encode("challenge").buffer as ArrayBuffer] } };
            }
            live.set(id, token.replace("complete:", ""));
            return { SECURITY_STATUS: "SEC_E_OK", contextHandle: { id }, SecBufferDesc: { buffers: [] } };
        },
        QueryContextAttributes: handle => ({ sUserName: `EXAMPLE\\${live.get(idOf(handle))}` }),
        LookupAccountName: () => ({ sid: "S-1-5-21-1-2-3-1001", domain: "EXAMPLE" }),
        DeleteSecurityContext: handle => {
            if (!live.delete(idOf(handle)))
                throw new Error("Cannot DeleteSecurityContext: The handle specified is invalid");
            log.push(`delete ${idOf(handle)}`);
        },
    };
}

/** A request on `socket` with `Authorization: Negotiate <token>`; tokens of a first message start "YI" (SPNEGO). */
const request = (socket: object, token?: string): unknown =>
    ({ socket, headers: token == null ? {} : { authorization: `Negotiate ${token}` } });

const newSocket = (): EventEmitter => new EventEmitter();

describe.skipIf(process.platform !== "win32")("sspiNegotiateProvider", () => {
    test("two round trips on one connection: a challenge, then the account and its SID", async () => {
        const log: string[] = [];
        const provider = sspiNegotiateProvider({ loadModule: async () => fakeSspi(log) });
        const socket = newSocket();
        const firstToken = "YI" + b64("x").slice(2);

        const first = await provider(request(socket, firstToken));
        assert.deepEqual(first, { continueToken: b64("challenge") });

        const second = await provider(request(socket, b64("jdoe")));
        assert.deepEqual(second, { userName: "EXAMPLE\\jdoe", sid: "S-1-5-21-1-2-3-1001", responseToken: null });
        assert.equal(log.filter(l => l.startsWith("delete")).length, 1, "the context is freed once it completes");
    });

    test("the second message on ANOTHER connection has no context to continue", async () => {
        const provider = sspiNegotiateProvider({ loadModule: async () => fakeSspi() });
        await provider(request(newSocket(), "YI" + b64("x").slice(2)));

        // The fake treats a context-less token as a new handshake: it answers another challenge, not an account.
        const other = await provider(request(newSocket(), b64("jdoe")));
        assert.ok(other != null && "continueToken" in other);
    });

    test("a completed handshake is freed once: the connection's close does not free it again", async () => {
        const log: string[] = [];
        const provider = sspiNegotiateProvider({ loadModule: async () => fakeSspi(log) });
        const socket = newSocket();
        await provider(request(socket, "YI" + b64("x").slice(2)));
        await provider(request(socket, b64("jdoe")));
        socket.emit("close"); // used to free the stale entry a second time, and throw out of the event
        assert.deepEqual(log.filter(l => l.startsWith("delete")), ["delete 1"]);
    });

    test("a closed connection frees its half-done context", async () => {
        const log: string[] = [];
        const provider = sspiNegotiateProvider({ loadModule: async () => fakeSspi(log) });
        const socket = newSocket();
        await provider(request(socket, "YI" + b64("x").slice(2)));
        socket.emit("close");
        assert.deepEqual(log.filter(l => l.startsWith("delete")), ["delete 1"]);
    });

    test("a token that completes at once (a Kerberos ticket) needs no second round", async () => {
        const provider = sspiNegotiateProvider({ loadModule: async () => fakeSspi() });
        const identity = await provider(request(newSocket(), b64("complete:jdoe")));
        assert.deepEqual(identity, { userName: "EXAMPLE\\jdoe", sid: "S-1-5-21-1-2-3-1001", responseToken: null });
    });

    test("no token: no identity, and the module is not even loaded", async () => {
        let loaded = false;
        const provider = sspiNegotiateProvider({ loadModule: async () => { loaded = true; throw new Error("must not load"); } });
        assert.equal(await provider(request(newSocket())), null);
        assert.equal(loaded, false);
    });

    test("a refused token is an error naming Windows' status", async () => {
        const provider = sspiNegotiateProvider({ loadModule: async () => fakeSspi() });
        await assert.rejects(provider(request(newSocket(), b64("bad"))), /SEC_E_LOGON_DENIED/);
    });
});
