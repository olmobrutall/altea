// Port of Signum.Word's WordTemplateNodes.cs (from MatchNode on) — the template TREE, expressed as
// elements that live INSIDE the document.
//
// This is the design that makes the module work, and it is worth stating plainly: a Word template's
// control flow is not a separate syntax tree sitting beside the document, it is spliced INTO it. The
// parser replaces the runs that spell `@foreach[…]` with a `ForeachNode` element in the very position
// those runs occupied, so the node's parent chain — table row, cell, paragraph — is the thing that gets
// repeated. Rendering then walks `descendants of BaseNode` and each node rewrites its own neighbourhood.
//
// altea divergences from Signum, all forced or inherited:
//  - `AlternateContent` (the SDK element these all derive from) does not exist here, so the nodes derive
//    from OxmlElement with the qualified name `mc:<ClassName>`. That mirrors Signum's `LocalName` override
//    exactly: a node that survives to serialization writes itself out visibly, which is what makes
//    `assertClean` a meaningful check rather than silent corruption.
//  - `Synchronize` / TemplateSynchronizationContext are dropped, exactly as @altea/altea-templating dropped
//    them for text templates (see its TemplateUtils header) — altea has no template-sync pass.
//  - Signum's `IFormattable` / `SafeFormat` value-formatting chain collapses into @altea/altea-templating's
//    `formatTemplateValue`, which already handles enum / bool / Temporal / Decimal for text templates.
//  - `ExcelExtensions.ToExcelDate` has no altea counterpart; the serial-date conversion is inlined below.

import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { Decimal } from "decimal.js";
import { Temporal } from "temporal-polyfill";
import { TokenValueProvider, ValueProviderBase, formatTemplateValue } from "@altea/altea-templating/server/ValueProviders.server";
import type { ResultRow } from "@altea/altea/server/dynamicQuery/resultTable";
import type { ConditionBase } from "@altea/altea-templating/server/Conditions.server";
import { scapeColon, ScopedDictionary } from "@altea/altea-templating/server/TemplateUtils.server";
import type { KeywordMatch } from "@altea/altea-templating/server/TemplateUtils.server";
import { OxmlElement, OxmlText, type OxmlNode, type XmlTextWriter } from "./oxml/OxmlElement.server";
import type { INodeProvider } from "./NodeProviders.server";
import { SpreadsheetNodeProvider } from "./NodeProviders.server";
import type { OfficeTemplateParameters } from "./OfficeTemplateParameters.server";

/** Signum's `AlternateContent` base: an unrendered node serializes under the markup-compatibility prefix. */
function nodeName(className: string): string {
    return "mc:" + className;
}

// ---- MatchNode -----------------------------------------------------------------------------------------

/**
 * One `@…[…]` marker, standing in the document where its runs were (Signum's MatchNode).
 *
 * A MatchNode is transient: the parser creates one per keyword it finds, then a second pass folds the
 * paired markers (`@foreach` … `@endforeach`) into a single BlockContainerNode. Any MatchNode still
 * present after parsing is an unpaired / unrecognised keyword.
 */
export class MatchNode extends OxmlElement {
    private runProperties_: OxmlElement | undefined;

    constructor(public readonly nodeProvider: INodeProvider, public readonly match: KeywordMatch) {
        super(nodeName("MatchNode"));
    }

    /** The formatting of the run this marker replaced, so the rendered value inherits it. */
    get runProperties(): OxmlElement | undefined { return this.runProperties_; }
    set runProperties(value: OxmlElement | undefined) {
        if (value != null && value.parent != null)
            throw new Error("Remove it from his parent first");
        this.runProperties_ = value;
    }

    /** The marker's source text, e.g. `@foreach[Entity.Details] as $e`. */
    get matchText(): string {
        return this.match.keyword === "" && this.match.expr === ""
            ? "@"
            : "@" + this.match.keyword + (this.match.expr === "" ? "" : "[" + this.match.expr + "]") +
              (this.match.dec === "" ? "" : " as " + this.match.dec);
    }

    override cloneNode(_deep: boolean): MatchNode {
        const copy = new MatchNode(this.nodeProvider, this.match);
        copy.runProperties_ = this.runProperties_?.cloneNode(true);
        this.copyInto(copy, true);
        return copy;
    }

    /** Signum appends a temp text child so the marker is visible in the emitted XML, then removes it. */
    override writeTo(writer: XmlTextWriter): void {
        const tempText = this.nodeProvider.newText(this.matchText);
        this.appendChild(tempText);
        super.writeTo(writer);
        this.removeChild(tempText);
    }

    override get innerText(): string { return this.matchText; }

