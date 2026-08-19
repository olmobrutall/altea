import { Entity, type BaseEntity } from "@altea/altea/data/entity";
import { Decimal, Temporal } from "@altea/altea/data/basics";
import { defaultFormat, tryGetTypeInfo, TypeReference, type FieldInfo, type TypeInfo } from "@altea/altea/data/reflection";
import { resolveCleanType, resolveEnum, resolveType } from "@altea/altea/data/registration";
import { Localization } from "@altea/altea/data/utils/localization";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { Clock } from "@altea/altea/data/utils/clock";
import { Enum } from "@altea/altea/data/enum";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { SubTokensOptions, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { FilterOperation } from "@altea/altea/server/dynamicQuery/requests";
import type { ResultColumn, ResultRow, ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { TemplateTokenMessage } from "../data/Templating";
import { distinctSingle, groupByColumn, scapeColon, ScopedDictionary } from "./TemplateUtils.server";

// Port of Signum.Templating's ValueProviders.cs — everything a `@[…]` bracket can name:
//
//   `@[Customer.Name]`   the QUERY (implicit)     → TokenValueProvider
//   `@[q:Customer.Name]` the QUERY (explicit)     → TokenValueProvider
//   `@[m:ShortAddress]`  the MODEL                → ModelValueProvider
//   `@[g:Now]`           a GLOBAL variable        → GlobalValueProvider
//   `@[n:Order.State]`   a NICE NAME              → NiceNameValueProvider
//   `@[d:…]`             a DATE expression        → DateValueProvider
//   `@[$line.Product]`   a $variable's member     → ContinueValueProvider
//   `@[42]` / `@["x"]`   a constant               → ConstantValueProvider
//
// altea divergences, documented inline:
//  - `QueryDescription` is GONE (altea resolves tokens from registered entity metadata): a parser carries
//    the QUERY NAME and `ParsedToken` resolves through `QueryLogic.getToken`. NOTE that resolution is
//    CASE-SENSITIVE (altea walks reflected member names), so a stored token must match exactly.
//  - `TranslateInstanceValueProvider` (`@[t:…]`) is NOT ported: it needs Signum's
//    PropertyRouteTranslationLogic (per-instance translated fields), which altea has no counterpart for.
//    `t:` therefore reports an error at parse time rather than silently falling back.
//  - `CollectionNestedToken` (Signum's sub-query context inside a QueryContext) has no altea token, so
//    QueryContext is FLAT — one ResultTable, no `SubQueryContext` map. `@foreach` over `…Element` works
//    the same; nested sub-queries are simply not expressible.
//  - `QueryTokenOrRowId` (Signum grouped a @foreach by the MList row's RowId so two rows with equal values
//    stay distinct) has no altea counterpart yet (MListElementPropertyToken is a token-layer TODO); the
//    foreach groups by the token's own value, which is what Signum does for every non-MList collection.
//  - `Synchronize` is dropped with the sync pass (see TemplateUtils' header).
//  - `Reflector.FormatString(type)` → the field's `@format`, read off the TypeReference when there is one.

/** Signum's ITemplateParser — what a value provider needs from the parse in progress. */
export interface ITemplateParser {
    /** The MODEL type (a reflected entity/model ctor) this template is written against, if any. */
    readonly modelType: Function | undefined;
    /** The QUERY this template is written against, if any (Signum's QueryDescription). */
    readonly queryName: QueryName | undefined;
    assertQueryName(action: string): QueryName;
    readonly variables: ScopedDictionary<ValueProviderBase>;
    addError(fatal: boolean, error: string): void;
}

/** Signum's TemplateParameters — the RUNTIME side: the entity / culture / query rows a print runs over. */
export abstract class TemplateParameters {
    constructor(
        public readonly entity: Entity | null,
        public readonly culture: string,
        public readonly queryContext: QueryContext | undefined,
    ) { }

    runtimeVariables: ScopedDictionary<unknown> = new ScopedDictionary<unknown>(undefined);

    abstract getModel(): object;

    /** Signum's `p.Scope()` — a nested runtime-variable scope for one @foreach iteration. */
    scope(): Disposable {
        const old = this.runtimeVariables;
        this.runtimeVariables = new ScopedDictionary<unknown>(old);
        return { [Symbol.dispose]: () => { this.runtimeVariables = old; } };
    }
}

/** Signum's QueryContext — the executed query's rows, plus the "which rows am I looking at right now"
 *  window that @foreach / @any narrow. altea divergence: FLAT (no CollectionNestedToken sub-queries). */
export class QueryContext {
    readonly resultColumns = new Map<string, ResultColumn>();
    private rows: readonly ResultRow[];

    constructor(public readonly queryName: QueryName, public readonly resultTable: ResultTable) {
        for (const c of resultTable.columns)
            this.resultColumns.set(c.token.fullKey(), c);
        if (resultTable.entityColumn != undefined)
            this.resultColumns.set(resultTable.entityColumn.token.fullKey(), resultTable.entityColumn);

        this.rows = resultTable.rows;
    }

    get currentRows(): readonly ResultRow[] { return this.rows; }

    column(token: QueryToken): ResultColumn {
        const c = this.resultColumns.get(token.fullKey());
        if (c == undefined)
            throw new Error(`No column for token '${token.fullKey()}' in the executed query — the template's tokens and the query's columns disagree`);
        return c;
    }

    /** Signum's `OverrideRows` — narrow to one @foreach group / @any's filtered rows for the block's body. */
    overrideRows(rows: readonly ResultRow[]): Disposable {
        const old = this.rows;
        this.rows = rows;
        return { [Symbol.dispose]: () => { this.rows = old; } };
    }
}

// ---- ValueProviderBase ------------------------------------------------------------------------------------

export abstract class ValueProviderBase {
    /** The `$name` this provider was declared as (`@[X] as $x`), if any. */
    variable: string | undefined;

    /** True when the provider is the subject of a @foreach (so `$var` yields an ELEMENT, not the collection). */
    isForeach: boolean = false;

    abstract getValue(p: TemplateParameters): unknown;

    abstract get format(): string | undefined;

    /** The static type this provider yields, when it is known (used to parse a comparison's constant). */
    abstract get type(): TypeReference | undefined;

    abstract equalsProvider(other: ValueProviderBase): boolean;

    /** Every query token this provider needs in the executed query (Signum's FillQueryTokens). */
    abstract fillQueryTokens(list: QueryToken[], forForeach: boolean): void;

    /** The bracket BODY, as it should be written back out (Signum's ToStringInternal). */
    abstract toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void;

    toStringWithoutBrackets(variables: ScopedDictionary<ValueProviderBase>): string {
        const sb: string[] = [];
        this.toStringInternal(sb, variables);
        return sb.join("");
    }

    toStringBrackets(sb: string[], variables: ScopedDictionary<ValueProviderBase>, format: string | undefined): void {
        sb.push("[");
        this.toStringInternal(sb, variables);
        if (format != undefined && format !== "")
            sb.push(format);
        sb.push("]");
        if (this.variable != undefined && this.variable !== "")
            sb.push(" as " + this.variable);
    }

    toString(): string {
        const sb: string[] = [];
        this.toStringBrackets(sb, new ScopedDictionary<ValueProviderBase>(undefined), undefined);
        return sb.join("");
    }

    /** Signum's Declare — publish this provider's `$name` into the scope. */
    declare(variables: ScopedDictionary<ValueProviderBase>): void {
        if (this.variable == undefined || this.variable === "")
            return;

        const already = variables.tryGet(this.variable);
        if (already != undefined) {
            if (already.equalsProvider(this))
                return;
            throw new Error("Redeclaring variable " + this.variable + " with another value");
        }

        variables.add(this.variable, this);
    }

    /** Signum's Foreach — iterate this provider's collection, running `forEachElement` per item. */
    foreach(p: TemplateParameters, forEachElement: () => void): void {
        const collection = this.getValue(p) as Iterable<unknown> | null | undefined;
        if (collection == null)
            return;

        for (const item of collection) {
            using _ = p.scope();
            if (this.variable != undefined)
                p.runtimeVariables.add(this.variable, item);
            forEachElement();
        }
    }

    // Signum's TypeTokenRegex — the optional one-letter provider prefix.
    private static readonly typeTokenRegex = /^(?:(?<type>[\w]):)?(?<token>[\s\S]*)$/;

    /** Signum's ValueProviderBase.TryParse — the bracket body → a provider. */
    static tryParse(typeToken: string, variable: string | undefined, tp: ITemplateParser): ValueProviderBase | undefined {
        const match = ValueProviderBase.typeTokenRegex.exec(typeToken)!;
        const type = match.groups!["type"] ?? "";
        const token = match.groups!["token"];

        const assertNoCollectionToken = (pt: ParsedToken): void => {
            // Signum's `QueryToken.IsCollection(token.Type)` — does this token's VALUE hold many rows?
            // NOT `isCollectionToken()`, which asks the opposite-ish question ("is this a collection
            // BOUNDARY token", i.e. Element / AnyAll / Nested). Using that inverted the rule: it accepted
            // `@[details]` (a raw collection, unprintable) and rejected `@[details.Element]` (the correct
            // form). Found by rendering a real `@foreach[details.Element]` template end to end.
            if (pt.queryToken != undefined && pt.queryToken.type?.array === true)
                tp.addError(false, `@[${typeToken}] is a collection, missing 'Element' token at the end`);
        };

        switch (type) {
            case "": {
                if (token.startsWith("$")) {
                    const v = beforeDot(token) ?? token;
                    const vp = tp.variables.tryGet(v);
                    if (vp == undefined) {
                        tp.addError(false, `Variable '${v}' is not defined at this scope`);
                        return undefined;
                    }
                    if (!(vp instanceof TokenValueProvider))
                        return assign(new ContinueValueProvider(afterDot(token), vp, tp), variable);
                }

                const constant = ConstantValueProvider.tryParseConstantValue(token);
                if (constant !== notAConstant)
                    return assign(new ConstantValueProvider(constant), variable);

                const result = ParsedToken.tryParseToken(token,
                    SubTokensOptions.CanElement | SubTokensOptions.CanToArray,
                    tp.assertQueryName("parse " + token), tp.variables, (f, e) => tp.addError(f, e));
                assertNoCollectionToken(result);
                return assign(new TokenValueProvider(result, false), variable);
            }
            case "q": {
                const result = ParsedToken.tryParseToken(token,
                    SubTokensOptions.CanElement | SubTokensOptions.CanToArray,
                    tp.assertQueryName("parse " + token), tp.variables, (f, e) => tp.addError(f, e));
                assertNoCollectionToken(result);
                return assign(new TokenValueProvider(result, true), variable);
            }
            case "t":
                // See the header: no PropertyRouteTranslationLogic in altea.
                tp.addError(false, "The 't:' (translate instance) value provider is not supported in altea");
                return undefined;
            case "m":
                return assign(new ModelValueProvider(token, tp.modelType, tp), variable);
            case "g":
                return assign(new GlobalValueProvider(token, tp), variable);
            case "d":
                return assign(new DateValueProvider(token, tp), variable);
            case "n":
                return assign(new NiceNameValueProvider(token, tp.modelType, tp), variable);
            default:
                tp.addError(false, `${type} is not a recognized value provider (q:Query, m:Model, g:Global, n:NiceName, d:Date or just blank)`);
                return undefined;
        }
    }

    /** Signum's ValidateConditionValue — can this comparison's right-hand text be read as my type? */
    validateConditionValue(valueString: string, operation: FilterOperation | undefined, addError: (fatal: boolean, error: string) => void): void {
        const type = this.type;
        if (type == undefined)
            return;

        try {
            parseConstant(valueString, type, operation === FilterOperation.IsIn || operation === FilterOperation.IsNotIn);
        } catch (e) {
            addError(false, `Impossible to convert '${valueString}' to ${type.getTypeName()}: ${(e as Error).message}`);
        }
    }
}

function assign<T extends ValueProviderBase>(vp: T, variable: string | undefined): T {
    vp.variable = variable === "" ? undefined : variable;
    return vp;
}

// ---- ParsedToken ----------------------------------------------------------------------------------------

/** Signum's ParsedToken — the token STRING plus (once it resolves) the QueryToken behind it. */
export class ParsedToken {
    queryToken: QueryToken | undefined;

    constructor(public tokenString: string, public readonly queryName: QueryName) { }

    static tryParseToken(
        tokenString: string,
        options: SubTokensOptions,
        queryName: QueryName,
        variables: ScopedDictionary<ValueProviderBase>,
        addError: (fatal: boolean, error: string) => void,
    ): ParsedToken {
        const result = new ParsedToken(tokenString, queryName);
        const errorCtx = `Parsing '${tokenString}': `;

        if (tokenString.startsWith("$")) {
            const v = beforeDot(tokenString) ?? tokenString;
            const vp = variables.tryGet(v);
            if (vp == undefined) {
                addError(false, errorCtx + `Variable '${v}' is not defined at this scope`);
                return result;
            }
            if (!(vp instanceof TokenValueProvider)) {
                addError(false, errorCtx + `Variable '${v}' is not a token`);
                return result;
            }
            if (vp.parsedToken.queryToken == undefined) {
                addError(false, errorCtx + `Variable '${v}' is not correctly parsed`);
                return result;
            }

            const after = afterDot(tokenString);
            tokenString = vp.parsedToken.queryToken.fullKey() + (after == undefined ? "" : "." + after);
        }

        try {
            result.queryToken = QueryLogic.getToken(queryName, tokenString, options);
        } catch (e) {
            addError(false, errorCtx + (e as Error).message);
        }
        return result;
    }

    /** Signum's SimplifyToken — write a token back using the SHORTEST `$var` prefix that covers it. */
    simplifyToken(variables: ScopedDictionary<ValueProviderBase>, token: string): string {
        let best: { key: string; fullKey: string } | undefined;

        for (const [key, value] of variables.entries()) {
            if (!(value instanceof TokenValueProvider) || value.parsedToken.queryToken == undefined)
                continue;
            const fullKey = value.parsedToken.queryToken.fullKey();
            if (token !== fullKey && !token.startsWith(fullKey + "."))
                continue;
            if (best == undefined || fullKey.length > best.fullKey.length)
                best = { key, fullKey };
        }

        return best == undefined ? token : best.key + token.slice(best.fullKey.length);
    }

    stringify(variables: ScopedDictionary<ValueProviderBase>): string {
        return this.queryToken == undefined ? this.tokenString
            : this.simplifyToken(variables, this.queryToken.fullKey());
    }

    equalsToken(other: ParsedToken): boolean {
        return other.tokenString === this.tokenString
            && (other.queryToken?.fullKey() ?? null) === (this.queryToken?.fullKey() ?? null);
    }
}

// ---- TokenValueProvider (`@[Entity.UserName]` / `@[q:Entity.UserName]`) ---------------------------------

export class TokenValueProvider extends ValueProviderBase {
    constructor(public readonly parsedToken: ParsedToken, public readonly isExplicit: boolean) { super(); }

    override getValue(p: TemplateParameters): unknown {
        const qc = p.queryContext!;
        if (qc.currentRows.length === 0)
            return null;

        const value = distinctSingle(qc.currentRows, qc.column(this.parsedToken.queryToken!));

        // A `…ToArray` token yields the whole collection; join it the way Signum's CollectionToArrayToken does.
        if (this.parsedToken.queryToken!.isToArray()) {
            const array = (value ?? []) as unknown[];
            const separator = this.parsedToken.queryToken!.key.includes("NewLine") ? "\n" : ", ";
            return array.join(separator);
        }

        return value;
    }

    override foreach(p: TemplateParameters, forEachElement: () => void): void {
        const qc = p.queryContext!;
        const col = qc.column(this.parsedToken.queryToken!);

        for (const group of groupByColumn(qc.currentRows, col)) {
            using _1 = p.scope();
            using _2 = qc.overrideRows(group);
            forEachElement();
        }
    }

    override get format(): string | undefined { return this.parsedToken.queryToken?.format; }

    override get type(): TypeReference | undefined { return this.parsedToken.queryToken?.type; }

    override fillQueryTokens(list: QueryToken[], _forForeach: boolean): void {
        list.push(this.parsedToken.queryToken!);
    }

    override toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        if (this.isExplicit)
            sb.push("q:");
        sb.push(this.parsedToken.stringify(variables));
    }

    override equalsProvider(other: ValueProviderBase): boolean {
        return other instanceof TokenValueProvider && other.parsedToken.equalsToken(this.parsedToken);
    }
}

// ---- Member chains (`@[m:A.B(C)]`, `@[g:Now.Year]`, `@[$line.Product]`) ----------------------------------

/** Signum's MemberWithArguments — one step of a member chain: a property/field/method NAME, with the
 *  argument providers when it is a method call. */
export class MemberWithArguments {
    constructor(public readonly member: string, public readonly args: ValueProviderBase[] | undefined) { }

    stringify(variables: ScopedDictionary<ValueProviderBase>): string {
        return this.member + (this.args == undefined ? ""
            : "(" + this.args.map(a => a.toStringWithoutBrackets(variables)).join(", ") + ")");
    }
}

const parenthesisRegex = /\([^)]*\)/g;

