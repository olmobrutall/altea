import type { Request } from "express";
import { CultureInfo } from "../../data/utils/cultureInfo";
import { Metadata } from "../../data/metadata";
import type { RequestFilter } from "./requestFilter";

// Which language a request runs in — Signum's `SignumCultureSelectorFilter` plus the
// `CultureServer.GetCurrentCulture` chain it delegates to.
//
// Without it every server-produced string — a registered expression's niceName, a validation message, an
// exception message — resolves in the PROCESS default culture no matter who asked.

/**
 * The logged-in user's own culture preference, when an auth module is installed to answer. Core has no
 * notion of a user, so this is a seam — Signum reads `UserHolder.CurrentUserCulture` directly, which it
 * can because its framework assembly knows about users.
 */
let _userCulture: (() => string | undefined) | undefined;
export function setUserCultureProvider(fn: (() => string | undefined) | undefined): void { _userCulture = fn; }

/** The name of the culture cookie. Signum's is `language`, and this is the same wire contract. */
export const CULTURE_COOKIE = "language";

/** One cookie out of the `Cookie` header, without pulling in cookie-parser for a single name. */
function readCookie(req: Request, name: string): string | undefined {
    const header = req.headers?.["cookie"];
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw == null)
        return undefined;
    for (const part of raw.split(";")) {
        const eq = part.indexOf("=");
        if (eq >= 0 && part.slice(0, eq).trim() === name)
            return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
}

/** A culture, if translations are actually loaded for it — else its neutral parent (`es-ES` → `es`). */
function usable(tag: string | undefined): string | undefined {
    if (tag == null || tag === "")
        return undefined;
    const loaded = Metadata.cultures();
    if (loaded.includes(tag))
        return tag;
    // Signum's GetCultureFromAcceptedLanguage walks to the neutral part and then prefix-matches, so
    // `es-ES` finds a loaded `es` rather than falling all the way back to English.
    const neutral = tag.split("-")[0]!;
    return loaded.includes(neutral) ? neutral : loaded.find(c => c.startsWith(neutral));
}

/**
 * The culture a request runs in — Signum's `CultureServer.GetCurrentCulture`, same order:
 *
 *   1. the `language` COOKIE — what the picker just set, a temporary override that beats the stored
 *      preference precisely so switching language does not rewrite the user's profile;
 *   2. the logged-in USER's own culture;
 *   3. the browser's preferred languages (`Accept-Language`, a weighted list — each tag in order, then
 *      its neutral parent);
 *   4. the process default, which is the untranslated source language.
 *
 * Every candidate is filtered through {@link usable}: a culture nothing is translated into is not a
 * culture this application can render, so it is skipped rather than serving a half-English page.
 */
export function requestCulture(req: Request): string {
    const fromCookie = usable(readCookie(req, CULTURE_COOKIE));
    if (fromCookie != undefined)
        return fromCookie;

    const fromUser = usable(_userCulture?.());
    if (fromUser != undefined)
        return fromUser;

    // `headers` is optional-chained: a hand-built request object (the route unit tests invoke handlers
    // directly, without Express) has none, and a missing header is exactly the default-culture case.
    const header = req.headers?.["accept-language"];
    const raw = Array.isArray(header) ? header[0] : header;
    for (const entry of raw?.split(",") ?? []) {
        // Drop the quality factor; the header is already in preference order.
        const fromHeader = usable(entry.split(";")[0]!.trim());
        if (fromHeader != undefined)
            return fromHeader;
    }

    return CultureInfo.currentUICulture();
}

/**
 * Scope the request to its culture.
 *
 * BOTH cultures are scoped (`withCultures`), not just the UI one: server-side formatting should follow
 * the caller as well, and a per-culture cache that keys on `currentCulture()` would otherwise key on a
 * constant and serve whichever language warmed it first to everyone.
 *
 * Registered AFTER the user filter, because step 2 of the chain reads the current user — the same reason
 * Signum lists `SignumAuthenticationFilter` before `SignumCultureSelectorFilter`.
 */
export const cultureFilter: RequestFilter = (ctx, next) =>
    CultureInfo.withCultures(requestCulture(ctx.req), next);
