import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Decimal, Temporal } from "@altea/altea/data/basics";
import { FilterOperation } from "@altea/altea/server/dynamicQuery/requests";
import type { ResultColumn, ResultRow } from "@altea/altea/server/dynamicQuery/resultTable";
import { ValueProviderBase } from "./ValueProviders.server";
import { ConditionAnd, ConditionCompare, ConditionOr, type ConditionBase } from "./Conditions.server";
import type { ITemplateParser } from "./ValueProviders.server";

// Port of Signum.Templating's CommonTemplate.cs — the module's shared plumbing: the syntax regexes, the
// condition parser, the row-grouping helpers used by @foreach / @any, and the "semi-structural" equality
// that decides whether two rows carry the SAME value for a column.
//
// altea divergences, documented inline:
//  - `TemplateSynchronizationContext` / `TemplateSyncException` (the interactive `terminal sync` pass that
//    rewrites stored templates when a query token is renamed) are NOT ported: they need Signum's
//    TokenMigrations / QueryTokenSynchronizer, which altea has no counterpart for. A renamed token
//    therefore surfaces as a parse ERROR on the template (the message the parser already produces)
//    instead of an interactive fix-up.
//  - `MemberWithArguments` / `ParsedModel.GetMembers` (the reflection walk behind `@[m:A.B(C)]`) live in
//    ValueProviders.server.ts next to their only consumers.
//  - `SemiStructuralEqualityComparer` walks a value's own enumerable properties instead of C# FIELDS, and
//    treats Temporal / Decimal / Lite / Entity as "simple" (compare by their canonical string / id).

// Signum's KeywordsRegex. `@keyword[expr] as $var` for the block keywords, plus the bare closers. The
// `expr` group balances nested brackets in C# with a balancing-group construct; JS has no such feature,
// so the bracket body is scanned BY HAND (see scanKeywords below) and this regex only matches the
// keyword head. `raw`/`global`/`model`/`modelraw`/`declare`/`if`/`elseif`/`foreach`/`any` + the empty
// keyword (a plain `@[…]` value) all open a bracket; the rest are bare.
const keywordHeadRegex = /@(?<keyword>foreach|elseif|if|raw|global|modelraw|model|any|declare|endforeach|endif|endany|notany|else)?(?<open>\[)?/g;

/** One `@…` marker found in the template text (the JS stand-in for a C# Match over KeywordsRegex). */
export interface KeywordMatch {
    index: number;
    length: number;
    keyword: string;
    /** The text inside `[...]` (undefined for the bare closers). */
    expr: string;
    /** The `$name` of a trailing `as $name` declaration, or "". */
    dec: string;
}

const bracketKeywords = new Set(["", "raw", "global", "model", "modelraw", "declare", "if", "elseif", "foreach", "any"]);
const bareKeywords = new Set(["endforeach", "else", "endif", "notany", "endany"]);

/** Signum's `TemplateUtils.KeywordsRegex.Matches(text)`. Hand-scanned because the `expr` group needs
 *  BALANCED brackets (`@if[Customer.Address[0]]`) and JS regexes have no balancing groups. */
export function scanKeywords(text: string): KeywordMatch[] {
    const result: KeywordMatch[] = [];
    keywordHeadRegex.lastIndex = 0;

    for (let m = keywordHeadRegex.exec(text); m != null; m = keywordHeadRegex.exec(text)) {
        const keyword = m.groups!["keyword"] ?? "";
        const hasOpen = m.groups!["open"] != undefined;

        if (hasOpen) {
            if (!bracketKeywords.has(keyword))
                continue;

            const open = m.index + m[0].length - 1; // the '[' itself
            const close = matchBracket(text, open);
            if (close < 0)
                continue; // unbalanced — let the literal text carry it, as Signum's regex would not match

            let end = close + 1;
            let dec = "";
            const as = /^\s+as\s+(\$\w*)/.exec(text.slice(end));
            if (as != null) {
                dec = as[1];
                end += as[0].length;
            }

            result.push({ index: m.index, length: end - m.index, keyword, expr: text.slice(open + 1, close), dec });
            keywordHeadRegex.lastIndex = end;
        } else {
            if (!bareKeywords.has(keyword))
                continue;

            result.push({ index: m.index, length: m[0].length, keyword, expr: "", dec: "" });
            keywordHeadRegex.lastIndex = m.index + m[0].length;
        }
    }

    return result;
}

/** The index of the `]` that closes the `[` at `open`, or -1. */
function matchBracket(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === "[") depth++;
        else if (text[i] === "]" && --depth === 0) return i;
    }
    return -1;
}