/** Signum's ParsedModel.GetMembers — split `A.B(x, y).C` into member steps, validating each against the
 *  reflected type when one is known.
 *
 *  altea divergence: C# resolved every step through reflection (and REQUIRED a method's last parameter to
 *  be TemplateParameters). TS has no runtime member table for plain classes, so validation uses altea's
 *  reflected FieldInfos when the step's owner is a reflected entity and otherwise accepts the name; a
 *  method is called with its arguments followed by the TemplateParameters, exactly as Signum does. */
export function getMembers(fieldOrPropertyChain: string | undefined, tp: ITemplateParser): MemberWithArguments[] | undefined {
    const members: MemberWithArguments[] = [];
    const parens: string[] = [];
    const replaced = (fieldOrPropertyChain ?? "").trim().replace(parenthesisRegex, a => {
        parens.push(a);
        return `($$${parens.length - 1}$$)`;
    });

    for (const part of replaced.split(".").filter(p => p.length > 0)) {
        if (part.endsWith("$$)")) {
            const index = Number(part.slice(part.indexOf("($$") + 3, part.lastIndexOf("$$)")));
            const parameterString = parens[index];
            const argStrings = parameterString.slice(1, -1).split(",").map(a => a.trim()).filter(a => a.length > 0);
            const args = argStrings.map(a => ValueProviderBase.tryParse(a, undefined, tp));
            if (args.some(a => a == undefined))
                return undefined;

            members.push(new MemberWithArguments(part.slice(0, part.indexOf("($$")).trim(), args as ValueProviderBase[]));
        } else {
            members.push(new MemberWithArguments(part, undefined));
        }
    }

    return members;
}