    override toString(): string { return "Match " + this.matchText; }
}

// ---- BaseNode ------------------------------------------------------------------------------------------

/** Signum's BaseNode: everything the renderer walks and replaces. */
export abstract class BaseNode extends OxmlElement {
    private runProperties_: OxmlElement | undefined;

    constructor(public readonly nodeProvider: INodeProvider, className: string) {
        super(nodeName(className));
    }

    get runProperties(): OxmlElement | undefined { return this.runProperties_; }
    set runProperties(value: OxmlElement | undefined) {
        if (value != null && value.parent != null)
            throw new Error("Remove it from his parent first");
        this.runProperties_ = value;
    }

    /** Copy the BaseNode half of a clone (Signum's `BaseNode(BaseNode original)` copy constructor). */
    protected copyBaseInto(copy: BaseNode): void {
        copy.runProperties_ = this.runProperties_;
        this.copyInto(copy, true);
    }

    /** Collect every query token this node needs, so the renderer can request them as columns. */
    abstract fillTokens(tokens: QueryToken[]): void;

    /** Replace this node with its rendered output (the whole point of the class). */
    abstract renderNode(p: OfficeTemplateParameters): void;

    /** Write this node back as literal template TEXT — the inverse of parsing, for the template editor. */
    abstract renderTemplate(variables: ScopedDictionary<ValueProviderBase>): void;

    abstract override cloneNode(deep: boolean): BaseNode;

    override toString(): string { return this.localName; }
}

// ---- TokenNode -----------------------------------------------------------------------------------------

/** `@[Entity.Customer.Name]` / `@[…:format]` — print one value (Signum's TokenNode). */
export class TokenNode extends BaseNode {
    constructor(
        nodeProvider: INodeProvider,
        public readonly valueProvider: ValueProviderBase,
        public readonly format: string | undefined,
    ) {
        super(nodeProvider, "TokenNode");
    }

    override fillTokens(tokens: QueryToken[]): void {
        this.valueProvider.fillQueryTokens(tokens, false);
    }

    override renderNode(p: OfficeTemplateParameters): void {
        p.currentTokenNode = this;
        const obj = this.valueProvider.getValue(p);
        p.currentTokenNode = undefined;

        // A spreadsheet cell holding ONLY this token becomes a typed numeric/date cell, not text, so the
        // cell's number format applies and SUM/SUMIFS see a number.
        if (this.nodeProvider instanceof SpreadsheetNodeProvider && this.trySetSpreadsheetCellValue(obj))
            return;

        // A value provider may hand back ready-made OOXML (an image, a rich block) instead of a value.
        if (obj instanceof OxmlElement) {
            this.insertElements([obj]);
            return;
        }
        if (Array.isArray(obj) && obj.length > 0 && obj.every(o => o instanceof OxmlElement)) {
            this.insertElements(obj as OxmlElement[]);
            return;
        }

        const text = formatTemplateValue(obj, this.format ?? this.valueProvider.format, p.culture, this.valueProvider.type);

        if (text != null && text.includes("\n")) {
            // Each newline becomes a real line break in the document, carrying the run's formatting.
            const replacements: OxmlNode[] = [];
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const props = this.runProperties?.cloneNode(true);
                if (i === 0)
                    replacements.push(this.nodeProvider.newRun(props, lines[i]));
                else
                    replacements.push(...this.nodeProvider.newRunWithLeadingBreak(props, lines[i]));
            }
            this.replaceBy(...replacements);
        } else {
            this.replaceBy(this.nodeProvider.newRun(this.runProperties?.cloneNode(true), text));
        }
    }

    /**
     * Splice ready-made elements in place of this node. A WordprocessingML PARAGRAPH cannot sit inside a
     * paragraph, so Signum lifts those out to be siblings of the enclosing `w:p` and drops that paragraph
     * when nothing else is left in it.
     */
    private insertElements(elements: OxmlElement[]): void {
        const hasParagraph = elements.some(e => this.nodeProvider.isParagraph(e));
        if (!hasParagraph) {
            this.replaceBy(...elements);
            return;
        }

        const par = [...this.ancestors()].find(a => this.nodeProvider.isParagraph(a));
        if (par == null || par.parent == null) {
            this.replaceBy(...elements);
            return;
        }

        const grandParent = par.parent;
        let index = grandParent.indexOf(par) + 1;
        for (const e of elements)
            grandParent.insertAt(e, index++);
        this.remove();
        // Signum: `if (par.GetFirstChild<W.Run>() == null) par.Remove();`
        if (![...par.elements()].some(c => this.nodeProvider.isRun(c)))
            par.remove();
    }

    /**
     * Signum's TrySetSpreadsheetCellValue. Only fires when this token is the cell's SOLE content — mixed
     * text like `@[a] @[b]` must stay a string — and keeps the cell's StyleIndex so its number/date format
     * still applies.
     */
    private trySetSpreadsheetCellValue(obj: unknown): boolean {
        if (obj == null)
            return false;

        const numeric = toSpreadsheetNumber(obj);
        if (numeric == null)
            return false;

        const cell = [...this.ancestors()].find(a => a.qualifiedName === "c");
        const inline = cell?.element("is");
        if (cell == null || inline == null)
            return false;

        // Any other non-blank text in the inline string means this token is not the cell's sole content.
        if (inline.descendantsNamed("t").some(t => t.innerText.trim() !== ""))
            return false;

        cell.removeAllChildren();
        cell.removeAttribute("t"); // a numeric cell has no data type; StyleIndex (`s`) is preserved
        const v = new OxmlElement("v");
        v.appendChild(new OxmlText(numeric));
        cell.appendChild(v);
        return true;
    }

    override renderTemplate(variables: ScopedDictionary<ValueProviderBase>): void {
        const sb: string[] = ["@"];
        this.valueProvider.toStringBrackets(sb, variables,
            this.format != null && this.format !== "" ? ":" + scapeColon(this.format) : undefined);
        this.replaceBy(this.nodeProvider.newRun(this.runProperties?.cloneNode(true), sb.join("")));
    }

    override cloneNode(_deep: boolean): TokenNode {
        const copy = new TokenNode(this.nodeProvider, this.valueProvider, this.format);
        this.copyBaseInto(copy);
        return copy;
    }

    override writeTo(writer: XmlTextWriter): void {
        const tempText = this.nodeProvider.newText(this.valueProvider.toString());
        this.appendChild(tempText);
        super.writeTo(writer);
        this.removeChild(tempText);
    }

    override get innerText(): string { return this.valueProvider.toString(); }
}

