import * as http from "node:http";
import * as https from "node:https";
import { XMLParser } from "fast-xml-parser";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";

// The transport half of the Exchange Web Services port: one SOAP POST, plus POX Autodiscover.
//
// ══ WHY THIS FILE EXISTS AT ALL ════════════════════════════════════════════════════════════════════════
// Signum uses `Microsoft.Exchange.WebServices.Data` (the EWS Managed API), a .NET-only library with no JS
// counterpart worth taking: the JS ports of it are unmaintained and an order of magnitude larger than the
// three requests this module actually makes. EWS is a plain SOAP 1.1 endpoint, so — exactly as
// altea-auth-azuread turned `Microsoft.Graph` into plain REST — this file speaks it directly:
//
//   CreateItem       — save or send a message
//   CreateAttachment — add one file to a saved draft
//   SendItem         — send the draft
//
// ══ THE ONE THING THAT DOES NOT PORT ═══════════════════════════════════════════════════════════════════
// `service.UseDefaultCredentials = true` means Windows INTEGRATED authentication (SPNEGO / Kerberos or
// NTLM). Node has no SSPI, and the native modules that can do it are Windows-only node-gyp builds — the
// same wall altea-auth-windowsad hit for integrated sign-in. So `negotiateProvider` is a SEAM, null by
// default: with none installed, a service configured `useDefaultCredentials` fails with a clear message
// instead of silently POSTing unauthenticated (which Exchange answers with a 401 and no explanation).
// A host that needs it installs one:
//
//     ExchangeWebServices.negotiateProvider = async url => ({ Authorization: await mySspi.token(url) });
//
// Username + password (Basic over HTTPS, which is what `new WebCredentials(user, pass)` sends against a
// modern Exchange) works with no provider at all.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Other divergences from the Managed API, documented inline:
//  - Autodiscover: the Managed API tries SCP lookup, the two well-known POX URLs, an unauthenticated GET
//    redirect and a DNS SRV record, in that order. Only the two POX URLs (plus the `RedirectUrl` /
//    `RedirectAddr` responses they may return) are ported — they are what works outside a domain-joined
//    machine, and the SRV path needs a DNS resolver this module has no other use for. A deployment the POX
//    URLs cannot reach should configure `url` explicitly, which is the common case anyway.
//  - `RedirectionUrlValidationCallback` is kept verbatim in spirit: a redirect is followed ONLY to https,
//    because the credentials ride the very next request.

/** The credentials half of a service configuration, with the password already DECRYPTED. */
export interface ExchangeCredentials {
    username: string | null;
    /** Decrypted (EmailSenderConfigurationLogic.decryptPassword). */
    password: string | null;
    /** Signum's UseDefaultCredentials — needs a `negotiateProvider` (see the header). */
    useDefaultCredentials: boolean;
}

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    // EWS namespace prefixes (s:/m:/t:) are noise for a reader looking for one element by local name.
    removeNSPrefix: true,
    // An id lives in ATTRIBUTES only, so a text-only element must stay a string — never a parsed number.
    parseTagValue: false,
});

export namespace ExchangeWebServices {

    /** See the header. Null by default: this host cannot do integrated Windows authentication. */
    export let negotiateProvider: ((url: string) => Promise<Record<string, string>>) | null = null;

    /** How long a request may take before it is abandoned (the Managed API's default `Timeout`, 100 s). */
    export let timeoutMilliseconds = 100_000;

    /**
     * POST one EWS SOAP request and return the parsed response. `bodyXml` is the contents of `<soap:Body>`;
     * the envelope, the `RequestServerVersion` header and the authentication are added here.
     */
    export async function call(
        url: string,
        exchangeVersion: string,
        bodyXml: string,
        credentials: ExchangeCredentials,
    ): Promise<ExchangeElement> {
        using _prof = HeavyProfiler.log("ExchangeWS", () => bodyXml.slice(0, 60));

        const envelope = `<?xml version="1.0" encoding="utf-8"?>`
            + `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"`
            + ` xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"`
            + ` xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">`
            + `<soap:Header><t:RequestServerVersion Version="${exchangeVersion}" /></soap:Header>`
            + `<soap:Body>${bodyXml}</soap:Body>`
            + `</soap:Envelope>`;

        const text = await post(url, envelope, "text/xml; charset=utf-8", await authHeaders(url, credentials));
        const root = new ExchangeElement(parser.parse(text));

        // A SOAP fault carries the real reason (a bad version header, a permission problem, …) in the body,
        // with an HTTP 500 — so it must be read out rather than surfaced as "request failed with 500".
        const fault = root.get("Envelope")?.get("Body")?.get("Fault");
        if (fault != undefined)
            throw new Error(`Exchange Web Services returned a SOAP fault: `
                + `${fault.get("faultstring")?.text() ?? fault.get("detail")?.text() ?? "(no detail)"}`);

        const response = root.get("Envelope")?.get("Body");
        if (response == undefined)
            throw new Error(`Exchange Web Services returned no SOAP body: ${text.slice(0, 500)}`);

        assertNoResponseError(response);

        return response;
    }