/** Signum's ModelValueProvider.Getter — read one member step off a value. A method step receives its
 *  arguments plus the TemplateParameters (Signum's convention), so a model can format with the culture. */
export function getter(mwa: MemberWithArguments, target: object, p: TemplateParameters): unknown {
    const value = (target as Record<string, unknown>)[mwa.member];

    if (typeof value === "function") {
        const args = (mwa.args ?? []).map(a => a.getValue(p));
        return (value as (...a: unknown[]) => unknown).apply(target, [...args, p]);
    }

    if (mwa.args != undefined)
        throw new Error(`'${mwa.member}' is not a method on ${target.constructor.name}`);

    return value;
}

/** Walk a member chain over a starting value, stopping at the first null (Signum's loop). A chain that
 *  never RESOLVED (the parse reported an error for it) is not walkable — say so, instead of failing deep
 *  inside the loop the way Signum's `Members!` would. */
function walk(members: readonly MemberWithArguments[] | undefined, start: unknown, p: TemplateParameters, what?: string): unknown {
    if (members == undefined)
        throw new Error(`Cannot read '${what ?? "the member chain"}': it did not resolve when the template was parsed`);

    let value = start;
    for (const m of members) {
        if (value == null)
            return null;
        value = getter(m, value as object, p);
    }
    return value;
}

