import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { Entity } from "@altea/altea/data/entity";
import type { ConditionBase } from "./Conditions.server";
import {
    ValueProviderBase, TokenValueProvider, TemplateParameters, formatTemplateValue,
    type QueryContext,
} from "./ValueProviders.server";
import { scapeColon, ScopedDictionary } from "./TemplateUtils.server";

// Port of Signum.Templating's TextTemplateParser.Nodes.cs — the parsed template TREE (a C# nested
// partial class; TS has no partial classes, so the nodes live in their own module and the parser
// imports them).
//
// altea divergences, documented inline:
//  - `HtmlString` (ASP.NET's "already-encoded" marker that suppressed HTML escaping for one value) has
//    no counterpart; use `@raw[…]` to opt a value out of escaping.
//  - `Synchronize` is dropped with the sync pass (see TemplateUtils' header).
//  - `HttpUtility.HtmlEncode` → the small `htmlEncode` below.

/** The placeholder a control node prints in place of itself, so the whitespace/markup it sat on can be
 *  cleaned up afterwards (Signum's `(∅)`). */
export const emptyPlaceholder = "(∅)";

export abstract class TextNode {
    abstract printList(p: TextTemplateParameters): void;
    abstract fillQueryTokens(list: QueryToken[]): void;
    abstract write(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void;

    toString(): string {
        const sb: string[] = [];
        this.write(sb, new ScopedDictionary<ValueProviderBase>(undefined));
        return sb.join("");
    }
}

export class LiteralNode extends TextNode {
    constructor(public readonly text: string) { super(); }

    override printList(p: TextTemplateParameters): void { p.stringBuilder.push(this.text); }
    override fillQueryTokens(_list: QueryToken[]): void { }
    override write(sb: string[], _variables: ScopedDictionary<ValueProviderBase>): void { sb.push(this.text); }
}

/** `@declare[X] as $x` — bind a name without printing anything. */
export class DeclareNode extends TextNode {
    constructor(public readonly valueProvider: ValueProviderBase | undefined, addError: (fatal: boolean, error: string) => void) {
        super();
        if (valueProvider != undefined && (valueProvider.variable == undefined || valueProvider.variable === ""))
            addError(true, `declare[${valueProvider.toString()}] should end with 'as $someVariable'`);
    }

    override printList(p: TextTemplateParameters): void {
        const vp = this.valueProvider;
        // A QUERY token needs no runtime variable: `$x` off it resolves through the token tree instead.
        if (vp != undefined && !(vp instanceof TokenValueProvider) && vp.variable != undefined)
            p.runtimeVariables.add(vp.variable, vp.getValue(p));

        p.stringBuilder.push(emptyPlaceholder);
    }

    override fillQueryTokens(_list: QueryToken[]): void { }

    override write(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("@declare");
        this.valueProvider!.toStringBrackets(sb, variables, undefined);
        this.valueProvider!.declare(variables);
    }
}

/** `@[X]` / `@[X:format]` / `@raw[X]` — print one value. */
export class ValueNode extends TextNode {
    constructor(
        public readonly valueProvider: ValueProviderBase | undefined,
        public readonly format: string | undefined,
        public readonly isRaw: boolean,
    ) { super(); }

    override printList(p: TextTemplateParameters): void {
        const vp = this.valueProvider!;
        const obj = vp.getValue(p);
        const text = formatTemplateValue(obj, this.format ?? vp.format, p.culture, vp.type);

        p.stringBuilder.push(p.isHtml && !this.isRaw ? htmlEncode(text) : text);
    }

    override fillQueryTokens(list: QueryToken[]): void {
        this.valueProvider!.fillQueryTokens(list, false);
    }

    override write(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("@");
        if (this.isRaw)
            sb.push("raw");
        this.valueProvider!.toStringBrackets(sb, variables,
            this.format != undefined && this.format !== "" ? ":" + scapeColon(this.format) : undefined);
    }
}

/** A sequence of nodes — the template's root, and each block's body. */
export class BlockNode extends TextNode {
    readonly nodes: TextNode[] = [];

