import type { OmniboxMatch } from "../data/OmniboxResults";

// Port of Signum.Omnibox's OmniboxUtils.cs — see port/Omnibox.md.
//
// The fuzzy MATCHER behind every omnibox suggestion. Three strategies, in order of preference:
//   1. exact key hit               → distance 0
//   2. PascalCase subsequence      → "OD" matches "OrderDate" (only when the pattern is all-uppercase)
//   3. case-insensitive contains   → each space-separated part must occur somewhere
// A match carries a same-length '#'/'_' mask so the client can bold the hit characters.
// Each strategy is tried against the entry's TRANSLATED name and, when the caller passes a `codeName`,
// against its CODE name too — the closer of the two wins, and the row still reads as the translated name.
//
// `toPascal`, `removeDiacritics` and `splitNoEmpty` live here, next to their only consumer.

// A match plus its resolved VALUE. The WIRE shape (data/OmniboxResults.OmniboxMatch) carries no value, so
// the server-only half never has to be stripped before serialising.
export interface OmniboxMatchOf<T> {
    value: T;
    match: OmniboxMatch;
}

// Validates the mask length and HALVES the distance when the match
// starts at the first character (a prefix hit outranks a mid-string one).
export function newOmniboxMatch<T>(value: T, remaining: number, choosenString: string, boldMask: string): OmniboxMatchOf<T> {
    if (choosenString.length !== boldMask.length)
        throw new Error(`choosenString '${choosenString}' is ${choosenString.length} long but boldIndices is ${boldMask.length}`);

    let distance = remaining;
    if (boldMask.length > 0 && boldMask[0] === "#")
        distance /= 2;

    return { value, match: { distance, text: choosenString, boldMask } };
}

// Every character is uppercase, so the pattern is meant as a
// PascalCase subsequence ("OD" → "OrderDate") rather than a substring.
export function isPascalCasePattern(ident: string): boolean {
    if (ident.length === 0)
        return false;

    for (const c of ident) {
        if (c !== c.toUpperCase() || c === c.toLowerCase())
            return false;
    }

    return true;
}

// Consume the pattern against the identifier's UPPERCASE
// characters only, in order. `remaining` (the distance) is how many uppercase characters were left over.
export function subsequencePascal<T>(value: T, identifier: string, pattern: string): OmniboxMatchOf<T> | undefined {
    const mask = new Array<string>(identifier.length).fill("_");
    let j = 0;
    for (const pc of pattern) {
        for (; j < identifier.length; j++) {
            const ic = identifier[j];
            if (isUpper(ic)) {
                if (ic === pc) {
                    mask[j] = "#";
                    break;
                }
            }
        }

        if (j === identifier.length)
            return undefined;

        j++;
    }

    const upperCount = [...identifier].filter(isUpper).length;
    return newOmniboxMatch(value, upperCount - pattern.length, identifier, mask.join(""));
}

// An exact key hit short-circuits with distance 0; otherwise every
// (allowed) entry is tried with the PascalCase subsequence (when the pattern is all-caps) and then the
// contains matcher. Only entries whose value passes `filter` are considered.
//
// The map is keyed by the TRANSLATED nice name, so `codeName` — when a caller supplies one — gives each
// entry its second identifier: the code name a developer knows it by ("totalPrice", "Order"), matched by
// the same three strategies. This is the QueryTokenBuilder dropdown's behaviour, where a search term hits
// either the token's `key` or its `toString()`; Signum's omnibox matches the nice name alone.
export function* matches<T>(
    values: ReadonlyMap<string, T>,
    filter: (value: T) => boolean,
    pattern: string,
    isPascalCase: boolean,
    codeName?: (value: T) => string | undefined,
): Generator<OmniboxMatchOf<T>> {
    pattern = removeDiacritics(pattern);

    const exact = values.get(pattern);
    if (exact !== undefined && filter(exact)) {
        yield newOmniboxMatch(exact, 0, pattern, "#".repeat(pattern.length));
        return;
    }

    for (const [key, value] of values) {
        if (!filter(value))
            continue;

        const nice = matchIdentifier(value, key, pattern, isPascalCase);
        const code = codeName == undefined ? undefined
            : matchCodeName(value, key, codeName(value), pattern, isPascalCase);

        // ONE row per entry. When both names match, the CLOSER distance ranks the row but the NICE
        // match keeps the mask: those characters really are in the text being shown, so they are still
        // worth bolding. Only a code-name-ONLY hit comes through unbolded.
        const best = nice == undefined ? code :
            code == undefined ? nice :
                { value, match: { ...nice.match, distance: Math.min(nice.match.distance, code.match.distance) } };

        if (best != undefined)
            yield best;
    }
}