/** The declared TypeReference of the LAST step of a member chain, when the chain starts at a reflected
 *  type and every step is a reflected FIELD. Otherwise undefined — a template can still print it, it just
 *  cannot type-check a comparison's constant against it. */
function chainType(startType: Function | undefined, members: readonly MemberWithArguments[]): TypeReference | undefined {
    let current = startType;
    let result: TypeReference | undefined;

    for (const m of members) {
        if (current == undefined || m.args != undefined)
            return undefined;
        const ti = tryGetTypeInfo(current);
        const fi = ti?.members?.[m.member];
        if (fi == undefined)
            return undefined;
        result = fi;
        current = fi.getFunction();
    }

    return result;
}

// ---- ModelValueProvider (`@[m:CurrentCode]`) ------------------------------------------------------------

export class ModelValueProvider extends ValueProviderBase {
    private members: MemberWithArguments[] | undefined;

    constructor(private fieldOrPropertyChain: string, private readonly modelType: Function | undefined, tp: ITemplateParser) {
        super();
        if (modelType == undefined) {
            tp.addError(false, TemplateTokenMessage.ImpossibleToAccess0BecauseTheTemplateHAsNo1.niceToString(fieldOrPropertyChain, "Model"));
            return;
        }
        this.members = getMembers(fieldOrPropertyChain, tp);
    }