    constructor(public readonly owner: TextNode | undefined) { super(); }

    /** Signum's Print — render this block and clean up the placeholders the control nodes left. */
    print(p: TextTemplateParameters): string {
        this.printList(p);
        const text = p.stringBuilder.join("");
        return p.isHtml ? cleanHtml(text) : cleanText(text);
    }

    override printList(p: TextTemplateParameters): void {
        for (const node of this.nodes)
            node.printList(p);
    }

    override fillQueryTokens(list: QueryToken[]): void {
        for (const node of this.nodes)
            node.fillQueryTokens(list);
    }

    override write(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        for (const n of this.nodes)
            n.write(sb, variables);
    }

    /** Signum's UserString — the keyword a block's owner opened with, for the error messages. Takes the
     *  node OR its constructor (Signum's overload took a `Type`). */
    static userString(nodeOrCtor: TextNode | Function | undefined): string {
        const ctor = typeof nodeOrCtor === "function" ? nodeOrCtor : nodeOrCtor?.constructor;
        if (ctor === ForeachNode) return "foreach";
        if (ctor === IfNode) return "if";
        if (ctor === AnyNode) return "any";
        return "block";
    }
}

/** `@foreach[X] … @endforeach` — repeat the body once per element / row group. */
export class ForeachNode extends TextNode {
    readonly block: BlockNode;

    constructor(public readonly valueProvider: ValueProviderBase | undefined) {
        super();
        this.block = new BlockNode(this);
    }

    override printList(p: TextTemplateParameters): void {
        p.stringBuilder.push(emptyPlaceholder);
        this.valueProvider!.foreach(p, () => {
            this.block.printList(p);
            p.stringBuilder.push(emptyPlaceholder);
        });
    }

    override fillQueryTokens(list: QueryToken[]): void {
        this.valueProvider!.fillQueryTokens(list, true);
        this.block.fillQueryTokens(list);
    }

    override write(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("@foreach");
        this.valueProvider!.toStringBrackets(sb, variables, undefined);
        const newVars = new ScopedDictionary<ValueProviderBase>(variables);
        this.valueProvider!.declare(newVars);
        this.block.write(sb, newVars);
        sb.push("@endforeach");
    }
}

/** `@any[cond] … @notany … @endany` — "is there at least one row/element matching?". */
export class AnyNode extends TextNode {
    readonly anyBlock: BlockNode;
    notAnyBlock: BlockNode | undefined;

    constructor(public condition: ConditionBase) {
        super();
        this.anyBlock = new BlockNode(this);
    }

    createNotAny(): BlockNode {
        this.notAnyBlock = new BlockNode(this);
        return this.notAnyBlock;
    }

    override printList(p: TextTemplateParameters): void {
        const filtered = this.condition.getFilteredRows(p);
        const isRows = p.queryContext != undefined && filtered.every(f => typeof f === "object" && f != null && "index" in (f as object));

        using _ = isRows ? p.queryContext!.overrideRows(filtered as never) : noopDisposable;

        p.stringBuilder.push(emptyPlaceholder);
        if (filtered.length > 0)
            this.anyBlock.printList(p);
        else if (this.notAnyBlock != undefined)
            this.notAnyBlock.printList(p);
    }

    override fillQueryTokens(list: QueryToken[]): void {
        this.condition.fillQueryTokens(list);
        this.anyBlock.fillQueryTokens(list);
        this.notAnyBlock?.fillQueryTokens(list);
    }

    override write(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("@any");
        this.condition.toStringBrackets(sb, variables);
        {
            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.condition.declare(newVars);
            this.anyBlock.write(sb, newVars);
        }

        if (this.notAnyBlock != undefined) {
            sb.push("@notany");
            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.condition.declare(newVars);
            this.notAnyBlock.write(sb, newVars);
        }

        sb.push("@endany");
    }
}

/** `@if[cond] … @elseif[cond] … @else … @endif`. */
export class IfNode extends TextNode {
    readonly ifBlock: BlockNode;
    readonly elseIfBranches: { condition: ConditionBase; block: BlockNode }[] = [];
    elseBlock: BlockNode | undefined;