/** Days between the Excel serial-date epoch (1899-12-30, absorbing the 1900 leap-year bug) and a date. */
const excelEpoch = Temporal.PlainDate.from("1899-12-30");

/** Signum's `ExcelExtensions.ToExcelDate` + its numeric branch: the invariant text of a typed cell value. */
function toSpreadsheetNumber(obj: unknown): string | undefined {
    if (obj instanceof Temporal.PlainDate)
        return String(excelEpoch.until(obj).total({ unit: "days" }));

    if (obj instanceof Temporal.PlainDateTime) {
        const days = excelEpoch.until(obj.toPlainDate()).total({ unit: "days" });
        const seconds = obj.toPlainTime().since(Temporal.PlainTime.from("00:00")).total({ unit: "seconds" });
        return String(days + seconds / 86400);
    }

    if (obj instanceof Decimal)
        return obj.toString();

    if (typeof obj === "number" && Number.isFinite(obj))
        return String(obj);

    if (typeof obj === "bigint")
        return obj.toString();

    return undefined;
}

// ---- DeclareNode ---------------------------------------------------------------------------------------

/** `@declare[X] as $x` — bind a name, print nothing (Signum's DeclareNode). */
export class DeclareNode extends BaseNode {
    constructor(
        nodeProvider: INodeProvider,
        public readonly valueProvider: ValueProviderBase,
        addError: (fatal: boolean, error: string) => void,
    ) {
        super(nodeProvider, "DeclareNode");
        if (valueProvider != null && (valueProvider.variable == null || valueProvider.variable === ""))
            addError(true, `declare ${valueProvider.toString()} should end with 'as $someVariable'`);
    }

    override fillTokens(_tokens: QueryToken[]): void { }

    /**
     * Printing nothing is not the same as leaving nothing behind: the paragraph the declaration sat on
     * would render as a stray blank line. Signum drops the whole paragraph when the declaration was the
     * only thing on it.
     *
     * DIVERGENCE (a fix): Signum's Word DeclareNode does NOT bind the runtime variable — only the TEXT
     * template's DeclareNode does. That gap never shows in Signum's own templates because `@declare` there
     * is always a QUERY token (`@declare[Customer.Address] as $ca`), and `$ca.Address` resolves through the
     * token tree rather than through a runtime variable. Any other provider (a model member, a constant, a
     * global) would declare a name that then fails to resolve at render time. altea binds it here, exactly
     * as @altea/altea-templating's text DeclareNode does, so the two template flavours behave alike.
     */
    override renderNode(p: OfficeTemplateParameters): void {
        const vp = this.valueProvider;
        if (vp != null && !(vp instanceof TokenValueProvider) && vp.variable != null)
            p.runtimeVariables.add(vp.variable, vp.getValue(p));

        const parent = this.parent;
        if (parent != null && this.nodeProvider.isParagraph(parent) &&
            !parent.childElements.some(a => a !== this && isImportant(a, this.nodeProvider)))
            parent.remove();
        else
            this.remove();
    }

