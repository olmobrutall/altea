import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
// The tokens barrel (`…/tokens`) is a DIRECTORY index; the package's `./*` export map resolves only
// files, so each token module is imported by its own path (as altea-chart / altea-user-assets do).
import { SubTokensOptions, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { ManualToken, ManualContainerToken } from "@altea/altea/data/dynamicQuery/tokens/manualToken";
import { getKey, tryGetFilterType, type FilterType } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { FilterOperation } from "@altea/altea/data/dynamicQueries";
import { Temporal, Decimal } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";
import { Lite } from "@altea/altea/data/lite";
import { Entity, type PrimaryKey, type Type } from "@altea/altea/data/entity";
import { Localization } from "@altea/altea/data/utils/localization";
import type {
    DynamicQueryOmniboxResult, FilterSyntax, FilterSyntaxCompletion, HelpOmniboxResult,
    OmniboxFilterResult, OmniboxMatch, OmniboxResult,
} from "../data/OmniboxResults";
import { OmniboxResultTypeName, UnknownOmniboxValue } from "../data/OmniboxResults";
import { OmniboxMessage } from "../data/OmniboxMessages";
import {
    OmniboxParser, OmniboxTokenType, helpResult,
    type OmniboxContext, type OmniboxResultGenerator, type OmniboxToken,
} from "./OmniboxParser";
import {
    cleanCommas, isPascalCasePattern, matches, removeDiacritics, toOmniboxPascal,
    toOmniboxPascalDictionary, type OmniboxMatchOf,
} from "./OmniboxUtils";
import { allowedQueryFilter } from "./OmniboxAuth";
import { tryParsePrimaryKey } from "./EntityOmniboxResultGenerator";

// Port of Signum's `DynamicQueryOmniboxResultGenerator`
// (Signum.Omnibox/DynamicQueryOmniboxResultGenerator.cs): the omnibox's richest shape — a QUERY plus any
// number of (possibly half-typed) filters:
//
//     Order                              → open the Order search
//     Order Cus                          → …with the Customer column offered
//     Order Customer.Name="Maria"        → …filtered
//     Order TotalPrice>100 State=Shipped → …twice
//
// Every stage is ambiguous on purpose: each token may fuzzy-match several columns, each value several
// entities, so the generator emits the CARTESIAN PRODUCT of the alternatives and lets `distance` rank
// them.
//
// altea divergences, documented inline:
//  - Signum's `QueryDescription` is gone: sub-tokens come from the query's ROOT TOKEN
//    (QueryLogic.getRootToken), whose children ARE the query's columns.
//  - The syntax regex is hand-scanned (see `syntaxSequence`): the C# pattern relies on .NET's
//    per-repetition `Group.Captures`, which JS RegExp does not retain.
//  - `getResults`/`getFilterQueries` are async (entity autocomplete hits the database).
//  - `ToStringValue` takes the token's FilterType rather than reflecting on the value: an altea enum
//    value is a plain string at runtime, indistinguishable from a String value.

export class DynamicQueryOmniboxResultGenerator implements OmniboxResultGenerator {

    autoCompleteLimit = 5;

    async getResults(rawQuery: string, tokens: OmniboxToken[], tokenPattern: string, _ctx: OmniboxContext): Promise<OmniboxResult[]> {

        const syntaxes = syntaxSequence(tokenPattern);

        if (syntaxes == undefined)
            return [];

        const pattern = tokens[0].value;

        const isPascalCase = isPascalCasePattern(pattern);

        const queries = OmniboxParser.manager.getQueries();
        // Signum's inline `filter: qn => QueryLogic.Queries.QueryAllowed(qn, true)`; altea's query
        // authorization is async, so the allowed set is resolved before the (sync) matcher runs.
        const isAllowed = await allowedQueryFilter([...queries.values()]);

        const result: DynamicQueryOmniboxResult[] = [];

        for (const match of [...matches(queries, isAllowed, pattern, isPascalCase)].sort((a, b) => a.match.distance - b.match.distance)) {

            const queryName = match.value;

            if (syntaxes.length > 0) {
                const rootToken = QueryLogic.getRootToken(queryName);

                const bruteFilters: OmniboxFilterResult[][] = [];
                for (const a of syntaxes)
                    bruteFilters.push(await this.getFilterQueries(rawQuery, rootToken, a, tokens));

                for (const list of cartesianProduct(bruteFilters)) {
                    result.push({
                        resultTypeName: OmniboxResultTypeName.DynamicQuery,
                        queryName: getKey(queryName),
                        queryNameMatch: match.match,
                        distance: match.match.distance + average(list.map(a => a.distance)),
                        filters: list,
                    });
                }
            } else {
                // A fully-typed query name followed by a space: offer each of its columns as the next
                // thing to filter by.
                if (match.match.text === pattern && tokens.length === 1 && tokens[0].next(rawQuery) === " ") {
                    const rootToken = QueryLogic.getRootToken(queryName);

                    for (const qt of rootToken.subTokens(SUB_TOKEN_OPTIONS)) {
                        result.push({
                            resultTypeName: OmniboxResultTypeName.DynamicQuery,
                            queryName: getKey(queryName),
                            queryNameMatch: match.match,
                            distance: match.match.distance,
                            filters: [filterResult(0, undefined, qt, undefined)],
                        });
                    }
                } else {
                    result.push({
                        resultTypeName: OmniboxResultTypeName.DynamicQuery,
                        queryName: getKey(queryName),
                        queryNameMatch: match.match,
                        distance: match.match.distance,
                        filters: [],
                    });
                }
            }
        }

        return result;
    }

    // Signum's GetFilterQueries: every reading of ONE filter slot — its ambiguous token chains, and for a
    // complete filter its ambiguous values.
    protected async getFilterQueries(rawQuery: string, rootToken: QueryToken, syntax: FilterSyntax, tokens: OmniboxToken[]): Promise<OmniboxFilterResult[]> {
        const result: OmniboxFilterResult[] = [];

        const operatorIndex = syntax.index + syntax.tokenLength;

        const ambiguousTokens = [...getAmbiguousTokens(undefined, [], rootToken, tokens, syntax.index, operatorIndex)];

        for (const pair of ambiguousTokens) {
            const distance = pair.stack.reduce((acc, a) => acc + a.match.distance, 0);
            const tokenMatches = pair.stack.map(a => a.match);
            const token = pair.token;

            if (syntax.completion === "Token") {
                // The user typed a trailing dot AND every segment so far is an exact name — so they mean
                // "go deeper": offer this token's sub-tokens instead of the token itself.
                if (tokens[operatorIndex - 1].next(rawQuery) === "." && pair.stack.every(a => toOmniboxPascal(a.value.toString()) === a.match.text)) {
                    for (const qt of token.subTokens(SUB_TOKEN_OPTIONS))
                        result.push(filterResult(distance, syntax, qt, tokenMatches));
                } else {
                    result.push(filterResult(distance, syntax, token, tokenMatches));
                }
            } else {
                const cf = canFilter(token);

                if (cf != null) {
                    result.push({ ...filterResult(distance, syntax, token, tokenMatches), canFilter: cf });
                } else {
                    const operation = parseOperation(tokens[operatorIndex].value);
                    const filterType = tryGetFilterType(token.type);

                    if (syntax.completion === "Operation") {
                        const suggested = this.sugestedValues(token);

                        if (suggested == undefined) {
                            result.push({ ...filterResult(distance, syntax, token, tokenMatches), operation, operationToString: toStringOperation(operation) });
                        } else {
                            for (const item of suggested) {
                                result.push({
                                    ...filterResult(distance, syntax, token, tokenMatches),
                                    operation,
                                    operationToString: toStringOperation(operation),
                                    value: item.value,
                                    valueToString: toStringValue(filterType, item.value),
                                });
                            }
                        }
                    } else {
                        const values = await this.getValues(token, tokens[operatorIndex + 1]);

                        for (const value of values) {
                            result.push({
                                ...filterResult(distance, syntax, token, tokenMatches),
                                operation,
                                operationToString: toStringOperation(operation),
                                value: value.value,
                                valueToString: toStringValue(filterType, value.value),
                                valueMatch: value.match,
                            });
                        }
                    }
                }
            }
        }

        return result;
    }

    // Signum's SugestedValues: with an operator typed but no value yet, propose the type's "obvious"
    // values (0 / "" / today / both booleans / every enum member). undefined ⇒ nothing to propose.
    protected sugestedValues(queryToken: QueryToken): ValueTuple[] | undefined {
        const ft = tryGetFilterType(queryToken.type);
        switch (ft) {
            case "Integer": return [{ value: 0 }];
            case "Decimal": return [{ value: new Decimal(0) }];
            case "String": return [{ value: "" }];
            case "DateTime": return [{ value: queryToken.type.typeName === "PlainDate" ? Temporal.Now.plainDateISO() : Temporal.Now.plainDateISO().toPlainDateTime() }];
            case "Time": return [{ value: queryToken.type.typeName === "Duration" ? new Temporal.Duration() : new Temporal.PlainTime() }];
            case "Boolean": return [{ value: true }, { value: false }];
            case "Enum": {
                const e = queryToken.type.getEnum();
                // altea's runtime/wire value for an enum IS the member name string.
                return e == undefined ? undefined : Enum.values(e as Record<string, string | number>).map(v => ({ value: v as unknown }));
            }
            case "Lite":
            case "Embedded":
            case "Guid":
            default:
                return undefined;
        }
    }

    // Signum's GetValues: parse the value token against the column's type. An unparseable value becomes
    // the UNKNOWN sentinel so the suggestion still renders (in red) instead of disappearing.
    protected async getValues(queryToken: QueryToken, omniboxToken: OmniboxToken): Promise<ValueTuple[]> {
        if (omniboxToken.isNull())
            return [{ value: null }];

        const ft = tryGetFilterType(queryToken.type);
        switch (ft) {
            case "Integer":
            case "Decimal":
                if (omniboxToken.type === OmniboxTokenType.Number) {
                    const n = Number(omniboxToken.value);
                    if (!isNaN(n))
                        return [{ value: ft === "Decimal" ? new Decimal(omniboxToken.value) : n }];
                }
                break;

            case "String":
                if (omniboxToken.type === OmniboxTokenType.String)
                    return [{ value: cleanCommas(omniboxToken.value) }];
                break;

            case "DateTime":
            case "Time":
                if (omniboxToken.type === OmniboxTokenType.String) {
                    const parsed = tryParseTemporal(queryToken.type.typeName, cleanCommas(omniboxToken.value));
                    if (parsed != undefined)
                        return [{ value: parsed }];
                }
                break;

            case "Lite":
                if (omniboxToken.type === OmniboxTokenType.String) {
                    const pattern = cleanCommas(omniboxToken.value);

                    const implementations = queryToken.getImplementations();
                    if (implementations == undefined)
                        break;

                    const lites = await OmniboxParser.manager.autocomplete(implementations, pattern, this.autoCompleteLimit);

                    return lites.map(lite => {
                        const m = containsMatch(lite.toString() ?? "", pattern);
                        return { value: lite as unknown, match: m };
                    });
                } else if (omniboxToken.type === OmniboxTokenType.Entity) {
                    try {
                        return [{ value: Lite.parse(omniboxToken.value) as unknown }];
                    } catch {
                        break;
                    }
                } else if (omniboxToken.type === OmniboxTokenType.Number) {
                    const imp = queryToken.getImplementations();
                    if (imp != undefined && !imp.isByAll) {
                        const lites = imp.types.map(t => createLite(t, omniboxToken.value)).filter((l): l is Lite<Entity> => l != undefined);
                        if (lites.length > 0)
                            return lites.map(l => ({ value: l as unknown }));
                    }
                }
                break;

            case "Embedded":
            case "Boolean": {
                const boolean = parseBool(omniboxToken.value);
                if (boolean != undefined)
                    return [{ value: boolean }];
                break;
            }

            case "Enum":
                if (omniboxToken.type === OmniboxTokenType.String || omniboxToken.type === OmniboxTokenType.Identifier) {
                    const value = omniboxToken.type === OmniboxTokenType.Identifier ? omniboxToken.value : cleanCommas(omniboxToken.value);
                    const isPascalValue = isPascalCasePattern(value);
                    const e = queryToken.type.getEnum() as Record<string, string | number> | undefined;
                    if (e == undefined)
                        break;

                    const dic = toOmniboxPascalDictionary(Enum.values(e), n => Enum.niceName(e, n), n => n as unknown);

                    return [...matches(dic, () => true, value, isPascalValue)].map(m => ({ value: m.value, match: m.match }));
                }
                break;

            case "Guid":
                if (omniboxToken.type === OmniboxTokenType.Guid)
                    return [{ value: omniboxToken.value }];
                else if (omniboxToken.type === OmniboxTokenType.String) {
                    const str = cleanCommas(omniboxToken.value);
                    if (GUID_REGEX.test(str))
                        return [{ value: str }];
                }
                break;

            default:
                break;
        }

        return [{ value: UnknownOmniboxValue }];
    }

    getHelp(_ctx: OmniboxContext): HelpOmniboxResult[] {
        const queryName = OmniboxMessage.Omnibox_Query.niceToString();
        const field = OmniboxMessage.Omnibox_Field.niceToString();
        const value = OmniboxMessage.Omnibox_Value.niceToString();

        return [
            helpResult(`${queryName}`, OmniboxResultTypeName.DynamicQuery),
            helpResult(`${queryName} ${field}='${value}'`, OmniboxResultTypeName.DynamicQuery),
            helpResult(`${queryName} ${field}1='${value}1' ${field}2='${value}2'`, OmniboxResultTypeName.DynamicQuery),
        ];
    }
}

// Signum passes `SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement` everywhere in this generator.
const SUB_TOKEN_OPTIONS = SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement;

const GUID_REGEX = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i;

export interface ValueTuple {
    value: unknown;
    match?: OmniboxMatch;
}

// ---- The syntax scanner -------------------------------------------------------------------------

// Signum matched the token pattern with
//     ^I(?<filter>(?<token>I(\.I)*)(\.|((?<op>=)(?<val>[ENSIG])?))?)*$
// and then read each repetition out of `Group.Captures` — a .NET-only feature (a JS RegExp keeps only
// the LAST capture of a repeated group). The same grammar is therefore scanned by hand below; it stays
// a faithful transcription of that pattern, one branch per regex construct.
//
// Returns undefined when the pattern does not match at all (this generator then yields nothing).
export function syntaxSequence(tokenPattern: string): FilterSyntax[] | undefined {
    if (tokenPattern[0] !== "I")
        return undefined;

    const result: FilterSyntax[] = [];
    let i = 1;

    while (i < tokenPattern.length) {
        const start = i;

        // (?<token>I(\.I)*)
        if (tokenPattern[i] !== "I")
            return undefined;
        i++;
        while (tokenPattern[i] === "." && tokenPattern[i + 1] === "I")
            i += 2;
        const tokenLength = i - start;

        // (\.|((?<op>=)(?<val>[ENSIG])?))?
        let completion: FilterSyntaxCompletion = "Token";
        if (tokenPattern[i] === ".") {
            i++; // a trailing dot: still an incomplete TOKEN (the user is about to navigate deeper)
        } else if (tokenPattern[i] === "=") {
            i++;
            completion = "Operation";
            if (i < tokenPattern.length && "ENSIG".includes(tokenPattern[i])) {
                i++;
                completion = "Complete";
            }
        }

        result.push({ index: start, tokenLength, length: i - start, completion });
    }

    return i === tokenPattern.length ? result : undefined;
}

// Signum's GetAmbiguousTokens: walk the dotted chain left to right, fanning out over every column whose
// name fuzzy-matches the segment, and yield each complete chain with the per-segment matches that built
// it (so the client can bold exactly what the user typed).
function* getAmbiguousTokens(
    queryToken: QueryToken | undefined,
    distancePack: OmniboxMatchOf<QueryToken>[],
    rootToken: QueryToken,
    omniboxTokens: OmniboxToken[],
    index: number,
    operatorIndex: number,
): Generator<{ token: QueryToken; stack: OmniboxMatchOf<QueryToken>[] }> {
    const omniboxToken = omniboxTokens[index];

    const isPascal = isPascalCasePattern(omniboxToken.value);

    // Signum: QueryUtils.SubTokens(queryToken, queryDescription, …) — a null parent meant "the query's
    // columns". altea: the query's columns ARE the root token's sub-tokens.
    const parent = queryToken ?? rootToken;
    const dic = toOmniboxPascalDictionary(parent.subTokens(SUB_TOKEN_OPTIONS), qt => qt.toString(), qt => qt);
    const ms = matches(dic, qt => qt.isAllowed() == null, omniboxToken.value, isPascal);

    if (index === operatorIndex - 1) {
        for (const m of ms)
            yield { token: m.value, stack: [...distancePack, m] };
    } else {
        for (const m of ms)
            yield* getAmbiguousTokens(m.value, [...distancePack, m], rootToken, omniboxTokens, index + 2, operatorIndex);
    }
}

// ---- Result construction ------------------------------------------------------------------------

function filterResult(distance: number, syntax: FilterSyntax | undefined, queryToken: QueryToken, queryTokenMatches: OmniboxMatch[] | undefined): OmniboxFilterResult {
    return {
        distance,
        syntax,
        queryToken: queryToken.fullKey(),
        queryTokenOmniboxPascal: queryTokenOmniboxPascal(queryToken),
        queryTokenMatches,
    };
}

// Signum's `QueryToken.Follow(a => a.Parent).Reverse().ToString(a => a.ToString().ToOmniboxPascal(), ".")`.
// ALTEA: the chain stops BEFORE the root token — altea's query root has key "" and its toString() is the
// entity's nice name, so including it would prefix every path with "Order.".
function queryTokenOmniboxPascal(token: QueryToken): string {
    const chain: QueryToken[] = [];
    for (let t: QueryToken | undefined = token; t != undefined && t.parent != undefined; t = t.parent)
        chain.unshift(t);
    return chain.map(t => toOmniboxPascal(t.toString())).join(".");
}

// ---- Small ports of Signum helpers ---------------------------------------------------------------

// Signum's `QueryUtils.CanFilter` (DynamicQuery/QueryUtils.cs).
function canFilter(token: QueryToken | undefined): string | null {
    if (token == undefined)
        return "No column selected";

    if (token.type.array)
        return "You can not filter by collections, continue the sequence";

    if (token instanceof ManualContainerToken || token instanceof ManualToken)
        return `${token.toString()} is not a valid filter`;

    return null;
}

// Signum's `FilterValueConverter.ParseOperation` / `ToStringOperation` (Signum.UserAssets). Inlined here:
// altea has not ported FilterValueConverter and the omnibox is its only consumer.
export function parseOperation(operationString: string): FilterOperation {
    switch (operationString) {
        case "=":
        case "==": return "EqualTo";
        case "<=": return "LessThanOrEqual";
        case ">=": return "GreaterThanOrEqual";
        case "<": return "LessThan";
        case ">": return "GreaterThan";
        case "^=": return "StartsWith";
        case "$=": return "EndsWith";
        case "%=": return "Like";
        case "*=": return "Contains";
        case "!=": return "DistinctTo";
        case "!^=": return "NotStartsWith";
        case "!$=": return "NotEndsWith";
        case "!%=": return "NotLike";
        case "!*=": return "NotContains";
    }
    throw new Error(`Unexpected Filter ${operationString}`);
}

export function toStringOperation(operation: FilterOperation): string {
    switch (operation) {
        case "EqualTo": return "=";
        case "DistinctTo": return "!=";
        case "GreaterThan": return ">";
        case "GreaterThanOrEqual": return ">=";
        case "LessThan": return "<";
        case "LessThanOrEqual": return "<=";
        case "Contains": return "*=";
        case "StartsWith": return "^=";
        case "EndsWith": return "$=";
        case "Like": return "%=";
        case "NotContains": return "!*=";
        case "NotStartsWith": return "!^=";
        case "NotEndsWith": return "!$=";
        case "NotLike": return "!%=";
    }
    throw new Error(`Unexpected Filter ${operation}`);
}

// Signum's `DynamicQueryOmniboxResultGenerator.ToStringValue`: render a filter value back into omnibox
// syntax, so [Tab] can rewrite the input with the disambiguated suggestion.
//
// ALTEA DIVERGENCE (two):
//  - the FilterType is passed in rather than reflected off the value (an altea enum value is a plain
//    string at runtime, so `typeof value` cannot tell it from a String column's value);
//  - an enum renders in OMNIBOX-PASCAL form ("InTransit"), not Signum's spaced nice name ("In transit").
//    That is what the value matcher keys on, so it is the only form that survives the [Tab] round-trip.
export function toStringValue(filterType: FilterType | undefined, value: unknown): string {
    if (value == null)
        return "null";

    if (value === UnknownOmniboxValue)
        return UnknownOmniboxValue;

    switch (filterType) {
        case "Integer":
        case "Decimal": return String(value);
        case "String": return "\"" + String(value) + "\"";
        case "DateTime":
        case "Time": return "'" + String(value) + "'";
        case "Lite": return (value as Lite<Entity>).key();
        case "Embedded": throw new Error("Impossible to translate not null Embedded entity to string");
        case "Boolean": return String(value);
        case "Enum": return toOmniboxPascal(String(value));
        case "Guid": return "\"" + String(value) + "\"";
    }

    throw new Error(`Unexpected value type ${String(filterType)}`);
}

// Signum's CreateLite: a placeholder lite for "<Type> <id>" typed as a filter value — the ToString is
// synthesised, since the row is not fetched.
function createLite(type: Function, value: string): Lite<Entity> | undefined {
    const id = tryParsePrimaryKey(type, value);
    if (id == undefined)
        return undefined;
    return (type as unknown as Type<Entity> & typeof Entity).newLite(id as PrimaryKey, `${Localization.niceName(type)} ${String(id)}`) as Lite<Entity>;
}

// Signum's ParseBool: accepts en/es/… spellings plus the localized OmniboxMessage.Yes/No.
function parseBool(val: string): boolean | undefined {
    val = removeDiacritics(val.toLowerCase());

    if (val === "true" || val === "t" || val === "yes" || val === "y" || val === OmniboxMessage.Yes.niceToString())
        return true;

    if (val === "false" || val === "f" || val === "no" || val === "n" || val === OmniboxMessage.No.niceToString())
        return false;

    return undefined;
}

// Signum's `ReflectionTools.TryParse(str, dateOrTimeType)` — luxon/DateTime is Temporal in altea.
function tryParseTemporal(typeName: string | undefined, str: string): unknown {
    try {
        switch (typeName) {
            case "PlainDate": return Temporal.PlainDate.from(str);
            case "PlainDateTime": return Temporal.PlainDateTime.from(str);
            case "PlainTime": return Temporal.PlainTime.from(str);
            case "Duration": return Temporal.Duration.from(str);
        }
    } catch {
        return undefined;
    }
    return undefined;
}

// The bold-mask half of OmniboxUtils.Contains, for a value whose "value" side is the lite itself.
function containsMatch(text: string, pattern: string): OmniboxMatch | undefined {
    const parts = pattern.split(" ").filter(p => p.length > 0);
    const mask = new Array<string>(text.length).fill("_");
    const lower = text.toLowerCase();
    for (const p of parts) {
        const index = lower.indexOf(p.toLowerCase());
        if (index === -1)
            return undefined;
        for (let i = 0; i < p.length; i++)
            mask[index + i] = "#";
    }
    let distance = text.length - pattern.length;
    if (mask[0] === "#")
        distance /= 2;
    return { distance, text, boldMask: mask.join("") };
}

// Signum's `IEnumerable<IEnumerable<T>>.CartesianProduct()` (Signum.Utilities).
function cartesianProduct<T>(sequences: T[][]): T[][] {
    let result: T[][] = [[]];
    for (const seq of sequences) {
        const next: T[][] = [];
        for (const acc of result)
            for (const item of seq)
                next.push([...acc, item]);
        result = next;
    }
    return result;
}

function average(values: number[]): number {
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