// The PascalCase subsequence (when the pattern is all-caps) and then the contains
// matcher, against ONE identifier — the loop body `matches` had before it grew a second one.
function matchIdentifier<T>(value: T, identifier: string, pattern: string, isPascalCase: boolean): OmniboxMatchOf<T> | undefined {
    if (isPascalCase) {
        const sub = subsequencePascal(value, identifier, pattern);
        if (sub != undefined)
            return sub;
    }

    return contains(value, identifier, pattern);
}

// An entry matched through its CODE name. The distance is the code name's, so a
// prefix hit on it still outranks a mid-string one, but the row still READS as the translated name —
// the omnibox offers one vocabulary, and nothing in that text was typed, so nothing in it is bold.
function matchCodeName<T>(
    value: T,
    niceIdentifier: string,
    codeIdentifier: string | undefined,
    pattern: string,
    isPascalCase: boolean,
): OmniboxMatchOf<T> | undefined {
    if (codeIdentifier == undefined || codeIdentifier.length === 0)
        return undefined;

    const code = removeDiacritics(codeIdentifier);

    const m = code.toLowerCase() === pattern.toLowerCase()
        // An exact code name is worth as much as an exact nice name. Case-INSENSITIVELY, unlike the nice
        // name's map lookup: a code name is typed from memory, and altea's members are camelCase where
        // Signum's were Pascal, so the casing is the last thing a user gets right.
        ? newOmniboxMatch(value, 0, code, "#".repeat(code.length))
        // A camelCase key ("totalPrice") offers the subsequence no leading uppercase to consume, so the
        // first letter is raised before the pattern is walked — "TP" reaches it, as it reaches "TotalPrice".
        : matchIdentifier(value, capitalizeFirst(code), pattern, isPascalCase);

    if (m == undefined)
        return undefined;

    return {
        value,
        match: { distance: m.match.distance, text: niceIdentifier, boldMask: "_".repeat(niceIdentifier.length) },
    };
}

// Every whitespace-separated part of the pattern must occur (case
// insensitively) somewhere in the identifier; the mask marks each occurrence.
export function contains<T>(value: T, identifier: string, pattern: string): OmniboxMatchOf<T> | undefined {
    const parts = splitNoEmpty(pattern, " ");

    const mask = new Array<string>(identifier.length).fill("_");
    const lowerIdentifier = identifier.toLowerCase();

    for (const p of parts) {
        const index = lowerIdentifier.indexOf(p.toLowerCase());
        if (index === -1)
            return undefined;

        for (let i = 0; i < p.length; i++)
            mask[index + i] = "#";
    }

    return newOmniboxMatch(value, identifier.length - pattern.length, identifier, mask.join(""));
}

// Strip the quotes around a string token.
export function cleanCommas(str: string): string {
    return str.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

// ---- string helpers ---------------------------------------------------------------------------

function capitalizeFirst(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function isUpper(c: string): boolean {
    return c !== c.toLowerCase() && c === c.toUpperCase();
}

export function splitNoEmpty(text: string, separator: string): string[] {
    return text.split(separator).filter(s => s.length > 0);
}

// NFD-normalise and drop the combining marks.
export function removeDiacritics(s: string): string {
    return s.normalize("NFD").replace(/\p{Mn}/gu, "");
}

// True, keepUppercase: false): drop diacritics, then
// uppercase the first letter of every run of letters/digits and delete the separators —
// "Order Date" → "OrderDate", "Product's name" → "ProductSName".
export function toPascal(str: string): string {
    str = removeDiacritics(str);

    let sb = "";
    let upper = true;
    for (const c of str) {
        if (!isLetter(c) && !isNumber(c)) {
            upper = true;
        } else {
            sb += upper ? c.toUpperCase() : c.toLowerCase();
            if (isLetter(c))
                upper = false;
        }
    }

    return sb;
}

function isLetter(c: string): boolean {
    return /\p{L}/u.test(c);
}

function isNumber(c: string): boolean {
    return /\p{N}/u.test(c);
}

// The pascal form of a display name, keeping the `[…]` brackets
// that mark a special (non-property) token.
export function toOmniboxPascal(text: string): string {
    const result = toPascal(text);

    if (text.startsWith("[") && text.endsWith("]"))
        return "[" + result + "]";

    return result;
}

// Key a collection by the omnibox-pascal form of each
// item's display name, disambiguating collisions with a "(Duplicated!)" suffix so nothing is lost.
export function toOmniboxPascalDictionary<T, V>(
    collection: Iterable<T>,
    getKey: (item: T) => string,
    getValue: (item: T) => V,
): Map<string, V> {
    const result = new Map<string, V>();
    for (const item of collection) {
        let key = toOmniboxPascal(getKey(item));
        if (result.has(key)) {
            for (let i = 1; ; i++) {
                const newKey = key + `(Duplicated${i === 1 ? "" : " " + i}!)`;
                if (!result.has(newKey)) {
                    key = newKey;
                    break;
                }
            }
        }
        result.set(key, getValue(item));
    }
    return result;
}
