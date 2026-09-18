import "../../data/globals";
import { StringSnippetToken } from "../../data/dynamicQuery/tokens";
import type { Filter } from "./requests";
import type { ResultTable } from "./resultTable";

// Port of Signum's `Highlighter` + the in-projector half of `StringSnippetToken`
// (DynamicQuery/Tokens/StringSnippetToken.cs).
//
// A `MatchSnippet` column is NOT a database expression on either side: Signum selects the text column
// and calls `Highlighter.FindSnippet` from the LINQ projector, i.e. in the application process. altea
// does the same thing one stage later — the token selects the text (see `tokenExpressions.ts`) and the
// excerpt is computed here, over the materialised ResultTable — because altea's projector is COMPILED
// TO JAVASCRIPT SOURCE from the expression tree and has no node for "call this closure per row".
//
// Doing it per ResultTable rather than per row also means it can see the request's FILTERS, which is
// where the words to highlight come from.

/** Signum's `StringSnippetToken.SnippetSize` — the characters a snippet is allowed to take. */
export let snippetSize: (token: StringSnippetToken) => number = () => 300;
export function setSnippetSize(fn: (token: StringSnippetToken) => number): void { snippetSize = fn; }

/**
 * Replace every `MatchSnippet` column's values (the full text, as selected) with the excerpt around
 * the words the query searched for. A no-op when the result has no such column.
 */
export function applySnippets(resultTable: ResultTable, filters: readonly Filter[]): void {
    const columns = [...resultTable.columns, ...(resultTable.entityColumn != undefined ? [resultTable.entityColumn] : [])]
        .filter(c => c.token instanceof StringSnippetToken);
    if (columns.length === 0)
        return;

    for (const column of columns) {
        const token = column.token as StringSnippetToken;
        // Signum takes the keywords of the filters that mention the snippet's OWN parent token (or a
        // tsvector column covering it); altea's full-text filters sit on that same token, and a keyword
        // from an unrelated filter would only ever pick a worse sentence — so the narrowing is kept.
        const parentKey = token.parent!.fullKey();
        const words = new Set(filters
            .filter(f => f.getTokens().some(t => t.fullKey() === parentKey))
            .flatMap(f => f.getKeywords()));
        const max = snippetSize(token);
        for (let i = 0; i < column.values.length; i++) {
            const text = column.values[i];
            if (typeof text === "string")
                column.values[i] = findSnippet(text, words, max);
        }
    }
}

interface Packet {
    readonly sentence: string;
    readonly density: number;
    readonly offset: number;
}

/**
 * Signum's `Highlighter.FindSnippet`: the densest sentences of `text`, in their ORIGINAL order, up to
 * `maxLength` characters — consecutive sentences joined by ". " and a gap marked " (…) ".
 */
export function findSnippet(text: string | null | undefined, words: ReadonlySet<string>, maxLength: number): string | null | undefined {
    if (text == null)
        return text;

    const sentences = text.replace(/\r/g, "").split(/[\n.]/).map(a => a.trim()).filter(a => a.length > 0);

    const packets: Packet[] = sentences.map((sentence, offset) => ({ sentence, density: computeDensity(words, sentence), offset }));
    // Densest first. `sort` is stable in every engine altea targets, so equal densities keep document
    // order — which is what C#'s `OrderByDescending` does too.
    const byDensity = [...packets].sort((a, b) => b.density - a.density);

    const chosen = new Map<number, string>();
    let length = 0;
    for (const packet of byDensity) {
        if (length >= maxLength)
            break;
        chosen.set(packet.offset, packet.sentence.etc(maxLength - length));
        length += packet.sentence.length;
    }

    const parts: string[] = [];
    let previous = -1;
    for (const offset of [...chosen.keys()].sort((a, b) => a - b)) {
        parts.push(previous === -1 ? "" : previous + 1 === offset ? ". " : " (…) ");
        previous = offset;
        parts.push(chosen.get(offset)!);
    }
    return parts.join("");
}

// Signum's ComputeDensity: the share of the sentence made up of the searched words. Deliberately a
// SUBSTRING match, case-insensitively — "even if not highlighted, better to find sentences where a
// sub-string is found".
function computeDensity(words: ReadonlySet<string>, sentence: string): number {
    if (sentence.length === 0)
        return 0;
    const lower = sentence.toLowerCase();
    let sum = 0;
    for (const w of words)
        if (w.length > 0 && lower.includes(w.toLowerCase()))
            sum += w.length;
    return sum / sentence.length;
}