// Signum's FilterValueConverter.OperationRegex — the comparison operators a condition may use, longest
// first so `!*=` wins over `*=` and `<=` over `<`.
export const operationRegexSource = String.raw`!\^=|!\$=|!\*=|!%=|!=|\^=|\$=|\*=|%=|<=|>=|==|=|<|>`;

// Signum's TokenOperationValueRegex — `token operation value` inside an @if / @any bracket.
const tokenOperationValueRegex = new RegExp(String.raw`^(?<token>((?<type>[\w]):)?.+?) *(?<operation>(${operationRegexSource})) *(?<value>[^\]]+)$`);

// Signum's TokenFormatRegex — `token[:format]`, where the token itself may contain bracketed segments.
const tokenFormatRegex = /^(?<token>((?<type>[\w]):)?((\[[^[\]]+\])|([^[\]:]+))+)(:(?<format>.*))?$/;

export interface SplittedToken {
    token: string;
    format: string | undefined;
}

/** Signum's TemplateUtils.SplitToken. */
export function splitToken(formattedToken: string): SplittedToken | undefined {
    const tok = tokenFormatRegex.exec(formattedToken);
    if (tok == null)
        return undefined;

    const format = (tok.groups!["format"] ?? "").replace(/\\:/g, ":").replace(/\\]/g, "]");
    return { token: tok.groups!["token"], format: format === "" ? undefined : format };
}

/** Signum's TemplateUtils.ScapeColon. */
export function scapeColon(tokenOrFormat: string): string {
    return tokenOrFormat.replace(/:/g, "\\:");
}

/** Signum's FilterValueConverter.ParseOperation — the `=`/`!=`/`^=`… of an @if condition. */
export function parseOperation(operationString: string): FilterOperation {
    switch (operationString) {
        case "=":
        case "==": return FilterOperation.EqualTo;
        case "<=": return FilterOperation.LessThanOrEqual;
        case ">=": return FilterOperation.GreaterThanOrEqual;
        case "<": return FilterOperation.LessThan;
        case ">": return FilterOperation.GreaterThan;
        case "^=": return FilterOperation.StartsWith;
        case "$=": return FilterOperation.EndsWith;
        case "*=": return FilterOperation.Contains;
        case "!=": return FilterOperation.DistinctTo;
        case "!^=": return FilterOperation.NotStartsWith;
        case "!$=": return FilterOperation.NotEndsWith;
        case "!*=": return FilterOperation.NotContains;
        // altea divergence: `%=` / `!%=` (SQL LIKE) have no counterpart — altea's engine-side
        // FilterOperation has no Like/NotLike member. Use `*=` (Contains) instead.
        default: throw new Error(`Unexpected operation '${operationString}'`);
    }
}

/** Signum's FilterValueConverter.ToStringOperation — the inverse, for round-tripping a template. */
export function toStringOperation(operation: FilterOperation): string {
    switch (operation) {
        case FilterOperation.EqualTo: return "=";
        case FilterOperation.LessThanOrEqual: return "<=";
        case FilterOperation.GreaterThanOrEqual: return ">=";
        case FilterOperation.LessThan: return "<";
        case FilterOperation.GreaterThan: return ">";
        case FilterOperation.StartsWith: return "^=";
        case FilterOperation.EndsWith: return "$=";
        case FilterOperation.Contains: return "*=";
        case FilterOperation.DistinctTo: return "!=";
        case FilterOperation.NotStartsWith: return "!^=";
        case FilterOperation.NotEndsWith: return "!$=";
        case FilterOperation.NotContains: return "!*=";
        default: throw new Error(`Operation '${operation}' has no template representation`);
    }
}