    override getValue(p: TemplateParameters): unknown {
        return walk(this.members, p.getModel(), p, "m:" + this.fieldOrPropertyChain);
    }

    override get format(): string | undefined { return formatOf(this.type); }

    override get type(): TypeReference | undefined {
        return this.members == undefined ? undefined : chainType(this.modelType, this.members);
    }

    override fillQueryTokens(list: QueryToken[], _forForeach: boolean): void {
        for (const m of this.members ?? [])
            for (const a of m.args ?? [])
                a.fillQueryTokens(list, false);
    }

    override toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("m:");
        sb.push(this.members == undefined ? this.fieldOrPropertyChain : this.members.map(a => a.stringify(variables)).join("."));
    }

    override equalsProvider(other: ValueProviderBase): boolean {
        return other instanceof ModelValueProvider && other.fieldOrPropertyChain === this.fieldOrPropertyChain;
    }
}

// ---- NiceNameValueProvider (`@[n:Order.State]`) ---------------------------------------------------------

/** Signum's NiceNameValueProvider — print a TRANSLATED name rather than a value: a type's nice name, a
 *  property's nice name, or an enum member's nice name.
 *
 *  altea divergence: Signum walked C# reflection from the model type (plus its [ExportNiceNames] aliases).
 *  altea resolves the chain against its own TypeInfo/FieldInfo registry, and accepts a leading TYPE NAME
 *  as well as a model member — so `@[n:OrderEntity.State]` works without an alias attribute. */
export class NiceNameValueProvider extends ValueProviderBase {
    private resolved: (() => string) | undefined;

    constructor(private readonly fieldOrMessageChain: string, modelType: Function | undefined, tp: ITemplateParser) {
        super();
        const parts = fieldOrMessageChain.split(".");

        // The chain's ROOT: a member of the model, or a registered type name.
        let currentType: Function | undefined;
        if (modelType != undefined) {
            const fi = tryGetTypeInfo(modelType)?.members?.[parts[0]];
            currentType = fi?.getFunction();
        }
        currentType ??= tryResolveTypeByName(parts[0]);

        if (currentType == undefined) {
            tp.addError(false, `Type '${modelType?.name ?? "?"}' does not have a property or field with name '${parts[0]}', and '${parts[0]}' is not a registered type name`);
            return;
        }

        if (parts.length === 1) {
            const ctor = currentType;
            this.resolved = () => Localization.niceName(ctor);
            return;
        }

        let ctor: Function | undefined = currentType;
        for (let i = 1; i < parts.length; i++) {
            const ti: TypeInfo | undefined = ctor == undefined ? undefined : tryGetTypeInfo(ctor);
            const fi: FieldInfo | undefined = ti?.members?.[parts[i]];
            const enumObj = ctor == undefined ? undefined : (ctor as unknown as object);

            if (fi != undefined) {
                if (i === parts.length - 1) {
                    const owner = ctor!;
                    const name = parts[i];
                    this.resolved = () => Localization.memberNiceName(owner.name, name) ?? Localization.niceMemberName(name);
                    return;
                }
                ctor = fi.getFunction();
                continue;
            }

            // An enum MEMBER (`@[n:OrderState.Shipped]`) — the last step off an enum object.
            if (i === parts.length - 1 && enumObj != undefined && parts[i] in enumObj) {
                const e = enumObj as Record<string, unknown>;
                const member = parts[i];
                this.resolved = () => Enum.niceName(e as never, e[member] as never);
                return;
            }

            tp.addError(false, `'${parts.slice(0, i).join(".")}' does not have a property/field with name '${parts[i]}'`);
            return;
        }
    }