    override renderTemplate(variables: ScopedDictionary<ValueProviderBase>): void {
        const sb: string[] = ["@declare"];
        this.valueProvider.toStringBrackets(sb, variables, undefined);
        this.replaceBy(this.nodeProvider.newRun(this.runProperties?.cloneNode(true), sb.join("")));
        this.valueProvider.declare(variables);
    }

    override cloneNode(_deep: boolean): DeclareNode {
        const copy = new DeclareNode(this.nodeProvider, this.valueProvider, () => { });
        this.copyBaseInto(copy);
        return copy;
    }

    override writeTo(writer: XmlTextWriter): void {
        const tempText = this.nodeProvider.newText(this.valueProvider?.toString() ?? "Error!");
        this.appendChild(tempText);
        super.writeTo(writer);
        this.removeChild(tempText);
    }
}

// ---- BlockNode -----------------------------------------------------------------------------------------

/** A body: the nodes between a block keyword and its closer (Signum's BlockNode). */
export class BlockNode extends BaseNode {
    constructor(nodeProvider: INodeProvider) {
        super(nodeProvider, "BlockNode");
    }

    override fillTokens(tokens: QueryToken[]): void {
        for (const item of this.descendantsOfType(BaseNode))
            item.fillTokens(tokens);
    }

    /** Render the contained nodes, then DISSOLVE: the block's children take its place in the parent. */
    override renderNode(p: OfficeTemplateParameters): void {
        for (const item of this.descendantsOfType(BaseNode))
            item.renderNode(p);

        const parent = this.parent!;
        let index = parent.indexOf(this);
        parent.removeChild(this);
        parent.moveChildsAt(index, [...this.childElements]);
    }

    override renderTemplate(variables: ScopedDictionary<ValueProviderBase>): void {
        for (const item of this.descendantsOfType(BaseNode))
            item.renderTemplate(variables);
    }

    override cloneNode(_deep: boolean): BlockNode {
        const copy = new BlockNode(this.nodeProvider);
        this.copyBaseInto(copy);
        return copy;
    }
}

// ---- BlockContainerNode --------------------------------------------------------------------------------

/**
 * Base of the paired keywords (`@foreach`/`@if`/`@any`): a node that owns one or more BlockNodes carved
 * out of the document between its markers (Signum's BlockContainerNode).
 *
 * The tricky part, and the reason for `findCommonAncestor`, is that a template author writes `@foreach` in
 * one table cell and `@endforeach` in another — the two markers can sit at very different depths. The
 * block is the run of siblings between them AT THEIR COMMON ANCESTOR, and everything on the path down to
 * each marker must be insignificant (whitespace runs), or repeating the block would silently delete
 * content. `assertNotImportant` is what turns that into an error instead of data loss.
 */
export abstract class BlockContainerNode extends BaseNode {
    commonAncestor: OxmlElement | undefined;

    /** Fold the markers + the nodes between them into this container, replacing them in the document. */
    abstract replaceBlock(): void;

    static userString(ctor: Function | undefined): string {
        if (ctor === ForeachNode) return "foreach";
        if (ctor === IfNode) return "if";
        if (ctor === AnyNode) return "any";
        return "block";
    }

    protected findCommonAncestor(errorHint: MatchNode, ...tokens: MatchNode[]): OxmlElement {
        // Each chain is root → … → token.
        const chains = tokens.map(t => [t as OxmlElement, ...t.ancestors()].reverse());

        const minLen = Math.min(...chains.map(c => c.length));
        let divergeAt = minLen;
        for (let i = 0; i < minLen; i++) {
            if (new Set(chains.map(c => c[i])).size !== 1) {
                divergeAt = i;
                break;
            }
        }

        const children = chains.map(c => c[divergeAt]);

        for (let i = 0; i < tokens.length; i++)
            this.assertNotImportant(chains[i], children[i], errorHint, tokens[i], tokens[(i + 1) % tokens.length]);

        return chains[0][divergeAt - 1];
    }

    /** The ancestor-or-self of `token` that is a direct child of `commonAncestor`. */
    protected childOfAncestor(token: MatchNode): OxmlElement {
        const found = [token as OxmlElement, ...token.ancestors()].find(a => a.parent === this.commonAncestor);
        if (found == null)
            throw new Error(`'${token.matchText}' is not inside the block's common ancestor`);
        return found;
    }

