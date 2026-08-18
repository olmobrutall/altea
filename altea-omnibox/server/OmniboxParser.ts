import { Connector } from "@altea/altea/server/connection/connector";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    QueryRequest, Order, OrderType, FilterCondition, FilterOperation, Pagination,
} from "@altea/altea/server/dynamicQuery/requests";
import { retrieve } from "@altea/altea/server/Database";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { getNiceName, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { isEnumEntityType } from "@altea/altea/data/enumEntity";
import { Symbol as SymbolBase } from "@altea/altea/data/symbol";
import { Implementations } from "@altea/altea/data/implementations";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { Localization } from "@altea/altea/data/utils/localization";
import type { Entity, PrimaryKey, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { HelpOmniboxResult, OmniboxResult } from "../data/OmniboxResults";
import { OmniboxMessage } from "../data/OmniboxMessages";
import { toOmniboxPascalDictionary } from "./OmniboxUtils";

// Port of Signum's `OmniboxParser` + `OmniboxManager` (Signum.Omnibox/OmniboxParser.cs): the TOKENIZER
// and the generator pipeline behind `POST /api/omnibox`.
//
// The omnibox parses a free-text query into a flat token list, renders that list as a compact "token
// pattern" string (one char per token: I=identifier, N=number, S=string, E=entity key, G=guid, ==comparer,
// and any other symbol as itself), and hands both to each registered generator. A generator matches the
// pattern with its own regex — "^I(N|G|S)?$" for `Order 5`, "^I(I(\.I)*(\.|(=[ENSIG]?))?)*$" for
// `Order Customer.Name="Maria"` — so the grammar stays declarative.
//
// altea divergences, documented inline:
//  - Generators are ASYNC (`getResults` returns a Promise): every altea DB call is. Signum's lazy
//    `IEnumerable` + `.Take(MaxResults)` short-circuit therefore becomes an explicit slice.
//  - Signum threaded the client's special-action list through an AsyncThreadVariable
//    (ReactSpecialOmniboxGenerator.OverrideClientGenerator). altea passes an explicit per-request
//    `OmniboxContext` to every generator instead — no ambient state, no override scope.
//  - `CancellationToken` is dropped (the express handler has no equivalent; the client aborts the fetch).

// ---- Tokens (Signum's OmniboxToken / OmniboxTokenType) -----------------------------------------

export enum OmniboxTokenType {
    Identifier,
    Symbol,
    Comparer,
    Number,
    String,
    Entity,
    Guid,
}

export class OmniboxToken {
    constructor(
        public readonly type: OmniboxTokenType,
        public readonly index: number,
        public readonly value: string,
    ) { }

    // Signum's OmniboxToken.IsNull: the token spells an explicit null.
    isNull(): boolean {
        if (this.type === OmniboxTokenType.Identifier)
            return this.value === "null" || this.value === "none";

        if (this.type === OmniboxTokenType.String)
            return this.value === "\"\"";

        return false;
    }

    // Signum's OmniboxToken.Next: the raw character that FOLLOWS this token (undefined at end of input).
    // Used to tell "the user finished typing this name" (next is a space / a dot) from "still typing".
    next(rawQuery: string): string | undefined {
        const last = this.index + this.value.length;
        return last < rawQuery.length ? rawQuery[last] : undefined;
    }

    // Signum's OmniboxToken.Char: this token's single character in the token PATTERN.
    char(): string {
        switch (this.type) {
            case OmniboxTokenType.Identifier: return "I";
            case OmniboxTokenType.Symbol: return this.value;
            case OmniboxTokenType.Comparer: return "=";
            case OmniboxTokenType.Number: return "N";
            case OmniboxTokenType.String: return "S";
            case OmniboxTokenType.Entity: return "E";
            case OmniboxTokenType.Guid: return "G";
            default: return "?";
        }
    }
}

// ---- The tokenizer ------------------------------------------------------------------------------

const IDENT = String.raw`[_\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}][\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]*`;

const GUID = String.raw`[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}`;

// Signum's `symbol` class. `<` and `>` are deliberately absent — they only ever appear as comparers.
const SYMBOL = String.raw`[.,;!?@#$%&/\\()^*\[\]{}+-]`;

// Signum's `FilterValueConverter.OperationRegex` (Signum.UserAssets/FilterValueConverter.cs). Inlined:
// altea has not ported FilterValueConverter, and this is its only consumer. (The `!`s are unescaped —
// a `\!` is an illegal identity escape under the /u flag the \p{…} classes force.)
export const OPERATION_REGEX = String.raw`==?|<=|>=|<|>|\^=|\$=|%=|\*=|!=|!\^=|!\$=|!%=|!\*=`;

// ALTEA DIVERGENCE: C# allows the same capture name twice (`(?<ident>…)` for both the bare and the
// bracketed identifier); JS does not (outside the ES2025 alternation carve-out), so the second is named
// `identBracket` and mapped back to Identifier below. `RegexOptions.IgnorePatternWhitespace` is dropped
// (the pattern is written on one line) and `ExplicitCapture` is unnecessary — only named groups are read.
const TOKENIZER = new RegExp(
    `(?<entity>${IDENT};(?:\\d+|${GUID}))` +
    `|(?<space>\\s+)` +
    `|(?<guid>${GUID})` +
    `|(?<ident>${IDENT})` +
    `|(?<identBracket>\\[${IDENT}\\])` +
    `|(?<number>[+-]?\\d+(?:\\.\\d+)?)` +
    `|(?<string>"[^]*?(?:"|$)|'[^]*?(?:'|$))` +
    `|(?<comparer>${OPERATION_REGEX})` +
    `|(?<symbol>${SYMBOL})`,
    "giu");

const GROUP_TYPES: [string, OmniboxTokenType][] = [
    ["ident", OmniboxTokenType.Identifier],
    ["identBracket", OmniboxTokenType.Identifier],
    ["symbol", OmniboxTokenType.Symbol],
    ["comparer", OmniboxTokenType.Comparer],
    ["number", OmniboxTokenType.Number],
    ["guid", OmniboxTokenType.Guid],
    ["string", OmniboxTokenType.String],
    ["entity", OmniboxTokenType.Entity],
];

export function tokenize(omniboxQuery: string): OmniboxToken[] {
    const tokens: OmniboxToken[] = [];

    for (const m of omniboxQuery.matchAll(TOKENIZER)) {
        const groups = m.groups!;
        for (const [name, type] of GROUP_TYPES) {
            const value = groups[name];
            if (value != undefined) {
                // Every alternative is anchored at the match start, so the group's index IS the match's.
                tokens.push(new OmniboxToken(type, m.index, value));
                break;
            }
        }
    }

    return tokens.sort((a, b) => a.index - b.index);
}

// ---- Generators ---------------------------------------------------------------------------------

// The per-request state Signum kept in an AsyncThreadVariable (see the divergence note above).
export interface OmniboxContext {
    /** The special-action keys the CLIENT registered and considers allowed. */
    specialActions: string[];
}

// Signum's `IOmniboxResultGenerator` (its `OmniboxResultGenerator<T>` base only re-typed GetResults, so
// altea keeps the one interface).
export interface OmniboxResultGenerator {
    getResults(rawQuery: string, tokens: OmniboxToken[], tokenPattern: string, ctx: OmniboxContext): Promise<OmniboxResult[]>;
    getHelp(ctx: OmniboxContext): HelpOmniboxResult[];
}

export function helpResult(text: string, referencedTypeName?: string, isMainTitle?: boolean): HelpOmniboxResult {
    return {
        resultTypeName: "HelpOmniboxResult",
        distance: 0,
        text,
        referencedTypeName,
        isMainTitle,
    };
}

// Port of Signum's `OmniboxManager` — the CATALOGUE half of the parser: what the omnibox may offer
// (queries, types) and how it reaches the database (autocomplete, retrieve-by-id). Signum exposed it as
// `OmniboxParser.Manager` so an app could subclass and override; kept as a class here for the same reason.
export class OmniboxManager {

    // Signum's OmniboxManager.GetQueries — the registered queries keyed by the omnibox-pascal form of
    // their nice name, cached per culture (display names are culture-dependent).
    private readonly queriesByCulture = new Map<string, Map<string, QueryName>>();

    getQueries(): Map<string, QueryName> {
        const culture = CultureInfo.currentCulture();
        let d = this.queriesByCulture.get(culture);
        if (d == undefined) {
            d = toOmniboxPascalDictionary(QueryLogic.queries.getQueryNames(), qn => getNiceName(qn), qn => qn);
            this.queriesByCulture.set(culture, d);
        }
        return d;
    }

    // Signum's OmniboxManager.Types — every MAPPED entity type except enum-entity/symbol tables,
    // keyed by the omnibox-pascal form of its nice name. Cached per UI culture.
    private readonly typesByCulture = new Map<string, Map<string, Function>>();

    types(): Map<string, Function> {
        const culture = CultureInfo.currentUICulture();
        let d = this.typesByCulture.get(culture);
        if (d == undefined) {
            let ctors: Function[];
            try {
                ctors = [...Connector.current().schema.tables.keys()] as unknown as Function[];
            } catch {
                ctors = []; // no connector bound (terminal / tests) — nothing to offer
            }
            d = toOmniboxPascalDictionary(
                ctors.filter(t => !isEnumEntityOrSymbol(t)),
                t => Localization.niceName(t),
                t => t);
            this.typesByCulture.set(culture, d);
        }
        return d;
    }

    // Signum's OmniboxManager.Autocomplete → AutocompleteUtils.FindLiteLike.
    //
    // ALTEA DIVERGENCE: altea has no Database-level FindLiteLike; the substring search runs through
    // the DYNAMIC QUERY (the same "ToString Contains" request the client's EntityLine autocomplete
    // issues), so row-level security and query authorization apply for free. A type with no registered
    // query (`sb.include(T).withQuery()`) therefore yields no suggestions.
    async autocomplete(implementations: Implementations, subString: string, count: number): Promise<Lite<Entity>[]> {
        if (subString == null || subString.length === 0)
            return [];

        if (implementations.isByAll)
            return []; // Signum's FindLiteLike needs a concrete type set too

        const result: Lite<Entity>[] = [];
        for (const type of implementations.types) {
            result.push(...await this.autocompleteType(type, subString, count));
            if (result.length >= count)
                break;
        }
        return result.slice(0, count);
    }

    async autocompleteType(type: Function, subString: string, count: number): Promise<Lite<Entity>[]> {
        if (QueryLogic.queries.tryGetCore(type) == undefined)
            return [];

        // Token resolution is BEST-EFFORT: a query whose shape lacks one of these (a ModelEntity
        // projection has no "ToString"; a token key is not always the display name — the string-length
        // sub-token is keyed "length", not "Length") must degrade, not throw. A thrown token would take
        // down the whole omnibox response, since every generator shares one request.
        const tryToken = (s: string): QueryToken | undefined => {
            try {
                return QueryLogic.getToken(type, s, SubTokensOptionsAll);
            } catch {
                return undefined;
            }
        };

        const toStringToken = tryToken("ToString");
        if (toStringToken == undefined)
            return [];

        // Signum's AutocompleteUtils order: shortest ToString first, then alphabetical.
        const orders = [tryToken("ToString.length"), toStringToken]
            .filter((t): t is QueryToken => t != undefined)
            .map(t => new Order(t, OrderType.Ascending));

        const request = new QueryRequest(
            type,
            [new FilterCondition(toStringToken, FilterOperation.Contains, subString)],
            orders,
            [],
            new Pagination.Firsts(count),
            false);

        const rt = await QueryLogic.queries.executeQueryAsync(request);
        return rt.rows.map(r => r.entity as Lite<Entity> | undefined).filter((l): l is Lite<Entity> => l != undefined);
    }

    // Signum's `Database.TryRetrieveLite(type, id)`. altea has no retrieveLite, so the entity is
    // retrieved and lited; a missing row (or one the current role may not read) yields undefined, which
    // the provider renders as "[Not found]" — exactly Signum's behaviour for a bad id.
    async tryRetrieveLite(type: Function, id: PrimaryKey): Promise<Lite<Entity> | undefined> {
        try {
            const e = await retrieve(type as unknown as Type<Entity>, id);
            return e.toLite() as Lite<Entity>;
        } catch {
            return undefined;
        }
    }
}

export namespace OmniboxParser {

    export const generators: OmniboxResultGenerator[] = [];

    export let maxResults = 20;

    export const manager = new OmniboxManager();

    // Port of Signum's OmniboxParser.Results. An EMPTY query returns the syntax GUIDE (each generator
    // contributes its own example lines); otherwise the query is tokenized once and every generator is
    // offered the token list + pattern, with the union sorted by distance and capped at maxResults.
    export async function results(omniboxQuery: string, ctx: OmniboxContext): Promise<OmniboxResult[]> {

        if (omniboxQuery === "") {
            const result: OmniboxResult[] = [];
            result.push(helpResult(OmniboxMessage.Omnibox_OmniboxSyntaxGuide.niceToString(), undefined, true));

            for (const generator of generators)
                result.push(...generator.getHelp(ctx));

            result.push(helpResult(OmniboxMessage.Omnibox_MatchingOptions.niceToString()));
            result.push(helpResult(OmniboxMessage.Omnibox_DatabaseAccess.niceToString()));
            result.push(helpResult(OmniboxMessage.Omnibox_Disambiguate.niceToString()));

            return result;
        }

        const tokens = tokenize(omniboxQuery);
        const tokenPattern = tokens.map(t => t.char()).join("");

        const result: OmniboxResult[] = [];
        for (const generator of generators)
            result.push(...(await generator.getResults(omniboxQuery, tokens, tokenPattern, ctx)).slice(0, maxResults));

        return result.sort((a, b) => a.distance - b.distance).slice(0, maxResults);
    }
}

// Signum's `Type.IsEnumEntityOrSymbol()`: the generated tables that back an enum or a symbol container are
// never navigable targets, so they are hidden from the omnibox's type list.
function isEnumEntityOrSymbol(ctor: Function): boolean {
    return isEnumEntityType(ctor) || ctor === SymbolBase || ctor.prototype instanceof SymbolBase;
}