    override getValue(_p: TemplateParameters): unknown {
        if (this.resolved == undefined)
            return `Error getting ${this.fieldOrMessageChain}`;
        try {
            return this.resolved();
        } catch (e) {
            return `Error getting ${this.fieldOrMessageChain}: ${(e as Error).message}`;
        }
    }

    override get type(): TypeReference | undefined { return new TypeReference({ typeName: "String" }); }
    override get format(): string | undefined { return undefined; }

    override fillQueryTokens(_list: QueryToken[], _forForeach: boolean): void { }

    override toStringInternal(sb: string[], _variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("n:");
        sb.push(this.fieldOrMessageChain);
    }

    override equalsProvider(other: ValueProviderBase): boolean {
        return other instanceof NiceNameValueProvider && other.fieldOrMessageChain === this.fieldOrMessageChain;
    }
}

// ---- GlobalValueProvider (`@[g:Now]`) -------------------------------------------------------------------

/** One `@[g:Key]` variable: how to read it, what it yields, how to format it. */
export interface GlobalVariable {
    getValue: (p: TemplateParameters) => unknown;
    type: TypeReference;
    format?: string;
}

export class GlobalValueProvider extends ValueProviderBase {
    /** Signum's `GlobalValueProvider.GlobalVariables` — the process-wide registry. */
    static readonly globalVariables = new Map<string, GlobalVariable>();

    /** Signum's RegisterGlobalVariable. */
    static registerGlobalVariable(key: string, getValue: (p: TemplateParameters) => unknown, type: TypeReference, format?: string): void {
        GlobalValueProvider.globalVariables.set(key, { getValue, type, format });
    }

    private globalKey: string;
    private remainingFieldsOrProperties: string | undefined;
    private members: MemberWithArguments[] | undefined;

    constructor(fieldOrPropertyChain: string, tp: ITemplateParser) {
        super();
        this.globalKey = beforeDot(fieldOrPropertyChain) ?? fieldOrPropertyChain;
        this.remainingFieldsOrProperties = afterDot(fieldOrPropertyChain);

        const gv = GlobalValueProvider.globalVariables.get(this.globalKey);
        if (gv == undefined)
            tp.addError(false, `The global key ${this.globalKey} was not found`);

        if (this.remainingFieldsOrProperties != undefined && gv != undefined)
            this.members = getMembers(this.remainingFieldsOrProperties, tp);
    }

    override getValue(p: TemplateParameters): unknown {
        const gv = GlobalValueProvider.globalVariables.get(this.globalKey);
        if (gv == undefined)
            return null;

        const value = gv.getValue(p);
        return this.members == undefined ? value : walk(this.members, value, p, "g:" + this.globalKey);
    }

    override get format(): string | undefined {
        const gv = GlobalValueProvider.globalVariables.get(this.globalKey);
        return this.members == undefined ? gv?.format ?? formatOf(this.type) : formatOf(this.type);
    }

    override get type(): TypeReference | undefined {
        const gv = GlobalValueProvider.globalVariables.get(this.globalKey);
        if (this.remainingFieldsOrProperties == undefined || this.remainingFieldsOrProperties === "")
            return gv?.type;
        return this.members == undefined ? undefined : chainType(gv?.type.getFunction(), this.members);
    }

    override fillQueryTokens(list: QueryToken[], _forForeach: boolean): void {
        for (const m of this.members ?? [])
            for (const a of m.args ?? [])
                a.fillQueryTokens(list, false);
    }

    override toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("g:");
        sb.push(this.globalKey);
        if (this.remainingFieldsOrProperties != undefined && this.remainingFieldsOrProperties !== "") {
            sb.push(".");
            sb.push(this.members == undefined ? this.remainingFieldsOrProperties : this.members.map(a => a.stringify(variables)).join("."));
        }
    }

    override equalsProvider(other: ValueProviderBase): boolean {
        return other instanceof GlobalValueProvider
            && other.globalKey === this.globalKey
            && other.remainingFieldsOrProperties === this.remainingFieldsOrProperties;
    }
}

// ---- DateValueProvider (`@[d:2020-01-01]`) --------------------------------------------------------------

/** Signum's DateValueProvider — a literal or "now" date. altea divergence: Signum parsed its
 *  SmartDateTime grammar (`yyyy/mm/-1 00:00:00`); altea has not ported that grammar, so the expression is
 *  an ISO PlainDateTime (empty ⇒ `Clock.now`). */