    /**
     * Signum's `service.AutodiscoverUrl(emailAddress, RedirectionUrlValidationCallback)` — find the EWS
     * endpoint for an address. Tries the two well-known POX URLs (see the header), following at most a few
     * redirects, and returns the `EXCH`/`EXPR` protocol's `EwsUrl`.
     */
    export async function autodiscoverUrl(emailAddress: string, credentials: ExchangeCredentials): Promise<string> {
        using _prof = HeavyProfiler.log("ExchangeWS Autodiscover", () => emailAddress);

        const domain = emailAddress.substring(emailAddress.lastIndexOf("@") + 1);
        if (domain === "")
            throw new Error(`Cannot autodiscover an Exchange URL from '${emailAddress}': it has no domain part`);

        const attempted: string[] = [];
        let address = emailAddress;

        // Each hop is a full pair of well-known URLs; `RedirectAddr` restarts with a new address, `RedirectUrl`
        // targets one specific URL. Bounded, because a misconfigured deployment can loop.
        for (let hop = 0; hop < 5; hop++) {
            const hopDomain = address.substring(address.lastIndexOf("@") + 1);
            const candidates = [
                `https://autodiscover.${hopDomain}/autodiscover/autodiscover.xml`,
                `https://${hopDomain}/autodiscover/autodiscover.xml`,
            ];

            for (const candidate of candidates) {
                attempted.push(candidate);

                let result: AutodiscoverResult | undefined;
                try {
                    result = await tryAutodiscover(candidate, address, credentials);
                } catch {
                    continue; // this URL is not an Autodiscover endpoint; try the next one
                }

                if (result?.ewsUrl != undefined)
                    return result.ewsUrl;

                if (result?.redirectAddr != undefined) {
                    address = result.redirectAddr;
                    break; // restart the well-known pair for the new address
                }

                if (result?.redirectUrl != undefined) {
                    // Signum's RedirectionUrlValidationCallback: the credentials ride the next request, so a
                    // redirect to plain http is refused rather than followed.
                    if (!result.redirectUrl.toLowerCase().startsWith("https:"))
                        throw new Error(`Autodiscover redirected to a non-https URL ('${result.redirectUrl}');`
                            + " refusing to send credentials over it.");

                    attempted.push(result.redirectUrl);
                    const redirected = await tryAutodiscover(result.redirectUrl, address, credentials);
                    if (redirected?.ewsUrl != undefined)
                        return redirected.ewsUrl;
                }
            }
        }

        throw new Error(`Autodiscover could not find an Exchange Web Services URL for '${emailAddress}'.`
            + ` Tried: ${attempted.join(", ")}. Set ExchangeWebServiceEmailServiceEntity.url explicitly.`);
    }

    interface AutodiscoverResult {
        ewsUrl?: string;
        redirectUrl?: string;
        redirectAddr?: string;
    }

    async function tryAutodiscover(url: string, emailAddress: string, credentials: ExchangeCredentials): Promise<AutodiscoverResult | undefined> {
        const request = `<?xml version="1.0" encoding="utf-8"?>`
            + `<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">`
            + `<Request>`
            + `<EMailAddress>${escapeXml(emailAddress)}</EMailAddress>`
            + `<AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>`
            + `</Request></Autodiscover>`;

        const text = await post(url, request, "text/xml; charset=utf-8", await authHeaders(url, credentials));
        const account = new ExchangeElement(parser.parse(text)).get("Autodiscover")?.get("Response")?.get("Account");
        if (account == undefined)
            return undefined;

        const redirectUrl = account.get("RedirectUrl")?.text();
        if (redirectUrl != undefined)
            return { redirectUrl };

        const redirectAddr = account.get("RedirectAddr")?.text();
        if (redirectAddr != undefined)
            return { redirectAddr };

        // `Protocol` repeats: EXCH (internal) / EXPR (external) / WEB. The first one carrying an EwsUrl wins,
        // which is what the Managed API settles on for a client that is going to speak EWS.
        for (const protocol of account.all("Protocol")) {
            const ewsUrl = protocol.get("EwsUrl")?.text();
            if (ewsUrl != undefined)
                return { ewsUrl };
        }

        return undefined;
    }

