import { Connector } from "@altea/altea/server/connection/connector";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    QueryRequest, Order, OrderTypeKeys, FilterCondition, FilterOperationKeys, Pagination,
} from "@altea/altea/server/dynamicQuery/requests";
import { retrieve } from "@altea/altea/server/Database";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { getNiceName, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { isEnumEntityType } from "@altea/altea/data/enumEntity";
import { Symbol as SymbolBase } from "@altea/altea/data/symbol";
import { Implementations } from "@altea/altea/data/implementations";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import type { Entity, PrimaryKey, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { HelpOmniboxResult, OmniboxResult } from "../data/OmniboxResults";
import { OmniboxMessage } from "../data/OmniboxMessages";
import { toOmniboxPascalDictionary } from "./OmniboxUtils";

// Port of Signum.Omnibox's OmniboxParser.cs (OmniboxParser + OmniboxManager) — see docs/port/Omnibox.md.
//
// A free-text query is parsed into a flat token list and rendered as a compact "token pattern" string —
// one char per token: I=identifier, N=number, S=string, E=entity key, G=guid, ==comparer, any other symbol
// as itself — and both are handed to each registered generator. A generator matches the pattern with its
// own regex: "^I(N|G|S)?$" for `Order 5`, "^I(I(\.I)*(\.|(=[ENSIG]?))?)*$" for
// `Order Customer.Name="Maria"`. That is what keeps the grammar declarative.
//
// Generators are ASYNC, so the lazy take-N short-circuit is an explicit slice. There is NO ambient state:
// the client's special-action list rides an explicit per-request `OmniboxContext`.

// ---- Tokens ------------------------------------------------------------------------------------

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

    // The token spells an explicit null.
    isNull(): boolean {
        if (this.type === OmniboxTokenType.Identifier)
            return this.value === "null" || this.value === "none";

        if (this.type === OmniboxTokenType.String)
            return this.value === "\"\"";

        return false;
    }

    // The raw character that FOLLOWS this token (undefined at end of input).
    // Used to tell "the user finished typing this name" (next is a space / a dot) from "still typing".
    next(rawQuery: string): string | undefined {
        const last = this.index + this.value.length;
        return last < rawQuery.length ? rawQuery[last] : undefined;
    }

    // This token's single character in the token PATTERN.
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

// `<` and `>` are deliberately absent — they only ever appear as comparers.
const SYMBOL = String.raw`[.,;!?@#$%&/\\()^*\[\]{}+-]`;

// Inlined rather than shared: FilterValueConverter's operation half is not ported, and this is its only
// consumer. (The `!`s are unescaped — a `\!` is an illegal identity escape under the /u flag the \p{…}
// classes force.)
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

// The per-request state, passed explicitly rather than kept in ambient scope (see the header).
export interface OmniboxContext {
    /** The special-action keys the CLIENT registered and considers allowed. */
    specialActions: string[];
}

// ONE interface: Signum's `OmniboxResultGenerator<T>` base only re-typed GetResults.
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

// The CATALOGUE half of the parser: what the omnibox may offer (queries, types) and how it reaches the
// database (autocomplete, retrieve-by-id). A CLASS, so an app can subclass and override it.
export class OmniboxManager {

    // The registered queries keyed by the omnibox-pascal form of
    // their nice name, cached per culture (display names are culture-dependent).
    private readonly queriesByCulture = new Map<string, Map<string, QueryName>>();

    getQueries(): Map<string, QueryName> {
        // Keyed on the UI culture — the one the nice names below actually resolve through. Keying on the
        // FORMATTING culture instead (which is what Signum does) would have two requests sharing a
        // formatting culture but not a UI culture share the wrong map.
        const culture = CultureInfo.currentUICulture();
        let d = this.queriesByCulture.get(culture);
        if (d == undefined) {
            d = toOmniboxPascalDictionary(QueryLogic.queries.getQueryNames(), qn => getNiceName(qn), qn => qn);
            this.queriesByCulture.set(culture, d);
        }
        return d;
    }

    // Every MAPPED entity type except enum-entity/symbol tables,
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
                t => t.niceName(),
                t => t);
            this.typesByCulture.set(culture, d);
        }
        return d;
    }

    // The substring search runs through the DYNAMIC QUERY — the same "ToString Contains" request the
    // client's EntityLine autocomplete issues — so row-level security and query authorization apply for
    // free. A type with no registered query (`sb.include(T).withQuery()`) therefore yields NO suggestions.
    async autocomplete(implementations: Implementations, subString: string, count: number): Promise<Lite<Entity>[]> {
        if (subString == null || subString.length === 0)
            return [];

        if (implementations.isByAll)
            return []; // a concrete type set is needed to search at all

        const result: Lite<Entity>[] = [];
        // Implementations.types is declared `Function[]`; every member is a reflected entity ctor,
        // which is what a QueryName is.
        for (const type of implementations.types as QueryName[]) {
            result.push(...await this.autocompleteType(type, subString, count));
            if (result.length >= count)
                break;
        }
        return result.slice(0, count);
    }

    async autocompleteType(type: QueryName, subString: string, count: number): Promise<Lite<Entity>[]> {
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

        // Shortest ToString first, then alphabetical.
        const orders = [tryToken("ToString.length"), toStringToken]
            .filter((t): t is QueryToken => t != undefined)
            .map(t => new Order(t, OrderTypeKeys.Ascending));

        const request = new QueryRequest(
            type,
            [new FilterCondition(toStringToken, FilterOperationKeys.Contains, subString)],
            orders,
            [],
            new Pagination.Firsts(count),
            false);

        const rt = await QueryLogic.queries.executeQueryAsync(request);
        return rt.rows.map(r => r.entity as Lite<Entity> | undefined).filter((l): l is Lite<Entity> => l != undefined);
    }

    // There is no retrieveLite, so the entity is retrieved and lited. A missing row — or one the current
    // role may not read — yields undefined, which the provider renders as "[Not found]".
    async tryRetrieveLite(type: Function, id: PrimaryKey): Promise<Lite<Entity> | undefined> {
        try {
            const e = await retrieve(type as Type<Entity>, id);
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

    // An EMPTY query returns the syntax GUIDE (each generator
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

// The generated tables that back an enum or a symbol container are
// never navigable targets, so they are hidden from the omnibox's type list.
function isEnumEntityOrSymbol(ctor: Function): boolean {
    return isEnumEntityType(ctor) || ctor === SymbolBase || ctor.prototype instanceof SymbolBase;
}
