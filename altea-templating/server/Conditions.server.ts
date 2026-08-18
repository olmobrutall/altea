import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { FilterOperation } from "@altea/altea/server/dynamicQuery/requests";
import type { ResultRow } from "@altea/altea/server/dynamicQuery/resultTable";
import {
    ValueProviderBase, TokenValueProvider, parseConstant, type TemplateParameters,
} from "./ValueProviders.server";
import { compareInMemory, ScopedDictionary, toStringOperation } from "./TemplateUtils.server";

// Port of Signum.Templating's Conditions.cs — the boolean expression inside an `@if[…]` / `@any[…]`
// bracket: `A && B`, `A || B`, `Token op Value`, or a bare truthiness test.
//
// altea divergences, documented inline:
//  - `GetResultFilter` returned a compiled LINQ predicate over a ResultRow; here it is a plain closure
//    over the in-memory comparison (see TemplateUtils' compareInMemory) — same behaviour, no expression
//    trees.
//  - `Synchronize` is dropped with the sync pass (see TemplateUtils' header).

export abstract class ConditionBase {
    abstract clone(): ConditionBase;

    abstract fillQueryTokens(tokens: QueryToken[]): void;

    abstract evaluate(p: TemplateParameters): boolean;

    abstract declare(variables: ScopedDictionary<ValueProviderBase>): void;

    abstract toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void;

    toStringBrackets(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("[");
        this.toStringInternal(sb, variables);
        sb.push("]");
    }

    stringify(variables: ScopedDictionary<ValueProviderBase>): string {
        const sb: string[] = [];
        this.toStringBrackets(sb, variables);
        return sb.join("");
    }

    toString(): string {
        return this.stringify(new ScopedDictionary<ValueProviderBase>(undefined));
    }

    /** Signum's GetFilteredRows — the rows an `@any` block should see (and whether there are any). */
    getFilteredRows(p: TemplateParameters): unknown[] {
        const filter = this.getResultFilter(p);
        return p.queryContext!.currentRows.filter(filter);
    }

    abstract getResultFilter(p: TemplateParameters): (rr: ResultRow) => boolean;
}

export class ConditionAnd extends ConditionBase {
    constructor(public readonly leftNode: ConditionBase, public readonly rightNode: ConditionBase) { super(); }

    override clone(): ConditionBase { return new ConditionAnd(this.leftNode, this.rightNode); }

    override evaluate(p: TemplateParameters): boolean {
        return this.leftNode.evaluate(p) && this.rightNode.evaluate(p);
    }

    override declare(_variables: ScopedDictionary<ValueProviderBase>): void { }

    override fillQueryTokens(tokens: QueryToken[]): void {
        this.leftNode.fillQueryTokens(tokens);
        this.rightNode.fillQueryTokens(tokens);
    }

    override toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        this.leftNode.toStringInternal(sb, variables);
        sb.push(" && ");
        this.rightNode.toStringInternal(sb, variables);
    }

    override getResultFilter(p: TemplateParameters): (rr: ResultRow) => boolean {
        const left = this.leftNode.getResultFilter(p);
        const right = this.rightNode.getResultFilter(p);
        return rr => left(rr) && right(rr);
    }
}

export class ConditionOr extends ConditionBase {
    constructor(public readonly leftNode: ConditionBase, public readonly rightNode: ConditionBase) { super(); }

    override clone(): ConditionBase { return new ConditionOr(this.leftNode, this.rightNode); }

    override evaluate(p: TemplateParameters): boolean {
        return this.leftNode.evaluate(p) || this.rightNode.evaluate(p);
    }

    override declare(_variables: ScopedDictionary<ValueProviderBase>): void { }

    override fillQueryTokens(tokens: QueryToken[]): void {
        this.leftNode.fillQueryTokens(tokens);
        this.rightNode.fillQueryTokens(tokens);
    }

    override toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        this.leftNode.toStringInternal(sb, variables);
        sb.push(" || ");
        this.rightNode.toStringInternal(sb, variables);
    }

    override getResultFilter(p: TemplateParameters): (rr: ResultRow) => boolean {
        const left = this.leftNode.getResultFilter(p);
        const right = this.rightNode.getResultFilter(p);
        return rr => left(rr) || right(rr);
    }
}

export class ConditionCompare extends ConditionBase {
    constructor(
        public readonly valueProvider: ValueProviderBase | undefined,
        private operation?: FilterOperation,
        private value?: string,
        addError?: (fatal: boolean, error: string) => void,
    ) {
        super();
        if (this.operation != undefined && this.value != undefined && addError != undefined)
            this.valueProvider?.validateConditionValue(this.value, this.operation, addError);
    }

    override clone(): ConditionBase {
        return new ConditionCompare(this.valueProvider, this.operation, this.value);
    }

    override fillQueryTokens(tokens: QueryToken[]): void {
        this.valueProvider!.fillQueryTokens(tokens, false);
    }

    override evaluate(p: TemplateParameters): boolean {
        const obj = this.valueProvider!.getValue(p);

        if (this.operation == undefined)
            return ConditionCompare.toBool(obj);

        const type = this.valueProvider!.type;
        if (type == undefined)
            throw new Error(`Unable to compare '${this.valueProvider}': its type is unknown`);

        const isList = this.operation === FilterOperation.IsIn || this.operation === FilterOperation.IsNotIn;
        return compareInMemory(this.operation, obj, parseConstant(this.value!, type, isList));
    }

    /** Signum's ToBool — `null`, `0`, `""` and `false` are false; everything else is true. */
    static toBool(obj: unknown): boolean {
        if (obj == null)
            return false;
        if (typeof obj === "boolean")
            return obj;
        if (typeof obj === "string")
            return obj !== "";
        return true;
    }

    override declare(variables: ScopedDictionary<ValueProviderBase>): void {
        this.valueProvider!.declare(variables);
    }

    override toStringInternal(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        this.valueProvider!.toStringInternal(sb, variables);
        if (this.operation != undefined)
            sb.push(toStringOperation(this.operation) + (this.value ?? ""));
    }

    override toStringBrackets(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("[");
        this.toStringInternal(sb, variables);
        sb.push("]");
        if (this.valueProvider!.variable != undefined && this.valueProvider!.variable !== "")
            sb.push(" as " + this.valueProvider!.variable);
    }

    /** A condition over a QUERY token filters ROWS; one over a model/global value iterates its collection. */
    override getFilteredRows(p: TemplateParameters): unknown[] {
        if (this.valueProvider instanceof TokenValueProvider)
            return super.getFilteredRows(p);

        const collection = this.valueProvider!.getValue(p) as Iterable<unknown> | null | undefined;
        return collection == null ? [] : [...collection];
    }

    override getResultFilter(p: TemplateParameters): (rr: ResultRow) => boolean {
        const tvp = this.valueProvider as TokenValueProvider;
        const column = p.queryContext!.column(tvp.parsedToken.queryToken!);

        if (this.operation == undefined)
            return rr => ConditionCompare.toBool(column.values[rr.index]);

        const type = this.valueProvider!.type!;
        const isList = this.operation === FilterOperation.IsIn || this.operation === FilterOperation.IsNotIn;
        const parsed = parseConstant(this.value!, type, isList);
        const operation = this.operation;

        return rr => compareInMemory(operation, column.values[rr.index], parsed);
    }
}
