import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { negotiateToken } from "../../server/WindowsADServer";
import { kerberosNegotiateProvider, type KerberosModuleLike, type KerberosServerLike } from "../../server/KerberosNegotiate";

// The Kerberos negotiate provider, with the `kerberos` module replaced: what reaches GSSAPI and what comes
// back. The real ticket check needs a keytab and a KDC, so it is exercised on the host, not here.

const request = (authorization?: string): unknown => ({ headers: authorization == null ? {} : { authorization } });

function fakeKerberos(result: Partial<KerberosServerLike>, seen: { service?: string; token?: string } = {}): () => Promise<KerberosModuleLike> {
    return async () => ({
        initializeServer: async (service: string) => {
            seen.service = service;
            return {
                step: async (token: string) => { seen.token = token; return result.response ?? ""; },
                username: result.username,
                response: result.response,
                contextComplete: result.contextComplete ?? true,
            };
        },
    });
}

describe("negotiateToken", () => {
    test("reads the token of an Authorization: Negotiate header", () => {
        assert.equal(negotiateToken(request("Negotiate YIIabc==")), "YIIabc==");
        assert.equal(negotiateToken(request("negotiate YIIabc==")), "YIIabc==");
    });

    test("is null without one, or for a bearer token", () => {
        assert.equal(negotiateToken(request()), null);
        assert.equal(negotiateToken(request("Bearer abc")), null);
        assert.equal(negotiateToken(request("Negotiate")), null);
    });
});

describe("kerberosNegotiateProvider", () => {
    test("accepts the ticket with the configured service and returns the account", async () => {
        const seen: { service?: string; token?: string } = {};
        const provider = kerberosNegotiateProvider({
            service: "HTTP@seminare.example.local",
            loadModule: fakeKerberos({ username: "jdoe@EXAMPLE.LOCAL", response: "oRQwEqADCgEA" }, seen),
        });

        const identity = await provider(request("Negotiate YIIticket"));

        assert.deepEqual(identity, { userName: "jdoe@EXAMPLE.LOCAL", sid: null, responseToken: "oRQwEqADCgEA" });
        assert.equal(seen.service, "HTTP@seminare.example.local");
        assert.equal(seen.token, "YIIticket");
    });

    test("no ticket: no identity, and the module is not even loaded", async () => {
        let loaded = false;
        const provider = kerberosNegotiateProvider({
            service: "HTTP@h",
            loadModule: async () => { loaded = true; throw new Error("must not load"); },
        });
        assert.equal(await provider(request()), null);
        assert.equal(loaded, false);
    });

    test("an unfinished context is no identity", async () => {
        const provider = kerberosNegotiateProvider({
            service: "HTTP@h",
            loadModule: fakeKerberos({ username: undefined, contextComplete: false }),
        });
        assert.equal(await provider(request("Negotiate YIIpartial")), null);
    });

    test("an NTLM answer is refused with an explanation", async () => {
        const provider = kerberosNegotiateProvider({ service: "HTTP@h", loadModule: fakeKerberos({}) });
        await assert.rejects(provider(request("Negotiate TlRMTVNTUAABAAAAB4IIog==")), /NTLM, not Kerberos/);
    });
});
