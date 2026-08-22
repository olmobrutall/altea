import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { localizablePackages, importXml, defaultCultureOf, translationFileExists } from "./LocalizedPackage.server";
import { TranslationReplacementLogic } from "./TranslationReplacementLogic.server";

// Port of Signum.Translation's Translators/ — the pluggable machine-translation back ends the sync pages
// offer as suggestions, plus the two decorators around them.
//
// altea divergences:
//  - **`TranslateBatch` is ASYNC.** Signum offers both a sync and an async form and blocks on `.Result`
//    inside the sync one (its own `Task.Run(...).ResultSafe()`); there is no blocking in JS, so there is
//    one async signature and every caller awaits.
//  - the SDKs are gone: Azure's REST call is plain `fetch` (it already was a REST call behind
//    `HttpClient`), and DeepL's `Translator` class becomes its documented `/v2/translate` endpoint plus
//    the two `/v2/languages` lookups — the same three calls the SDK makes.
//  - `ExtendedHttpClient.GetClientWithProxy` has no counterpart: Node's fetch takes no per-request proxy
//    agent without pulling in `undici`, and a deployment sets `HTTPS_PROXY` instead. Dropped, not stubbed.
//  - `AlreadyTranslatedTranslator` reads altea's own per-package translation FILES (the same ones the code
//    pages edit) rather than a set of loaded assemblies.

/** Signum's `ITranslator`. */
export interface ITranslator {
    readonly name: string;
    /** null ⇒ this translator is not configured / cannot serve this pair; else one entry per input. */
    translateBatch(list: string[], from: string, to: string): Promise<(string | null)[] | null>;
}

/** Signum's `ITranslatorWithFeedback` — a translator whose corrections can be remembered. */
export interface ITranslatorWithFeedback extends ITranslator {
    feedback(to: string, wrongTranslation: string, fixedTranslation: string): Promise<void>;
}

/** Signum's EmptyTranslator — suggests nothing (the default when nothing is configured). */
export class EmptyTranslator implements ITranslator {
    readonly name = "Empty";
    async translateBatch(list: string[]): Promise<(string | null)[]> {
        return list.map(() => null);
    }
}

/** Signum's MockTranslator — "In{culture}({text})", for developing the pages without an API key. */
export class MockTranslator implements ITranslator {
    readonly name = "Mock";
    async translateBatch(list: string[], _from: string, to: string): Promise<(string | null)[]> {
        return list.map(text => `In${to}(${text})`);
    }
}

/**
 * Signum's AlreadyTranslatedTranslator — the cheapest and often best suggestion: this exact string has
 * already been translated somewhere else in the application, so reuse it.
 *
 * Reads every package's own translation FILES (see LocalizedPackage), pairing each `from` label with its
 * `to` counterpart; a string with two different translations is skipped rather than guessed at.
 */
export class AlreadyTranslatedTranslator implements ITranslator {
    readonly name = "Already";

    async translateBatch(list: string[], from: string, to: string): Promise<(string | null)[]> {
        const pairs = new Map<string, Set<string>>();

        for (const packageName of localizablePackages()) {
            // Only packages whose SOURCE language is `from` (Signum's DefaultAssemblyCulture check) — a
            // package written in another language has no `from` labels to pair.
            if (defaultCultureOf(packageName) !== from && !translationFileExists(packageName, from))
                continue;

            const locFrom = importXml(packageName, from);
            const locTo = importXml(packageName, to);

            for (const [typeName, ft] of locFrom.types) {
                const tt = locTo.types.get(typeName);
                if (tt == undefined) continue;

                addPair(pairs, ft.description, tt.description);
                addPair(pairs, ft.pluralDescription, tt.pluralDescription);
                for (const [member, fromText] of ft.members)
                    addPair(pairs, fromText, tt.members.get(member));
            }
        }

        return list.map(s => {
            const candidates = pairs.get(s);
            return candidates != undefined && candidates.size === 1 ? [...candidates][0] : null;
        });
    }
}

function addPair(pairs: Map<string, Set<string>>, from: string | undefined, to: string | undefined): void {
    if (from == undefined || from === "" || to == undefined || to === "")
        return;
    (pairs.get(from) ?? pairs.set(from, new Set()).get(from)!).add(to);
}

/**
 * Signum's ReplacerTranslator — wraps another translator and applies the stored house-style corrections
 * (see TranslationReplacementEntity), preserving the casing of what it replaces.
 */
export class ReplacerTranslator implements ITranslatorWithFeedback {
    constructor(private readonly inner: ITranslator) { }

    get name(): string { return this.inner.name + " (with replacements)"; }

    async translateBatch(list: string[], from: string, to: string): Promise<(string | null)[] | null> {
        const result = await this.inner.translateBatch(list, from, to);
        if (result == null)
            return null;

        const pack = await TranslationReplacementLogic.packFor(to);
        if (pack == undefined)
            return result;

        return result.map(s => s == null ? null : s.replace(pack.regex, match => {
            const replacement = pack.dictionary.get(match.toLowerCase())!;
            return isUpper(match) ? replacement.toUpperCase() :
                isLower(match) ? replacement.toLowerCase() :
                    match[0] === match[0].toUpperCase() ? firstUpper(replacement) : firstLower(replacement);
        }));
    }