    async function authHeaders(url: string, credentials: ExchangeCredentials): Promise<Record<string, string>> {
        if (credentials.username)
            return {
                Authorization: "Basic " + Buffer.from(`${credentials.username}:${credentials.password ?? ""}`).toString("base64"),
            };

        if (credentials.useDefaultCredentials) {
            if (negotiateProvider == null)
                throw new Error("ExchangeWebServiceEmailServiceEntity.useDefaultCredentials is set, but this host"
                    + " cannot do Windows integrated authentication: Node has no SSPI. Either set a username +"
                    + " password on the service, or install ExchangeWebServices.negotiateProvider (see"
                    + " server/ExchangeWebServices.ts).");
            return await negotiateProvider(url);
        }

        return {};
    }

    function post(url: string, body: string, contentType: string, headers: Record<string, string>): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const target = new URL(url);
            const transport = target.protocol === "http:" ? http : https;

            const req = transport.request(target, {
                method: "POST",
                headers: {
                    "Content-Type": contentType,
                    "Content-Length": String(Buffer.byteLength(body)),
                    ...headers,
                },
                timeout: timeoutMilliseconds,
            }, res => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    const status = res.statusCode ?? 0;
                    // 500 carries a SOAP fault, which the caller reads for the real reason — so let it
                    // through and reject on anything else.
                    if (status === 500 || (status >= 200 && status < 300)) {
                        resolve(text);
                        return;
                    }
                    reject(new Error(`POST ${url} failed with ${status}: ${text.slice(0, 500)}`));
                });
            });

            req.on("timeout", () => req.destroy(new Error(`POST ${url} timed out after ${timeoutMilliseconds} ms`)));
            req.on("error", reject);
            req.write(body);
            req.end();
        });
    }

    /** EWS reports per-item failures INSIDE a 200 response, as `ResponseClass="Error"` + a MessageText. */
    function assertNoResponseError(body: ExchangeElement): void {
        const errors = body.descendantsWithAttribute("ResponseClass", "Error");
        if (errors.length === 0)
            return;

        const first = errors[0]!;
        const code = first.get("ResponseCode")?.text();
        const text = first.get("MessageText")?.text();
        throw new Error(`Exchange Web Services returned an error: ${code ?? "(no code)"}${text ? " — " + text : ""}`);
    }
}

/**
 * A thin read-only wrapper over what `fast-xml-parser` produced. EWS responses are read at three or four
 * known paths, and a parsed-object walk with `?.[0]?.["x"]` at every step is unreadable; this gives the
 * handful of accessors those paths need (and normalises "one child" vs "many children", which the parser
 * represents differently).
 */
export class ExchangeElement {
    constructor(private readonly node: unknown) { }

    /** The first child element with this LOCAL name (namespace prefixes are stripped on parse). */
    get(name: string): ExchangeElement | undefined {
        const value = (this.node as Record<string, unknown> | null)?.[name];
        if (value == undefined)
            return undefined;
        return new ExchangeElement(Array.isArray(value) ? value[0] : value);
    }

    /** Every child element with this local name. */
    all(name: string): ExchangeElement[] {
        const value = (this.node as Record<string, unknown> | null)?.[name];
        if (value == undefined)
            return [];
        return (Array.isArray(value) ? value : [value]).map(v => new ExchangeElement(v));
    }

    attribute(name: string): string | undefined {
        const value = (this.node as Record<string, unknown> | null)?.["@" + name];
        return value == undefined ? undefined : String(value);
    }

    /** The element's text, for a text-only element (the parser gives a bare string, or `#text`). */
    text(): string | undefined {
        if (typeof this.node === "string")
            return this.node;
        const value = (this.node as Record<string, unknown> | null)?.["#text"];
        return value == undefined ? undefined : String(value);
    }

    /** Every element ANYWHERE below this one that has an attribute with the given value. */
    descendantsWithAttribute(attributeName: string, attributeValue: string): ExchangeElement[] {
        const found: ExchangeElement[] = [];
        walk(this.node, node => {
            if ((node as Record<string, unknown>)["@" + attributeName] === attributeValue)
                found.push(new ExchangeElement(node));
        });
        return found;
    }

}

function walk(node: unknown, visit: (node: object) => void): void {
    if (node == null || typeof node !== "object")
        return;

    if (Array.isArray(node)) {
        for (const item of node)
            walk(item, visit);
        return;
    }

    visit(node);
    for (const value of Object.values(node))
        walk(value, visit);
}

/** XML text escaping — the five predefined entities. */
export function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