export class DateValueProvider extends ValueProviderBase {
    private dateTimeExpression: string | undefined;

    constructor(dateTimeExpression: string, tp: ITemplateParser) {
        super();
        this.dateTimeExpression = dateTimeExpression === "" ? undefined : dateTimeExpression;
        try {
            this.getValue(null!);
        } catch (e) {
            tp.addError(false, `Invalid expression ${dateTimeExpression}: ${(e as Error).message}`);
        }
    }

    override get type(): TypeReference | undefined { return new TypeReference({ typeName: "PlainDateTime", isNullable: true }); }

    override getValue(_p: TemplateParameters): unknown {
        return this.dateTimeExpression == undefined ? Clock.now : Temporal.PlainDateTime.from(this.dateTimeExpression);
    }

    override fillQueryTokens(_list: QueryToken[], _forForeach: boolean): void { }

    override toStringInternal(sb: string[], _variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("d:");
        sb.push(scapeColon(this.dateTimeExpression ?? ""));
    }

    override get format(): string | undefined { return "G"; }

    override equalsProvider(other: ValueProviderBase): boolean {
        return other instanceof DateValueProvider && other.dateTimeExpression === this.dateTimeExpression;
    }
}

// ---- ConstantValueProvider (`@[42]`, `@["text"]`, `@[null]`) --------------------------------------------

/** The "this is not a constant" sentinel (C# used a `bool TryParse` + `out`). */
const notAConstant = Symbol("notAConstant");

export class ConstantValueProvider extends ValueProviderBase {
    constructor(public readonly value: unknown) { super(); }

    /** Signum's TryParseConstantValue. Returns `notAConstant` when the text is not a literal. */
    static tryParseConstantValue(valueExpression: string): unknown {
        if (valueExpression.toLowerCase() === "null")
            return null;

        if (/^[+-]?\d+$/.test(valueExpression))
            return Number(valueExpression);

        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(valueExpression))
            return new Decimal(valueExpression);

        if (valueExpression.length >= 2
            && ((valueExpression.startsWith('"') && valueExpression.endsWith('"'))
                || (valueExpression.startsWith("'") && valueExpression.endsWith("'"))))
            return valueExpression.slice(1, -1);

        return notAConstant;
    }

    override get type(): TypeReference | undefined {
        return typeof this.value === "number" ? new TypeReference({ typeName: "Number" })
            : this.value instanceof Decimal ? new TypeReference({ typeName: "Decimal" })
                : typeof this.value === "string" ? new TypeReference({ typeName: "String" })
                    : undefined;
    }

    override getValue(_p: TemplateParameters): unknown { return this.value; }

    override fillQueryTokens(_list: QueryToken[], _forForeach: boolean): void { }

    override toStringInternal(sb: string[], _variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push(this.value == null ? "null"
            : typeof this.value === "number" ? String(this.value)
                : this.value instanceof Decimal ? this.value.toString()
                    : typeof this.value === "string" ? `"${this.value}"`
                        : String(this.value));
    }

    override get format(): string | undefined { return undefined; }

    override equalsProvider(other: ValueProviderBase): boolean {
        return other instanceof ConstantValueProvider && other.value === this.value;
    }
}

// ---- ContinueValueProvider (`@[$line.Product]` inside `@foreach[m:Lines] as $line`) ---------------------

export class ContinueValueProvider extends ValueProviderBase {
    private members: MemberWithArguments[] | undefined;

    constructor(private fieldOrPropertyChain: string | undefined, private readonly parent: ValueProviderBase, tp: ITemplateParser) {
        super();
        this.members = getMembers(fieldOrPropertyChain, tp);
    }

    private parentType(): Function | undefined {
        const t = this.parent.type;
        if (t == undefined)
            return undefined;
        // A @foreach's provider yields the COLLECTION; a `$var` off it is one ELEMENT.
        return t.getFunction();
    }

    override getValue(p: TemplateParameters): unknown {
        const variable = this.parent.variable!;
        if (!p.runtimeVariables.has(variable))
            throw new Error(`Variable ${variable} not found`);

        return walk(this.members, p.runtimeVariables.tryGet(variable), p, variable + "." + (this.fieldOrPropertyChain ?? ""));
    }

    override get format(): string | undefined { return formatOf(this.type); }

    override get type(): TypeReference | undefined {
        if (this.members == undefined || this.members.length === 0)
            return this.parent.type;
        return chainType(this.parentType(), this.members);
    }

    override fillQueryTokens(list: QueryToken[], _forForeach: boolean): void {
        for (const m of this.members ?? [])
            for (const a of m.args ?? [])
                a.fillQueryTokens(list, false);
    }

    override toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push(this.parent.variable ?? "");
        sb.push(".");
        sb.push(this.members == undefined ? this.fieldOrPropertyChain ?? "" : this.members.map(a => a.stringify(variables)).join("."));
    }

    override equalsProvider(other: ValueProviderBase): boolean {
        return other instanceof ContinueValueProvider
            && other.fieldOrPropertyChain === this.fieldOrPropertyChain
            && other.parent.equalsProvider(this.parent);
    }
}