    /** The siblings strictly between the two markers, at the common ancestor. */
    protected nodesBetween(first: MatchNode, last: MatchNode): OxmlNode[] {
        const firstChild = this.childOfAncestor(first);
        const lastChild = this.childOfAncestor(last);

        const indexFirst = this.commonAncestor!.indexOf(firstChild);
        const indexLast = this.commonAncestor!.indexOf(lastChild);

        return this.commonAncestor!.childElements.filter((_e, i) => indexFirst < i && i < indexLast);
    }

    /**
     * Put `text` back where `token` sits, as a plain run, and return the outermost container that now
     * holds it (Signum's ReplaceMatchNode) — used by renderTemplate to rebuild the literal template.
     */
    protected static replaceMatchNode(token: MatchNode, text: string): OxmlNode {
        const run = token.nodeProvider.newRun(token.runProperties?.cloneNode(true), text);
        const chain = [token as OxmlElement, ...token.ancestors()];
        const container = chain[chain.length - 1];
        if (container === (token as OxmlElement))
            return run;
        token.replaceBy(run);
        return container;
    }

    /** Clone a marker together with the container it sits in (Signum's CloneToken). */
    protected static cloneToken(token: MatchNode): MatchNode {
        const chain = [token as OxmlElement, ...token.ancestors()];
        const container = chain[chain.length - 1];
        if (container === (token as OxmlElement))
            return token.cloneNode(true);
        const containerClone = container.cloneNode(true);
        if (containerClone instanceof MatchNode)
            return containerClone;
        const found = containerClone.descendantsOfType(MatchNode);
        if (found.length !== 1)
            throw new Error(`Expected exactly one MatchNode in the cloned container, found ${found.length}`);
        return found[0];
    }

    protected static cloneOptionalToken(token: MatchNode | undefined): MatchNode | undefined {
        return token == null ? undefined : BlockContainerNode.cloneToken(token);
    }

    private assertNotImportant(chain: OxmlElement[], from: OxmlElement, errorHintParent: MatchNode, errorHint1: MatchNode, errorHint2: MatchNode): void {
        const index = chain.indexOf(from);

        for (let i = index; i < chain.length; i++) {
            const current = chain[i];
            const next = i === chain.length - 1 ? undefined : chain[i + 1];

            const important = current.childElements.filter(c => c !== next && isImportant(c, this.nodeProvider));

            if (important.length > 0) {
                const hint = errorHintParent !== errorHint1 && errorHintParent !== errorHint2
                    ? " in " + errorHintParent.matchText : "";
                const detail = chain.slice(index)
                    .map((a, p) => " ".repeat(p * 4) + `${a.localName} with text:${a.innerText}`)
                    .join("\n\n");
                throw new Error(
                    `Node ${errorHint1.matchText} is not at the same level than ${errorHint2.matchText}${hint}. ` +
                    `Important nodes could be removed in the chain:\n\n${detail}`);
            }
        }
    }
}

/**
 * Signum's `BlockContainerNode.IsImportant`: would removing this node lose something the author wrote?
 * A whitespace-only run is not important (Word litters templates with them); a paragraph, a text-bearing
 * run, or another template node is.
 */
export function isImportant(c: OxmlNode, nodeProvider: INodeProvider): boolean {
    if (nodeProvider.isParagraph(c))
        return true;

    if (nodeProvider.isRun(c)) {
        const children = (c as OxmlElement).childElements.filter(a => !nodeProvider.isRunProperties(a));
        const only = children.length === 1 ? children[0] : undefined;
        if (only != null && nodeProvider.isText(only) && nodeProvider.getText(only).trim() === "")
            return false;
        return true;
    }

    return c instanceof BaseNode;
}

// ---- ForeachNode ---------------------------------------------------------------------------------------

/** `@foreach[Entity.Details] as $e` … `@endforeach` (Signum's ForeachNode). */
export class ForeachNode extends BlockContainerNode {
    foreachToken!: MatchNode;
    endForeachToken!: MatchNode;
    foreachBlock: BlockNode | undefined;

    constructor(nodeProvider: INodeProvider, public readonly valueProvider: ValueProviderBase) {
        super(nodeProvider, "ForeachNode");
        if (valueProvider != null)
            valueProvider.isForeach = true;
    }

    override fillTokens(tokens: QueryToken[]): void {
        this.valueProvider.fillQueryTokens(tokens, true);
        this.foreachBlock!.fillTokens(tokens);
    }