/** Signum's TemplateUtils.ParseCondition — an @if / @any bracket body: `A && B`, `A OR B`, `Token op Value`
 *  or a bare truthiness test. AND/OR bind left-to-right exactly as Signum splits them (OR outermost). */
export function parseCondition(expr: string, variable: string | undefined, parser: ITemplateParser): ConditionBase {
    expr = expr.trim();

    for (const [sep, make] of [["||", ConditionOr], [" OR ", ConditionOr], ["&&", ConditionAnd], [" AND ", ConditionAnd]] as const) {
        const at = expr.indexOf(sep);
        if (at >= 0)
            return new make(
                parseCondition(expr.slice(0, at), variable, parser),
                parseCondition(expr.slice(at + sep.length), variable, parser));
    }

    const filter = tokenOperationValueRegex.exec(expr);
    if (filter == null)
        return new ConditionCompare(ValueProviderBase.tryParse(expr, variable, parser));

    const vpb = ValueProviderBase.tryParse(filter.groups!["token"], variable, parser);
    return new ConditionCompare(vpb, parseOperation(filter.groups!["operation"]), filter.groups!["value"],
        (fatal, error) => parser.addError(fatal, error));
}

/** Signum's `rows.DistinctSingle(column)` — the ONE distinct value the rows carry for that column
 *  (a token is only unambiguous inside the @foreach that groups it). */
export function distinctSingle(rows: readonly ResultRow[], column: ResultColumn): unknown {
    const distinct: unknown[] = [];
    for (const r of rows) {
        const v = column.values[r.index];
        if (!distinct.some(d => semiStructuralEquals(d, v)))
            distinct.push(v);
    }

    if (distinct.length === 0)
        throw new Error(`No values for column ${column.token.fullKey()}`);
    if (distinct.length > 1)
        throw new Error(`Multiple values for column ${column.token.fullKey()}`);

    return distinct[0];
}

/** Signum's `rows.GroupByColumn(keyColumn)` — the row groups a @foreach iterates. A single group whose key
 *  is null means "no rows" (an outer join that matched nothing), so it yields NOTHING. */
export function groupByColumn(rows: readonly ResultRow[], keyColumn: ResultColumn): ResultRow[][] {
    const keys: unknown[] = [];
    const groups: ResultRow[][] = [];

    for (const r of rows) {
        const key = keyColumn.values[r.index];
        let at = keys.findIndex(k => semiStructuralEquals(k, key));
        if (at < 0) {
            at = keys.length;
            keys.push(key);
            groups.push([]);
        }
        groups[at].push(r);
    }

    if (groups.length === 1 && keys[0] == null)
        return [];

    return groups;
}

/** Signum's SemiStructuralEqualityComparer: primitives / dates / decimals / lites / entities compare by
 *  identity-ish value; anything else compares member-by-member. */
export function semiStructuralEquals(x: unknown, y: unknown): boolean {
    if (x == null || y == null)
        return x == null && y == null;

    const sx = simpleKey(x);
    if (sx != undefined)
        return sx === simpleKey(y);

    if (typeof x !== "object" || typeof y !== "object")
        return x === y;

    const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
    for (const k of keys)
        if (!semiStructuralEquals((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]))
            return false;

    return true;
}

/** A canonical string for the value types that compare "as one thing", or undefined for a composite. */
function simpleKey(value: unknown): string | undefined {
    switch (typeof value) {
        case "string": return "s:" + value;
        case "number": return "n:" + value;
        case "boolean": return "b:" + value;
        case "bigint": return "i:" + value.toString();
    }
    if (value instanceof Lite) return "l:" + value.key();
    if (value instanceof Entity) return "e:" + (value.isNew ? "new/" + value.constructor.name + "/" + String(value.id) : value.toLite().key());
    if (value instanceof Decimal) return "d:" + value.toString();
    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime
        || value instanceof Temporal.PlainTime || value instanceof Temporal.Duration)
        return "t:" + value.toString();
    if (value instanceof Date) return "D:" + value.toISOString();
    return undefined;
}

