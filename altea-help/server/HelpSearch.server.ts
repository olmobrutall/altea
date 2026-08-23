import "@altea/altea/server";
import { cleanTypeName } from "@altea/altea/data/registration";
import { removeDiacritics } from "@altea/altea-omnibox/server/OmniboxUtils";
import { getKey as getQueryKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { AppendixHelpEntity, HelpSearchResult, MatchType, TypeSearchResult } from "../data/Help";
import { HelpLogic } from "./HelpLogic.server";

// Port of Signum.Help's HelpSearch.cs — a plain-text scan over everything the help knows: appendix titles
// and bodies, namespace titles and bodies, and for each type its name, its description, and the name /
// description of every property, query and operation.
//
// ALTEA DIVERGENCE — this is WIRED UP, where Signum's is dead code. In Signum nothing calls `.Search(`:
// there is no controller action, no `/help/search` route, and `HelpClient.Urls.searchUrl` (which the
// omnibox's "help 'some text'" suggestion navigates to) points at a page that does not exist — so that
// suggestion 404s. The scan itself is complete and correct, so the port keeps it and adds the missing
// endpoint (HelpServer) and page (client/Pages/HelpSearchPage). `searchUrl` also stops running
// `getQueryKey` over what is actually a free-text search string.
//
// Other divergences: `RemoveDiacritics` comes from altea-omnibox (the only place altea has one); the
// property/query/operation loops read a `TypeHelp` whose members are altea's PropertyRoute / QueryName /
// OperationSymbol rather than Signum's dictionaries.
export namespace HelpSearch {

    const ETC_LENGTH = 300;

    /** Every hit for `text`, ordered best-match first. */
    export async function search(text: string): Promise<HelpSearchResult[]> {
        const needle = removeDiacritics(text).trim();
        if (needle.length === 0)
            return [];

        // A LITERAL, case-insensitive, diacritic-insensitive scan (Signum builds the same from the raw
        // query). Escaped, so a user typing "C++" gets results rather than a regex error.
        const regex = new RegExp(escapeRegex(needle), "i");

        const results: HelpSearchResult[] = [];

        for (const appendix of await HelpLogic.getAppendixHelps())
            pushIf(results, searchAppendix(appendix, regex));

        for (const nh of await HelpLogic.getNamespaceHelps()) {
            const titleHit = match(regex, nh.title);
            if (titleHit != null) {
                results.push(result("Namespace", nh.title, etc(nh.description) ?? nh.title, titleHit, nh.title, nh.namespace, null, false));
                continue;
            }
            if (nh.description) {
                const hit = match(regex, nh.description);
                if (hit != null)
                    results.push(result("Namespace", nh.title, extract(nh.description, hit), hit, nh.title, nh.namespace, null, true));
            }
        }

        for (const th of await HelpLogic.getEntityHelps())
            results.push(...searchType(th, regex));

        // Signum orders by nothing at all (its consumer never existed); a Total match before a StartsWith
        // before a Contains is what a search page wants, so the ordering is added here.
        const rank: Record<MatchType, number> = { Total: 0, StartsWith: 1, Contains: 2 };
        return results.sort((a, b) => rank[a.matchType] - rank[b.matchType] || a.title.localeCompare(b.title));
    }

    function searchAppendix(entity: AppendixHelpEntity, regex: RegExp): HelpSearchResult | null {
        const titleHit = match(regex, entity.title);
        if (titleHit != null)
            return result("Appendix", entity.title, etc(entity.description) ?? entity.title, titleHit, entity.title, entity.uniqueName, null, false);

        if (entity.description) {
            const hit = match(regex, entity.description);
            if (hit != null)
                return result("Appendix", entity.title, extract(entity.description, hit), hit, entity.title, entity.uniqueName, null, true);
        }

        return null;
    }

    function* searchType(th: HelpLogic.TypeHelp, regex: RegExp): Generator<HelpSearchResult> {
        const type = th.type;
        const clean = cleanTypeName(type);
        const niceName = type.niceName();

        const typeHit = match(regex, niceName);
        if (typeHit != null) {
            yield result("Type", niceName, etc(th.dbEntity?.description ?? th.info), typeHit, niceName, clean, null, false);
            return; // Signum's `yield break`: the type itself matched, its members add nothing.
        }

        if (th.dbEntity?.description) {
            const hit = match(regex, th.dbEntity.description);
            if (hit != null) {
                yield result("Type", niceName, extract(th.dbEntity.description, hit), hit, niceName, clean, null, true);
                return;
            }
        }

        for (const p of th.properties) {
            const label = p.propertyRoute.fieldInfo?.niceToString() ?? p.propertyRoute.member;
            const hit = match(regex, label);
            if (hit != null) {
                yield result("Property", label, etc(p.userDescription ?? p.info), hit, label, clean, p.propertyRoute.propertyString(), false);
                continue;
            }
            if (p.userDescription) {
                const dHit = match(regex, p.userDescription);
                if (dHit != null)
                    yield result("Property", label, extract(p.userDescription, dHit), dHit, label, clean, p.propertyRoute.propertyString(), true);
            }
        }

        for (const q of th.queries) {
            const label = q.columns.length >= 0 ? niceQueryName(q) : niceQueryName(q);
            const key = getQueryKey(q.queryName);
            const hit = match(regex, label);
            if (hit != null) {
                yield result("Query", label, etc(q.userDescription ?? q.info), hit, label, clean, key, false);
                continue;
            }
            if (q.userDescription) {
                const dHit = match(regex, q.userDescription);
                if (dHit != null)
                    yield result("Query", label, extract(q.userDescription, dHit), dHit, label, clean, key, true);
            }
        }

        for (const op of th.operations) {
            const label = op.operation.niceToString();
            const hit = match(regex, label);
            if (hit != null) {
                yield result("Operation", label, etc(op.userDescription ?? op.info), hit, label, clean, op.operation.key, false);
                continue;
            }
            if (op.userDescription) {
                const dHit = match(regex, op.userDescription);
                if (dHit != null)
                    yield result("Operation", label, extract(op.userDescription, dHit), dHit, label, clean, op.operation.key, true);
            }
        }
    }

    function niceQueryName(q: HelpLogic.QueryHelp): string {
        const name = q.queryName;
        return typeof name === "function"
            ? (name as unknown as { nicePluralName(): string }).nicePluralName()
            : getQueryKey(name);
    }

    // ---- helpers ---------------------------------------------------------------------------------

    interface Hit { index: number; length: number }

    function match(regex: RegExp, text: string | null | undefined): Hit | null {
        if (!text)
            return null;
        const m = regex.exec(removeDiacritics(text));
        return m == null ? null : { index: m.index, length: m[0].length };
    }

    function result(
        typeSearchResult: TypeSearchResult,
        title: string,
        description: string | null,
        hit: Hit,
        matchedText: string,
        key: string,
        key2: string | null,
        isDescription: boolean,
    ): HelpSearchResult {
        return {
            typeSearchResult,
            title,
            description,
            key,
            key2,
            isDescription,
            matchType: hit.index === 0 && hit.length === matchedText.length ? "Total"
                : hit.index === 0 ? "StartsWith"
                    : "Contains",
        };
    }

    function pushIf(list: HelpSearchResult[], r: HelpSearchResult | null): void {
        if (r != null)
            list.push(r);
    }

    /** Signum's `string.Etc(n)` — truncate with an ellipsis. */
    function etc(text: string | null | undefined): string | null {
        if (!text)
            return null;
        const plain = stripHtml(text);
        return plain.length <= ETC_LENGTH ? plain : plain.substring(0, ETC_LENGTH) + "…";
    }

    /** Signum's `HelpUtilities.Extract(s, match)` — a window CENTRED on the hit. */
    function extract(text: string, hit: Hit): string {
        const plain = stripHtml(text);
        if (plain.length <= ETC_LENGTH)
            return plain;

        const half = Math.floor(ETC_LENGTH / 2);
        const middle = Math.floor((hit.index + hit.index + hit.length) / 2);

        let min = middle - half;
        let max = middle + half;

        if (min < 0) {
            min = 0;
            max = ETC_LENGTH;
        }
        if (max > plain.length) {
            max = plain.length;
            min = max - ETC_LENGTH;
        }

        return (min !== 0 ? "..." : "") + plain.substring(min, max) + (max !== plain.length ? "..." : "");
    }

    /**
     * ALTEA: the descriptions are HTML (Signum's were too, and its own comment admits the snippet "looks
     * strange" because of it). A search RESULT is a one-line teaser, so the tags come out — the hit
     * indices are computed on the raw text and the window is approximate either way.
     */
    function stripHtml(html: string): string {
        return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    }

    function escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}
