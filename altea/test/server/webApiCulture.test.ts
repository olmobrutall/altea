import { test, describe, beforeAll, afterEach } from "vitest";
import assert from "node:assert/strict";
import type { Request } from "express";
import { requestCulture, setUserCultureProvider, CULTURE_COOKIE } from "@altea/altea/server/webApi";
import { loadSignumTranslations } from "@altea/altea/server/translations";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";

// The culture a request runs in — Signum's CultureServer.GetCurrentCulture, whose ORDER is the point:
// the cookie the picker just set beats the user's stored preference, which beats what the browser asked
// for. Getting that order wrong is invisible until someone switches language and the server disagrees.

/** Just enough of an Express Request for the resolver — it reads only `headers`. */
function req(headers: Record<string, string>): Request {
    return { headers } as unknown as Request;
}

const xml = (name: string) => `<?xml version="1.0" encoding="utf-8"?>
<Translations>
  <Type Name="AlbumEntity" Description="${name}" />
</Translations>`;

describe("requestCulture", () => {

    beforeAll(() => {
        // A culture counts only if something is translated into it, so give three of them content.
        loadSignumTranslations("es", xml("Disco"));
        loadSignumTranslations("de", xml("Album"));
        loadSignumTranslations("pt-BR", xml("Disco"));
    });

    afterEach(() => setUserCultureProvider(undefined));

    test("nothing to go on falls back to the process default", () => {
        assert.equal(requestCulture(req({})), CultureInfo.currentUICulture());
    });

    test("the browser's preferred language is honoured", () => {
        assert.equal(requestCulture(req({ "accept-language": "de" })), "de");
    });

    test("a weighted Accept-Language list is read in order, skipping what is not translated", () => {
        // `fr` has no translations, so it is passed over rather than serving a half-English page.
        assert.equal(requestCulture(req({ "accept-language": "fr;q=0.9,es;q=0.8,de;q=0.7" })), "es");
    });

    test("a regional tag falls back to its neutral parent", () => {
        // Signum's GetCultureFromAcceptedLanguage walks to the neutral part; `es-ES` is not loaded, `es` is.
        assert.equal(requestCulture(req({ "accept-language": "es-ES" })), "es");
    });

    test("a regional tag that IS loaded wins over its parent", () => {
        assert.equal(requestCulture(req({ "accept-language": "pt-BR" })), "pt-BR");
    });

    test("the user's own culture beats the browser's", () => {
        setUserCultureProvider(() => "de");
        assert.equal(requestCulture(req({ "accept-language": "es" })), "de");
    });

    test("the cookie beats the user's culture — it is the picker's temporary override", () => {
        setUserCultureProvider(() => "de");
        assert.equal(requestCulture(req({ [`cookie`]: `${CULTURE_COOKIE}=es`, "accept-language": "de" })), "es");
    });

    test("the cookie is found among others, and url-decoded", () => {
        assert.equal(requestCulture(req({ cookie: `authToken=abc; ${CULTURE_COOKIE}=pt-BR; other=1` })), "pt-BR");
    });

    test("a cookie naming an untranslated culture is skipped, not obeyed", () => {
        setUserCultureProvider(() => "de");
        // Falls through to the next step rather than rendering a language nothing is translated into.
        assert.equal(requestCulture(req({ cookie: `${CULTURE_COOKIE}=fr` })), "de");
    });

    test("a request object with no headers at all is tolerated", () => {
        // The route unit tests invoke handlers directly, without Express.
        assert.equal(requestCulture({} as unknown as Request), CultureInfo.currentUICulture());
    });
});
