import { ajaxGet } from './Services';
import { CultureInfo } from '../data/utils/cultureInfo';

// Port of Signum's CultureClient (React/Basics/CultureClient.ts) — which culture the UI is rendered in.
//
// ALTEA DIVERGENCE: Signum persists a `CultureInfoEntity` table, serves it from `/api/culture/cultures`,
// and stores the user's choice SERVER-side (a cookie the ASP.NET request-localization middleware reads),
// so `setCurrentCulture` is a POST. altea has neither the table nor per-request localization:
//
//   - the CATALOGUE is whatever has translations loaded (`GET /api/reflection/cultures`) — a culture
//     nothing translated is not a culture worth offering;
//   - the CHOICE lives in the BROWSER (localStorage), not in a per-user server row. The client applies it
//     by booting with it — the metadata blob is the per-culture payload — and sends it on every request
//     (`Accept-Language`, see client/Services) so the server resolves ITS labels in the same language.
//   - the display name comes from `Intl.DisplayNames`, not a stored `nativeName` column.
export namespace CultureClient {

    // Where the choice is remembered. localStorage (not sessionStorage): a language preference should
    // outlive the tab, unlike the auth token that SessionSharing hands between tabs.
    const storageKey = "altea.culture";

    /** Shared with the server (webApi's CULTURE_COOKIE) and with Signum, which names it the same. */
    const cultureCookie = "language";

    export interface CultureCatalogue {
        cultures: string[];
        /** The untranslated SOURCE language — what an unlisted / unloaded culture falls back to. */
        defaultCulture: string;
    }

    /** The culture the UI is currently rendered in (the culture of the applied metadata blob). */
    export function getCurrentCulture(): string {
        return CultureInfo.currentUICulture();
    }

    /**
     * The culture to boot with: the remembered choice, else undefined (the server then answers with its own
     * default). Read BEFORE the first `loadReflectionMetadata` so the first paint is already translated —
     * loading twice would flash English.
     */
    export function savedCulture(): string | undefined {
        // The URL parameter wins (it is the reload changeCurrentCulture just triggered) and is then dropped
        // from the address bar, so a shared link does not pin someone else's language.
        const url = new URL(window.location.href);
        const fromUrl = url.searchParams.get(cultureParam) ?? undefined;
        if (fromUrl != null) {
            url.searchParams.delete(cultureParam);
            window.history.replaceState(null, "", url.toString());
            // Mirrored too: this branch is the fallback for a browser that refused localStorage, and the
            // server reads neither the URL nor localStorage.
            return mirrorToCookie(fromUrl);
        }
        // localStorage is the primary store; the cookie is the one that survives a browser which refused
        // it, and it is what the SERVER reads — so an explicit choice is found either way. With NEITHER
        // set (a first visit) this answers undefined on purpose: the client then asks for no particular
        // culture and the server picks from the browser's own preferred languages.
        try {
            const saved = localStorage.getItem(storageKey);
            if (saved != null && saved !== "")
                return mirrorToCookie(saved);
        } catch { /* private mode */ }
        return readCultureCookie();
    }

    /**
     * Write a remembered choice back to the cookie, because that is the only one of the two the server can
     * see: the boot metadata fetch carries no `Accept-Language`, and `?culture=` is a cache buster the
     * server ignores. Without this a browser that chose a language BEFORE the cookie existed — or one
     * whose cookie was cleared while localStorage survived — would render the remembered language while
     * every server-produced string came back in the default one.
     */
    function mirrorToCookie(culture: string): string {
        if (readCultureCookie() !== culture)
            writeCultureCookie(culture);
        return culture;
    }

    /**
     * The cookie the SERVER reads to decide what language a request runs in (webApi's `requestCulture`,
     * Signum's `language` cookie — same name, same contract).
     *
     * localStorage is what the client boots from, but the server cannot see it, and the metadata fetch
     * carries no `Accept-Language` — so without this the server would answer every request in the process
     * default while the UI rendered in the chosen language. Signum writes this cookie server-side from
     * `setCurrentCulture`; altea has no such endpoint because the choice is client-owned, so the client
     * writes it. Not HttpOnly on purpose: it is a display preference, and boot reads it back.
     *
     * `SameSite=Lax` so it still rides an ordinary top-level navigation, and a long max-age because a
     * language preference should outlive the session (Signum uses ten years).
     */
    function writeCultureCookie(culture: string): void {
        try {
            const tenYears = 10 * 365 * 24 * 60 * 60;
            document.cookie = `${cultureCookie}=${encodeURIComponent(culture)}; path=/; max-age=${tenYears}; SameSite=Lax`;
        } catch { /* no document (SSR / tests) — the server then falls back down its own chain */ }
    }

    /** That cookie's current value, if any. */
    function readCultureCookie(): string | undefined {
        try {
            for (const part of document.cookie.split(";")) {
                const eq = part.indexOf("=");
                if (eq >= 0 && part.slice(0, eq).trim() === cultureCookie)
                    return decodeURIComponent(part.slice(eq + 1).trim());
            }
        } catch { /* no document */ }
        return undefined;
    }

    let cached: Promise<CultureCatalogue> | undefined;

    export function getCultures(): Promise<CultureCatalogue> {
        return cached ??= ajaxGet<CultureCatalogue>({ url: "/api/reflection/cultures", cache: "no-cache" });
    }

    /** Fired after a culture change has been applied (the analogue of Signum's onCultureChanged). */
    export const onCultureChanged: ((culture: string) => void)[] = [];

    /**
     * Switch the UI culture: remember the choice and RELOAD the page.
     *
     * Signum re-fetches its types and calls `resetUI()`, because every label it renders is resolved on the
     * client from the reloaded TypeInfo. altea cannot stop there: some labels are resolved SERVER-side and
     * arrive baked into a response — a registered expression's niceName rides on the query result's column
     * (an extension token's `niceName` thunk only exists on the server), and validation / exception
     * messages are rendered into their payloads. A soft reset re-renders those from data fetched in the
     * PREVIOUS language, so a search control would sit there with one stale German column header among the
     * Spanish ones. Reloading re-fetches everything in one go, which is also what a user expects of a
     * language switch. A no-op when it is already the current culture.
     */
    export function changeCurrentCulture(culture: string): void {
        if (culture === getCurrentCulture())
            return;
        try { localStorage.setItem(storageKey, culture); } catch { /* private mode — no memory, but see below */ }
        writeCultureCookie(culture);
        onCultureChanged.forEach(f => f(culture));
        // Carry the choice in the URL as well, so a browser that refused localStorage still lands in the
        // chosen language (boot reads the parameter, then drops it).
        const url = new URL(window.location.href);
        url.searchParams.set(cultureParam, culture);
        window.location.replace(url.toString());
    }

    /** The query parameter the reload carries the choice in when localStorage is unavailable. */
    const cultureParam = "culture";

    /**
     * The language's own name for itself ("español", "Deutsch") — Signum read this from
     * `CultureInfoEntity.nativeName`. `Intl.DisplayNames` in the target locale gives the same thing without
     * a table. Falls back to the raw tag if the runtime has no data for it.
     */
    export function nativeName(culture: string): string {
        try {
            const language = culture.split("-")[0];
            const name = new Intl.DisplayNames([culture], { type: "language" }).of(language);
            return name == null ? culture : name.charAt(0).toLocaleUpperCase(culture) + name.slice(1);
        } catch {
            return culture;
        }
    }
}