    override replaceBlock(): void {
        this.commonAncestor = this.findCommonAncestor(this.foreachToken, this.foreachToken, this.endForeachToken);

        this.foreachBlock = new BlockNode(this.nodeProvider);
        this.foreachBlock.moveChilds(this.nodesBetween(this.foreachToken, this.endForeachToken));

        this.childOfAncestor(this.foreachToken).replaceBy(this);
        this.childOfAncestor(this.endForeachToken).remove();
    }

    /** One CLONE of the block per element, inserted before this node; the node itself then disappears. */
    override renderNode(p: OfficeTemplateParameters): void {
        const parent = this.parent!;

        this.valueProvider.foreach(p, () => {
            const clone = this.foreachBlock!.cloneNode(true) as BlockNode;
            const index = parent.indexOf(this);
            parent.insertAt(clone, index);
            clone.renderNode(p);
        });

        parent.removeChild(this);
    }

    override renderTemplate(variables: ScopedDictionary<ValueProviderBase>): void {
        const parent = this.parent!;
        let index = parent.indexOf(this);
        this.remove();

        const sb: string[] = ["@foreach"];
        this.valueProvider.toStringBrackets(sb, variables, undefined);
        parent.insertAt(BlockContainerNode.replaceMatchNode(this.foreachToken, sb.join("")), index++);
        {
            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.valueProvider.declare(newVars);
            this.foreachBlock!.renderTemplate(newVars);
            index = parent.moveChildsAt(index, [...this.foreachBlock!.childElements]);
        }
        parent.insertAt(BlockContainerNode.replaceMatchNode(this.endForeachToken, "@endforeach"), index++);
    }

    override cloneNode(_deep: boolean): ForeachNode {
        const copy = new ForeachNode(this.nodeProvider, this.valueProvider);
        this.copyBaseInto(copy);
        copy.foreachToken = BlockContainerNode.cloneToken(this.foreachToken);
        copy.endForeachToken = BlockContainerNode.cloneToken(this.endForeachToken);
        copy.foreachBlock = this.foreachBlock?.cloneNode(true) as BlockNode | undefined;
        return copy;
    }

    /** Signum appends the block for the duration of the write so the body is visible in the output. */
    override writeTo(writer: XmlTextWriter): void {
        if (this.foreachBlock != null)
            this.appendChild(this.foreachBlock);
        super.writeTo(writer);
        if (this.foreachBlock != null)
            this.removeChild(this.foreachBlock);
    }

    override get innerText(): string {
        return `${this.foreachToken.innerText}${this.foreachBlock?.innerText ?? ""}${this.endForeachToken.innerText}`;
    }
}

// ---- AnyNode -------------------------------------------------------------------------------------------

/** `@any[cond]` … `@notany` … `@endany` — "did any row match?" (Signum's AnyNode). */
export class AnyNode extends BlockContainerNode {
    anyToken!: MatchNode;
    notAnyToken: MatchNode | undefined;
    endAnyToken!: MatchNode;

    anyBlock: BlockNode | undefined;
    notAnyBlock: BlockNode | undefined;

    constructor(nodeProvider: INodeProvider, public readonly condition: ConditionBase) {
        super(nodeProvider, "AnyNode");
    }

    override replaceBlock(): void {
        if (this.notAnyToken == null) {
            this.commonAncestor = this.findCommonAncestor(this.anyToken, this.anyToken, this.endAnyToken);

            this.anyBlock = new BlockNode(this.nodeProvider);
            this.anyBlock.moveChilds(this.nodesBetween(this.anyToken, this.endAnyToken));

            this.childOfAncestor(this.anyToken).replaceBy(this);
            this.childOfAncestor(this.endAnyToken).remove();
        } else {
            this.commonAncestor = this.findCommonAncestor(this.anyToken, this.anyToken, this.notAnyToken, this.endAnyToken);

            this.anyBlock = new BlockNode(this.nodeProvider);
            this.anyBlock.moveChilds(this.nodesBetween(this.anyToken, this.notAnyToken));

            this.notAnyBlock = new BlockNode(this.nodeProvider);
            this.notAnyBlock.moveChilds(this.nodesBetween(this.notAnyToken, this.endAnyToken));

            this.childOfAncestor(this.anyToken).replaceBy(this);
            this.childOfAncestor(this.notAnyToken).remove();
            this.childOfAncestor(this.endAnyToken).remove();
        }
    }

    override fillTokens(tokens: QueryToken[]): void {
        this.condition.fillQueryTokens(tokens);
        this.anyBlock!.fillTokens(tokens);
        this.notAnyBlock?.fillTokens(tokens);
    }