/** One error a template parse produced (Signum's TemplateError struct). A FATAL error aborts the parse. */
export class TemplateError {
    constructor(public readonly isFatal: boolean, public readonly message: string) { }
    toString(): string { return (this.isFatal ? "FATAL: " : "ERROR: ") + this.message; }
}

/** Signum's `ScopedDictionary<K,V>` — a lexical scope chain, used for the `$var` declarations a
 *  template's blocks introduce. Kept as a tiny class since the parser leans on `previous`. */
export class ScopedDictionary<V> {
    private readonly map = new Map<string, V>();
    constructor(public readonly previous: ScopedDictionary<V> | undefined) { }

    tryGet(key: string): V | undefined {
        return this.map.has(key) ? this.map.get(key) : this.previous?.tryGet(key);
    }
    has(key: string): boolean {
        return this.map.has(key) || (this.previous?.has(key) ?? false);
    }
    /** Only THIS scope (Signum's `variables.ContainsKey` on the innermost dictionary). */
    hasOwn(key: string): boolean {
        return this.map.has(key);
    }
    add(key: string, value: V): void {
        this.map.set(key, value);
    }
    /** Every entry visible from here, innermost first (Signum's IEnumerable over the chain). */
    *entries(): Generator<[string, V]> {
        for (const e of this.map) yield e;
        if (this.previous != undefined) yield* this.previous.entries();
    }
}

/** The in-memory half of Signum's `QueryUtils.GetCompareExpression(op, left, right, inMemory: true)`:
 *  evaluate one comparison without SQL. `right` is already the parsed constant. */
export function compareInMemory(operation: FilterOperation, left: unknown, right: unknown): boolean {
    switch (operation) {
        case FilterOperation.EqualTo: return semiStructuralEquals(left, right);
        case FilterOperation.DistinctTo: return !semiStructuralEquals(left, right);
        case FilterOperation.GreaterThan: return compareValues(left, right) > 0;
        case FilterOperation.GreaterThanOrEqual: return compareValues(left, right) >= 0;
        case FilterOperation.LessThan: return compareValues(left, right) < 0;
        case FilterOperation.LessThanOrEqual: return compareValues(left, right) <= 0;
        case FilterOperation.Contains: return asText(left).includes(asText(right));
        case FilterOperation.NotContains: return !asText(left).includes(asText(right));
        case FilterOperation.StartsWith: return asText(left).startsWith(asText(right));
        case FilterOperation.NotStartsWith: return !asText(left).startsWith(asText(right));
        case FilterOperation.EndsWith: return asText(left).endsWith(asText(right));
        case FilterOperation.NotEndsWith: return !asText(left).endsWith(asText(right));
        case FilterOperation.IsIn: return Array.isArray(right) && right.some(r => semiStructuralEquals(left, r));
        case FilterOperation.IsNotIn: return !(Array.isArray(right) && right.some(r => semiStructuralEquals(left, r)));
        default: throw new Error(`FilterOperation '${operation}' is not supported in a template condition`);
    }
}

function compareValues(a: unknown, b: unknown): number {
    if (a instanceof Decimal || b instanceof Decimal)
        return new Decimal(a as Decimal.Value).comparedTo(new Decimal(b as Decimal.Value));
    if (a instanceof Temporal.PlainDate && b instanceof Temporal.PlainDate) return Temporal.PlainDate.compare(a, b);
    if (a instanceof Temporal.PlainDateTime && b instanceof Temporal.PlainDateTime) return Temporal.PlainDateTime.compare(a, b);
    if (a instanceof Temporal.PlainTime && b instanceof Temporal.PlainTime) return Temporal.PlainTime.compare(a, b);
    if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
    const [sa, sb] = [asText(a), asText(b)];
    return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function asText(value: unknown): string {
    return value == null ? "" : String(value);
}