    feedback(to: string, wrongTranslation: string, fixedTranslation: string): Promise<void> {
        return TranslationReplacementLogic.replacementFeedback(to, wrongTranslation, fixedTranslation);
    }
}

function isUpper(s: string): boolean { return s.toUpperCase() === s && s.toLowerCase() !== s; }
function isLower(s: string): boolean { return s.toLowerCase() === s && s.toUpperCase() !== s; }
function firstUpper(s: string): string { return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1); }
function firstLower(s: string): string { return s.length === 0 ? s : s[0].toLowerCase() + s.slice(1); }

// ---- Azure ------------------------------------------------------------------------------------------

/**
 * Signum's AzureTranslator — the Cognitive Services Translator v3 REST API, called directly (the SDK was
 * only ever an HttpClient wrapper). Batched 10 at a time, as Signum does.
 */
export class AzureTranslator implements ITranslator {
    readonly name = "Azure";

    constructor(
        private readonly azureKey: () => string | null | undefined,
        private readonly region?: () => string | null | undefined,
    ) { }

    async translateBatch(list: string[], from: string, to: string): Promise<(string | null)[] | null> {
        const key = this.azureKey();
        if (key == null || key === "")
            return null;

        const result: (string | null)[] = [];
        for (let i = 0; i < list.length; i += 10)
            result.push(...await this.translateChunk(list.slice(i, i + 10), from, to, key));
        return result;
    }

    private async translateChunk(chunk: string[], from: string, to: string, key: string): Promise<(string | null)[]> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Ocp-Apim-Subscription-Key": key,
        };
        const region = this.region?.();
        if (region != null && region !== "")
            headers["Ocp-Apim-Subscription-Region"] = region;

        const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0`
            + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(chunk.map(Text => ({ Text }))) });
        if (!response.ok)
            throw new Error(`Azure Translator returned ${response.status}: ${await response.text()}`);

        const body = await response.json() as { translations: { text: string }[] }[];
        return body.map(a => a.translations[0]?.text ?? null);
    }
}

// ---- DeepL ------------------------------------------------------------------------------------------

/**
 * Signum's DeepLTranslator. The `DeepL.Translator` SDK becomes its three REST calls; the language
 * NEGOTIATION Signum does (a culture DeepL does not list falls back to another variant of the same
 * neutral language) is kept, because "es-MX" → "ES" is the common case.
 */
export class DeepLTranslator implements ITranslator {
    readonly name = "DeepL";

    private sourceLanguages?: string[];
    private targetLanguages?: string[];

    constructor(private readonly apiKey: () => string | null | undefined) { }

    /** The endpoint host — a free-tier key (suffix `:fx`) uses api-free.deepl.com, as the SDK decides. */
    private baseUrl(key: string): string {
        return key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
    }

    async translateBatch(list: string[], from: string, to: string): Promise<(string | null)[] | null> {
        const key = this.apiKey();
        if (key == null || key === "")
            return null;

        this.sourceLanguages ??= await this.languages(key, "source");
        this.targetLanguages ??= await this.languages(key, "target");

        const source = negotiate(normalize(from), this.sourceLanguages);
        const target = negotiate(normalize(to), this.targetLanguages);
        if (source == undefined || target == undefined)
            return null;

        const response = await fetch(`${this.baseUrl(key)}/v2/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `DeepL-Auth-Key ${key}` },
            body: JSON.stringify({ text: list, source_lang: source, target_lang: target }),
        });
        if (!response.ok)
            throw new Error(`DeepL returned ${response.status}: ${await response.text()}`);

        const body = await response.json() as { translations: { text: string }[] };
        return body.translations.map(t => t.text ?? null);
    }

    private async languages(key: string, type: "source" | "target"): Promise<string[]> {
        const response = await fetch(`${this.baseUrl(key)}/v2/languages?type=${type}`, {
            headers: { "Authorization": `DeepL-Auth-Key ${key}` },
        });
        if (!response.ok)
            throw new Error(`DeepL returned ${response.status}: ${await response.text()}`);
        return (await response.json() as { language: string }[]).map(l => l.language);
    }
}

// DeepL's codes are upper-case ("EN", "PT-BR"); Signum's NormalizeLanguage lower-cases a two-letter code
// for its SDK, which normalizes again — going straight to DeepL's own casing is one step less.
function normalize(lang: string): string {
    return lang.toUpperCase();
}

// Signum's BestCandidate: the exact code, else the first variant of the same neutral language.
function negotiate(lang: string, available: string[]): string | undefined {
    if (available.includes(lang))
        return lang;
    const neutral = lang.split("-")[0];
    return available.find(a => a.split("-")[0] === neutral);
}

// Referenced so a caller of this module gets the culture helpers loaded (the cultures a translator is
// asked about are the application's own).
void CultureInfo;