    override renderNode(p: OfficeTemplateParameters): void {
        const filtered = this.condition.getFilteredRows(p);
        // When the condition filtered ROWS, the chosen branch renders against just those rows.
        const isRows = p.queryContext != null
            && filtered.every(f => typeof f === "object" && f != null && "index" in (f as object));

        using _ = isRows ? p.queryContext!.overrideRows(filtered as readonly ResultRow[]) : undefined;

        if (filtered.length > 0) {
            this.replaceBy(this.anyBlock!);
            this.anyBlock!.renderNode(p);
        } else if (this.notAnyBlock != null) {
            this.replaceBy(this.notAnyBlock);
            this.notAnyBlock.renderNode(p);
        } else {
            this.parent!.removeChild(this);
        }
    }

    override renderTemplate(variables: ScopedDictionary<ValueProviderBase>): void {
        const parent = this.parent!;
        let index = parent.indexOf(this);
        this.remove();

        const sb: string[] = ["@any"];
        this.condition.toStringBrackets(sb, variables);
        parent.insertAt(BlockContainerNode.replaceMatchNode(this.anyToken, sb.join("")), index++);
        {
            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.condition.declare(newVars);
            this.anyBlock!.renderTemplate(newVars);
            index = parent.moveChildsAt(index, [...this.anyBlock!.childElements]);
        }

        if (this.notAnyToken != null) {
            parent.insertAt(BlockContainerNode.replaceMatchNode(this.notAnyToken, "@notany"), index++);

            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.condition.declare(newVars);
            this.notAnyBlock!.renderTemplate(newVars);
            index = parent.moveChildsAt(index, [...this.notAnyBlock!.childElements]);
        }

        parent.insertAt(BlockContainerNode.replaceMatchNode(this.endAnyToken, "@endany"), index++);
    }

    override cloneNode(_deep: boolean): AnyNode {
        const copy = new AnyNode(this.nodeProvider, this.condition.clone());
        this.copyBaseInto(copy);
        copy.anyToken = BlockContainerNode.cloneToken(this.anyToken);
        copy.notAnyToken = BlockContainerNode.cloneOptionalToken(this.notAnyToken);
        copy.endAnyToken = BlockContainerNode.cloneToken(this.endAnyToken);
        copy.anyBlock = this.anyBlock?.cloneNode(true) as BlockNode | undefined;
        copy.notAnyBlock = this.notAnyBlock?.cloneNode(true) as BlockNode | undefined;
        return copy;
    }

    override writeTo(writer: XmlTextWriter): void {
        if (this.anyBlock != null)
            this.appendChild(this.anyBlock);
        if (this.notAnyBlock != null)
            this.appendChild(this.notAnyBlock);
        super.writeTo(writer);
        if (this.notAnyBlock != null)
            this.removeChild(this.notAnyBlock);
        if (this.anyBlock != null)
            this.removeChild(this.anyBlock);
    }

    override get innerText(): string {
        return `${this.anyToken.innerText}${this.anyBlock?.innerText ?? ""}` +
            `${this.notAnyToken?.innerText ?? ""}${this.notAnyBlock?.innerText ?? ""}${this.endAnyToken.innerText}`;
    }
}

// ---- IfNode --------------------------------------------------------------------------------------------

/** One `@elseif[cond]` branch. */
export interface ElseIfBranch {
    token: MatchNode;
    condition: ConditionBase;
    block: BlockNode | undefined;
}

/** `@if[cond]` … `@elseif[cond]` … `@else` … `@endif` (Signum's IfNode). */
export class IfNode extends BlockContainerNode {
    ifToken!: MatchNode;
    ifBlock: BlockNode | undefined;
    readonly elseIfBranches: ElseIfBranch[] = [];
    elseToken: MatchNode | undefined;
    elseBlock: BlockNode | undefined;
    endIfToken!: MatchNode;

    constructor(nodeProvider: INodeProvider, public readonly condition: ConditionBase) {
        super(nodeProvider, "IfNode");
    }

    /** Every marker of this if/elseif/else/endif chain, in document order. */
    private allTokens(): MatchNode[] {
        const out: MatchNode[] = [this.ifToken];
        for (const b of this.elseIfBranches)
            out.push(b.token);
        if (this.elseToken != null)
            out.push(this.elseToken);
        out.push(this.endIfToken);
        return out;
    }

    override replaceBlock(): void {
        const tokens = this.allTokens();
        this.commonAncestor = this.findCommonAncestor(this.ifToken, ...tokens);

        this.ifBlock = this.blockBetween(tokens[0], tokens[1]);

        for (let i = 0; i < this.elseIfBranches.length; i++)
            this.elseIfBranches[i].block = this.blockBetween(tokens[i + 1], tokens[i + 2]);

        if (this.elseToken != null)
            this.elseBlock = this.blockBetween(tokens[tokens.length - 2], tokens[tokens.length - 1]);

        this.childOfAncestor(tokens[0]).replaceBy(this);
        for (let i = 1; i < tokens.length; i++)
            this.childOfAncestor(tokens[i]).remove();
    }