    constructor(public readonly condition: ConditionBase) {
        super();
        this.ifBlock = new BlockNode(this);
    }

    createElseIf(condition: ConditionBase): BlockNode {
        const block = new BlockNode(this);
        this.elseIfBranches.push({ condition, block });
        return block;
    }

    createElse(): BlockNode {
        this.elseBlock = new BlockNode(this);
        return this.elseBlock;
    }

    override fillQueryTokens(list: QueryToken[]): void {
        this.condition.fillQueryTokens(list);
        this.ifBlock.fillQueryTokens(list);
        for (const { condition, block } of this.elseIfBranches) {
            condition.fillQueryTokens(list);
            block.fillQueryTokens(list);
        }
        this.elseBlock?.fillQueryTokens(list);
    }

    override printList(p: TextTemplateParameters): void {
        p.stringBuilder.push(emptyPlaceholder);
        if (this.condition.evaluate(p)) {
            this.ifBlock.printList(p);
        } else {
            let handled = false;
            for (const { condition, block } of this.elseIfBranches) {
                if (condition.evaluate(p)) {
                    block.printList(p);
                    handled = true;
                    break;
                }
            }
            if (!handled && this.elseBlock != undefined)
                this.elseBlock.printList(p);
        }
        p.stringBuilder.push(emptyPlaceholder);
    }

    override write(sb: string[], variables: ScopedDictionary<ValueProviderBase>): void {
        sb.push("@if[");
        this.condition.toStringInternal(sb, variables);
        sb.push("]");
        {
            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.condition.declare(newVars);
            this.ifBlock.write(sb, newVars);
        }

        for (const { condition, block } of this.elseIfBranches) {
            sb.push("@elseif[");
            condition.toStringInternal(sb, variables);
            sb.push("]");
            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            condition.declare(newVars);
            block.write(sb, newVars);
        }

        if (this.elseBlock != undefined) {
            sb.push("@else");
            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.condition.declare(newVars);
            this.elseBlock.write(sb, newVars);
        }

        sb.push("@endif");
    }
}

/** Signum's TextTemplateParameters — the print run's state: what to print into, whether the output is
 *  HTML (so values get escaped), and the model behind `@[m:…]`. */
export class TextTemplateParameters extends TemplateParameters {
    stringBuilder: string[] = [];
    isHtml: boolean = false;
    model: object | undefined;

    constructor(entity: Entity | null, culture: string, qc: QueryContext | undefined) {
        super(entity, culture, qc);
    }

    override getModel(): object {
        if (this.model == undefined)
            throw new Error("There is no Model set");
        return this.model;
    }
}

// ---- placeholder cleanup --------------------------------------------------------------------------------

const placeholderRegex = /\(∅\)/g;
// A markup element that contains NOTHING but a placeholder collapses to a placeholder itself, so a
// `<p>@if[…]</p>` line disappears entirely rather than leaving an empty paragraph.
const tagRegex = /<(?<tag>p|li|tr|td|strong|em)>(?: |&nbsp;)*\(∅\)(?: |&nbsp;)*<\/\k<tag>>/g;
const commentRegex = /<!-- *\(∅\) *-->/g;
const lineRegex = /^ *\(∅\) *\r?\n/gm;

function cleanText(text: string): string {
    return text.replace(lineRegex, "").replace(placeholderRegex, "");
}

function cleanHtml(text: string): string {
    for (let previous = ""; previous !== text;) {
        previous = text;
        text = text.replace(tagRegex, emptyPlaceholder);
    }

    return text.replace(commentRegex, emptyPlaceholder).replace(lineRegex, "").replace(placeholderRegex, "");
}

/** ASP.NET's HttpUtility.HtmlEncode, for the characters that matter in a body / attribute. */
export function htmlEncode(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const noopDisposable: Disposable = { [Symbol.dispose]: () => { } };