// ---- constant parsing (Signum's FilterValueConverter.Parse) ---------------------------------------------

/** Parse a template comparison's right-hand TEXT into a value of `type` (Signum's
 *  `FilterValueConverter.Parse(value, type, isList)`; `|` separates a list). */
export function parseConstant(valueString: string, type: TypeReference, isList: boolean): unknown {
    if (isList)
        return valueString.split("|").map(v => parseConstant(v.trim(), type, false));

    if (valueString === "")
        return null;

    const e = type.getEnum();
    if (e != undefined) {
        // altea enums: the WIRE / template form is the member NAME, the in-memory value the ordinal.
        const value = (e as Record<string, unknown>)[valueString];
        if (value == undefined)
            throw new Error(`'${valueString}' is not a member of ${type.getTypeName()}`);
        return value;
    }

    switch (type.typeName) {
        case "Boolean": return valueString.toLowerCase() === "true";
        case "Number": return Number(valueString);
        case "Decimal": return new Decimal(valueString);
        case "PlainDate": return Temporal.PlainDate.from(valueString);
        case "PlainDateTime": return Temporal.PlainDateTime.from(valueString);
        case "PlainTime": return Temporal.PlainTime.from(valueString);
        case "Duration": return Temporal.Duration.from(valueString);
        default: return valueString;
    }
}

// ---- small helpers --------------------------------------------------------------------------------------

function beforeDot(s: string): string | undefined {
    const at = s.indexOf(".");
    return at < 0 ? undefined : s.slice(0, at);
}

function afterDot(s: string): string | undefined {
    const at = s.indexOf(".");
    return at < 0 ? undefined : s.slice(at + 1);
}

/** A registered entity/model/enum type by its (clean or class) name — the root of an `@[n:…]` chain.
 *  An ENUM resolves to its object, which is not a Function; the caller treats it as an enum container. */
function tryResolveTypeByName(name: string): Function | undefined {
    return resolveType(name)
        ?? resolveCleanType(name)
        ?? (resolveEnum(name) as Function | undefined);
}

/** Signum's `Reflector.FormatString(type)` — the explicit `@format` when the reference is a reflected
 *  FieldInfo, else the value type's default (a decimal's "N2"). */
export function formatOf(tr: TypeReference | undefined): string | undefined {
    return (tr as FieldInfo | undefined)?.format ?? defaultFormat(tr);
}

/** Print a value the way a template should (Signum's ValueNode.PrintList formatting rules). */
export function formatTemplateValue(value: unknown, format: string | undefined, culture: string, type: TypeReference | undefined): string {
    if (value == null)
        return "";

    const e = type?.getEnum();
    if (e != undefined)
        return Enum.niceName(e as never, value as never);

    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime || value instanceof Temporal.PlainTime)
        return formatTemporal(value, format, culture);

    if (value instanceof Decimal)
        return formatDecimal(value, format, culture);

    if (typeof value === "number")
        return formatDecimal(new Decimal(value), format, culture);

    if (value instanceof Entity)
        return (value as BaseEntity).toString();

    return String(value);
}

function formatTemporal(value: Temporal.PlainDate | Temporal.PlainDateTime | Temporal.PlainTime, format: string | undefined, culture: string): string {
    const loc = culture === "" ? undefined : culture;
    switch (format) {
        case "d": return value.toLocaleString(loc, { dateStyle: "short" });
        case "D": return value.toLocaleString(loc, { dateStyle: "long" });
        case "t": return value.toLocaleString(loc, { timeStyle: "short" });
        case "T": return value.toLocaleString(loc, { timeStyle: "medium" });
        case "G": return value.toLocaleString(loc, { dateStyle: "short", timeStyle: "medium" });
        case "g": return value.toLocaleString(loc, { dateStyle: "short", timeStyle: "short" });
        default: return value.toLocaleString(loc);
    }
}

// Signum leaned on .NET numeric format strings; altea supports the subset its own UI does: "N<digits>" /
// "C<digits>" / "P<digits>" / a plain digit count, and falls back to the culture's default.
function formatDecimal(value: Decimal, format: string | undefined, culture: string): string {
    const loc = culture === "" ? CultureInfo.currentCulture() : culture;
    const num = value.toNumber();

    if (format != undefined) {
        const m = /^([NCPncp]?)(\d*)$/.exec(format);
        if (m != null) {
            const digits = m[2] === "" ? undefined : Number(m[2]);
            const style = m[1].toUpperCase();
            const options: Intl.NumberFormatOptions = {
                minimumFractionDigits: digits,
                maximumFractionDigits: digits,
            };
            if (style === "P") options.style = "percent";
            return new Intl.NumberFormat(loc, options).format(num);
        }
    }

    return new Intl.NumberFormat(loc).format(num);
}

/** Re-exported so callers do not need the query-name helper's own module. */
export { getKey as queryKeyOf };