    private blockBetween(first: MatchNode, last: MatchNode): BlockNode {
        const block = new BlockNode(this.nodeProvider);
        block.moveChilds(this.nodesBetween(first, last));
        return block;
    }

    override fillTokens(tokens: QueryToken[]): void {
        this.condition.fillQueryTokens(tokens);
        this.ifBlock!.fillTokens(tokens);

        for (const b of this.elseIfBranches) {
            b.condition.fillQueryTokens(tokens);
            b.block?.fillTokens(tokens);
        }

        this.elseBlock?.fillTokens(tokens);
    }

    override renderNode(p: OfficeTemplateParameters): void {
        if (this.condition.evaluate(p)) {
            this.replaceBy(this.ifBlock!);
            this.ifBlock!.renderNode(p);
            return;
        }

        for (const b of this.elseIfBranches) {
            if (b.condition.evaluate(p)) {
                this.replaceBy(b.block!);
                b.block!.renderNode(p);
                return;
            }
        }

        if (this.elseBlock != null) {
            this.replaceBy(this.elseBlock);
            this.elseBlock.renderNode(p);
        } else {
            this.parent!.removeChild(this);
        }
    }

    override renderTemplate(variables: ScopedDictionary<ValueProviderBase>): void {
        const parent = this.parent!;
        let index = parent.indexOf(this);
        this.remove();

        const sb: string[] = ["@if"];
        this.condition.toStringBrackets(sb, variables);
        parent.insertAt(BlockContainerNode.replaceMatchNode(this.ifToken, sb.join("")), index++);
        {
            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.condition.declare(newVars);
            this.ifBlock!.renderTemplate(newVars);
            index = parent.moveChildsAt(index, [...this.ifBlock!.childElements]);
        }

        for (const b of this.elseIfBranches) {
            const head: string[] = ["@elseif"];
            b.condition.toStringBrackets(head, variables);
            parent.insertAt(BlockContainerNode.replaceMatchNode(b.token, head.join("")), index++);

            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            b.condition.declare(newVars);
            b.block!.renderTemplate(newVars);
            index = parent.moveChildsAt(index, [...b.block!.childElements]);
        }

        if (this.elseToken != null) {
            parent.insertAt(BlockContainerNode.replaceMatchNode(this.elseToken, "@else"), index++);

            const newVars = new ScopedDictionary<ValueProviderBase>(variables);
            this.condition.declare(newVars);
            this.elseBlock!.renderTemplate(newVars);
            index = parent.moveChildsAt(index, [...this.elseBlock!.childElements]);
        }

        parent.insertAt(BlockContainerNode.replaceMatchNode(this.endIfToken, "@endif"), index++);
    }

    override cloneNode(_deep: boolean): IfNode {
        const copy = new IfNode(this.nodeProvider, this.condition.clone());
        this.copyBaseInto(copy);
        copy.ifToken = BlockContainerNode.cloneToken(this.ifToken);
        copy.elseToken = BlockContainerNode.cloneOptionalToken(this.elseToken);
        copy.endIfToken = BlockContainerNode.cloneToken(this.endIfToken);
        copy.ifBlock = this.ifBlock?.cloneNode(true) as BlockNode | undefined;
        copy.elseBlock = this.elseBlock?.cloneNode(true) as BlockNode | undefined;
        for (const b of this.elseIfBranches)
            copy.elseIfBranches.push({
                token: BlockContainerNode.cloneToken(b.token),
                condition: b.condition.clone(),
                block: b.block?.cloneNode(true) as BlockNode | undefined,
            });
        return copy;
    }

    override writeTo(writer: XmlTextWriter): void {
        const appended: BlockNode[] = [];
        if (this.ifBlock != null) { this.appendChild(this.ifBlock); appended.push(this.ifBlock); }
        for (const b of this.elseIfBranches)
            if (b.block != null) { this.appendChild(b.block); appended.push(b.block); }
        if (this.elseBlock != null) { this.appendChild(this.elseBlock); appended.push(this.elseBlock); }

        super.writeTo(writer);

        for (const b of appended.reverse())
            this.removeChild(b);
    }

    override get innerText(): string {
        return this.ifToken.innerText + (this.ifBlock?.innerText ?? "")
            + this.elseIfBranches.map(b => b.token.innerText + (b.block?.innerText ?? "")).join("")
            + (this.elseToken?.innerText ?? "") + (this.elseBlock?.innerText ?? "")
            + this.endIfToken.innerText;
    }
}
