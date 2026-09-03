import { Temporal } from "@altea/altea/data/basics";
import { UserTicketLogic } from "./UserTicketLogic";
import type { UserEntity } from "../data/User";

// Port of Signum.Authorization's UserTicket/UserTicketServer.cs — the HTTP half: put the ticket in a
// cookie, and turn a returning browser's cookie back into a login.
//
// altea divergences, documented inline:
//  - ASP.NET's `ActionContext` + `Response.Cookies.Append` become Express's `res.cookie` / `res.clearCookie`
//    (setting cookies is built into Express; READING needs a parser, which is why `readCookie` below picks
//    the header apart rather than pulling in cookie-parser for one cookie).
//  - **the cookie is HttpOnly**, where Signum's is not. Signum leaves it script-readable purely so its
//    client can call `Cookies.get("sfUser")` and skip a pointless `loginFromCookie` request when there is
//    no cookie; the cost is that a 60-day credential is exposed to any XSS on the page. altea pays the one
//    request instead — `AuthClient.loginFromCookie` just calls the endpoint and reads `null` as "not
//    remembered" — which also means the client never needs to REMOVE the cookie, so Signum's
//    `Options.getCookie` / `removeCookie` pair has no counterpart: the server clears it, in the very
//    response that failed. `SameSite=Lax` (it is a navigation credential, never a cross-site one) and
//    `Secure` whenever the request arrived over https, so a dev host on http still works.
//  - **`device` is the User-Agent, not an IP.** Signum stores `RemoteIpAddress` on the way in and
//    `LocalIpAddress` on the way out — the latter is the SERVER's own address, so every ticket Signum
//    issues records the same string, which cannot be what a column called Device is for. A User-Agent is
//    what actually distinguishes the devices a person remembers, and it is what the search page shows.
//    (It is truncated to the column's 200 chars by UserTicketLogic.)
//  - `AuthServer.OnUserPreLogin` / `AddUserSession` are Signum seams altea does not have; the route in
//    AuthServer does what altea does for every other login (set UserHolder, fire `userLogged`).

// Minimal Express request/response shapes, the convention AuthServer establishes in this package
// (altea-auth does not depend on @types/express). These are SUPERTYPES of Express's Request/Response, so
// a route handler's own req/res are assignable — and they say exactly what this module touches: one
// request header, the scheme, and the two cookie writers.
interface TicketReqLike {
    header(name: string): string | undefined;
    /** Express's `req.secure` — true behind a trust-proxy setup with X-Forwarded-Proto https. */
    secure?: boolean;
}
interface CookieOptionsLike {
    httpOnly: boolean;
    sameSite: "lax";
    secure: boolean;
    path: string;
    expires?: Date;
}
interface TicketResLike {
    cookie(name: string, value: string, options: CookieOptionsLike): void;
    clearCookie(name: string, options: CookieOptionsLike): void;
}

export namespace UserTicketServer {
    /** Signum's OnCookieName / CookieName — overridable, so two apps on one host can coexist. */
    export let cookieName = "sfUser";

    /**
     * Signum's `SaveCookie` behind `OnSaveCookie` — replaceable, so a host can decide what "remember me"
     * means (a different store, a shorter interval, or nothing at all).
     */
    export let onSaveCookie: (req: TicketReqLike, res: TicketResLike) => Promise<void> = (req, res) => saveCookie(req, res);

    function cookieOptions(req: TicketReqLike): CookieOptionsLike {
        return {
            httpOnly: true,
            sameSite: "lax",
            // `req.secure` is true behind a trust-proxy setup with X-Forwarded-Proto https; on a plain dev
            // host it is false, and a Secure cookie there would simply never be stored.
            secure: req.secure === true,
            path: "/",
        };
    }

    function expiryDate(): Date {
        // The cookie outlives the ticket by nothing: both use UserTicketLogic.expirationInterval, so a
        // browser stops presenting a ticket at the same moment the server stops accepting it.
        return new Date(Date.now()
            + Temporal.Duration.from(UserTicketLogic.expirationInterval).total({ unit: "millisecond" }));
    }

    /** Signum's SaveCookie — issue a ticket for the CURRENT user and hand it to the browser. */
    export async function saveCookie(req: TicketReqLike, res: TicketResLike): Promise<void> {
        const ticketText = await UserTicketLogic.newTicket(deviceOf(req));
        res.cookie(cookieName, ticketText, { ...cookieOptions(req), expires: expiryDate() });
    }

    /** Signum's RemoveCookie. */
    export function removeCookie(req: TicketReqLike, res: TicketResLike): void {
        res.clearCookie(cookieName, cookieOptions(req));
    }

    /**
     * Signum's LoginFromCookie — the returning-browser path. Answers the user when the cookie held a
     * valid ticket, else null, having cleared the cookie so the next boot does not retry a dead one.
     *
     * The rotated ticket is written back in the SAME response, which is what makes a ticket one-use-ish
     * (see UserTicketLogic's header for what Signum does and does not guarantee there).
     */
    export async function loginFromCookie(req: TicketReqLike, res: TicketResLike): Promise<UserEntity | null> {
        const ticketText = readCookie(req, cookieName);
        if (ticketText == null || ticketText === "")
            return null; // there is no cookie

        try {
            const { user, ticket } = await UserTicketLogic.updateTicket(deviceOf(req), ticketText);
            res.cookie(cookieName, ticket, { ...cookieOptions(req), expires: expiryDate() });
            return user;
        } catch {
            // Signum's bare catch + RemoveCookie: a tampered, expired, revoked or simply unknown ticket
            // is not an error the caller can act on — it just means "not remembered any more".
            removeCookie(req, res);
            return null;
        }
    }

    /** What goes in the `device` column — see the header on why this is the User-Agent. */
    function deviceOf(req: TicketReqLike): string {
        const ua = req.header("user-agent");
        return (ua != null && ua !== "") ? ua : "unknown";
    }

    /**
     * One cookie out of the `Cookie` header. Express parses cookies only with cookie-parser installed, and
     * this module needs exactly one name — so it reads the header rather than adding a dependency (and a
     * middleware every app would have to mount) for it.
     */
    export function readCookie(req: TicketReqLike, name: string): string | null {
        const header = req.header("cookie");
        if (header == null)
            return null;

        for (const part of header.split(";")) {
            const eq = part.indexOf("=");
            if (eq < 0)
                continue;
            if (part.slice(0, eq).trim() === name)
                return decodeURIComponent(part.slice(eq + 1).trim());
        }
        return null;
    }
}
