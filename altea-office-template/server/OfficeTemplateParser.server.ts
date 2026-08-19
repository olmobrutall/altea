// Port of Signum.Word's WordTemplateParser.cs — turning an authored .docx / .pptx / .xlsx into a tree the
// renderer can execute.
//
// The parse is TWO passes over the package, and the reason for the first one is the single most important
// thing to understand about this module:
//
//   A word processor does not keep a token in one piece. Typing `@[Entity.Freight]` into Word can produce
//   seven runs with spell-check markers between them:
//
//     <w:r><w:t>@[</w:t></w:r><w:proofErr w:type="spellStart"/>
//     <w:r w:rsidRPr="00646522"><w:t>Entity.Freight</w:t></w:r><w:proofErr w:type="spellEnd"/>
//     <w:r w:rsidRPr="00646522"><w:t>]</w:t></w:r>
//
//   (that is a real excerpt from Southwind's Order.docx). So pass 1 — `replaceRuns` — concatenates the text
//   of every run in a paragraph, finds the markers in that FLATTENED string, and then rebuilds the
//   paragraph: runs entirely before a match are kept, the run that straddles the start is split, the runs
//   in the middle are dropped, and the run that straddles the end is split and pushed back for the next
//   match to consider. Each match becomes one `MatchNode` carrying the run properties of the run it
//   started in, so the rendered value inherits the author's formatting.
//
// Pass 2 — `createNodes` — walks the MatchNodes in document order and folds them into the real tree:
// `@[…]` becomes a TokenNode in place, while a paired keyword pushes a BlockContainerNode onto a stack
// and its closer pops it and calls `replaceBlock()` to carve out the body.
//
// altea divergences:
//  - `TemplateUtils.KeywordsRegex.Matches` → @altea/altea-templating's hand-written `scanKeywords`, which
//    already exists for text templates (JS regexes have no balancing groups, so bracket bodies are scanned
//    by hand). The `KeywordMatch` it returns carries the same index/length/keyword/expr/dec groups.
//  - `QueryDescription` is gone in altea (see the repo's CLAUDE.md); the parser carries a `queryName` and
//    resolves tokens through the registered entity metadata, exactly as @altea/altea-templating does.
//  - Signum's `Synchronize` pass is not ported (no template-sync in altea), so nothing here builds a
//    TemplateSynchronizationContext.
//  - The spreadsheet PREPARATION step (`SpreadsheetUtils.DeshareFormulas` / `InlineTokens` /
//    `InlineNoteTokens`) is a separate module; `parseDocument` calls into it through `spreadsheetPrepare`,
//    injected so this file does not depend on the xlsx specifics.

import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { ValueProviderBase, type ITemplateParser } from "@altea/altea-templating/server/ValueProviders.server";
import { ConditionCompare } from "@altea/altea-templating/server/Conditions.server";
import {
    parseCondition, scanKeywords, splitToken, ScopedDictionary, TemplateError,
    type KeywordMatch,
} from "@altea/altea-templating/server/TemplateUtils.server";
import type { OfficeTemplateEntity } from "../data/OfficeTemplate";
import { OxmlElement, type OxmlNode } from "./oxml/OxmlElement.server";
import type { OxmlPackage } from "./oxml/OxmlPackage.server";
import {
    DrawingNodeProvider, SpreadsheetNodeProvider, WordprocessingNodeProvider, type INodeProvider,
} from "./NodeProviders.server";
import {
    AnyNode, BaseNode, BlockContainerNode, DeclareNode, ForeachNode, IfNode, MatchNode, TokenNode,
} from "./OfficeTemplateNodes.server";

/** A half-open text interval `[min, max)` (Signum's `Interval<int>`). */
interface Interval { min: number; max: number }

/** One child of a paragraph, with the slice of the flattened paragraph text it contributes. */
class ElementInfo {
    interval: Interval = { min: 0, max: 0 };
    constructor(public readonly element: OxmlNode, public readonly text: string | undefined) { }

    toString(): string {
        return `[${this.interval.min},${this.interval.max}) ${this.element instanceof OxmlElement ? this.element.localName : "text"}`
            + (this.text == null ? "" : `: '${this.text}'`);
    }
}

/**
 * A row-level `@foreach` found in a worksheet, captured BEFORE the block is collapsed so the spreadsheet
 * finalizer can renumber rows and fix formula ranges afterwards (Signum's SpreadsheetForeachBlock).
 */
export interface SpreadsheetForeachBlock {
    readonly worksheet: OxmlElement;
    readonly firstRow: number;
    readonly lastRow: number;
}

export class OfficeTemplateParser implements ITemplateParser {
    readonly errors: TemplateError[] = [];
    variables: ScopedDictionary<ValueProviderBase> = new ScopedDictionary<ValueProviderBase>(undefined);

    /** Row-level foreach blocks found in spreadsheets, for the post-render row/formula fixup. */
    readonly spreadsheetForeachBlocks: SpreadsheetForeachBlock[] = [];

    private readonly stack: BlockContainerNode[] = [];

    constructor(
        private readonly package_: OxmlPackage,
        private readonly template: OfficeTemplateEntity,
        readonly queryName: QueryName | undefined,
        readonly modelType: Function | undefined,
        /** Injected xlsx preparation (SpreadsheetUtils); omitted when the spreadsheet path is not needed. */
        private readonly spreadsheetPrepare?: (workbookPart: OxmlPackage) => void,
    ) { }

    assertQueryName(action: string): QueryName {
        if (this.queryName == null)
            throw new Error(`No Query selected! Unable to ${action}`);
        return this.queryName;
    }

    addError(fatal: boolean, message: string): void {
        this.errors.push(new TemplateError(fatal, message));
    }

    // ---- pass 1: markers -----------------------------------------------------------------------

    /** Signum's ParseDocument: prepare the package, then turn every `@…` marker into a MatchNode. */
    parseDocument(): void {
        if (this.package_.kind === "spreadsheet" && this.spreadsheetPrepare != null) {
            // Shared formulas would duplicate their shared index/range when a template row is cloned, and
            // token text lives in a deduplicated string pool detached from the rows — both must be undone
            // before the rows can be matched against. See SpreadsheetUtils for the detail.
            this.spreadsheetPrepare(this.package_);
        }

        for (const part of this.package_.parts) {
            if (!part.isXml)
                continue;

            for (const item of part.document.root.selfAndDescendants()) {
                switch (item.qualifiedName) {
                    case "w:p":
                        this.replaceRuns(item, wordprocessing);
                        break;
                    case "a:p":
                        this.replaceRuns(item, drawing);
                        break;
                    case "is":       // a spreadsheet inline string
                    case "si":       // a shared-string entry
                        this.replaceRuns(item, spreadsheet);
                        break;
                }
            }
        }
    }

    /**
     * Rebuild one paragraph so each `@…` marker becomes a single MatchNode, splitting the runs that
     * straddle a marker's boundaries. This is Signum's ReplaceRuns, and the stack discipline is the same:
     *
     *     [Before][Start][Ignore][Ignore][End]...[Remaining]
     *                 [        Match       ]
     */
    private replaceRuns(par: OxmlElement, nodeProvider: INodeProvider): void {
        this.fixNakedText(par, nodeProvider);

        const text = par.childElements
            .filter(a => nodeProvider.isRun(a))
            .map(r => nodeProvider.getText(r))
            .join("");

        const matches = scanKeywords(text);
        if (matches.length === 0)
            return;

        const infos = getElementInfos(par.childElements, nodeProvider);

        par.removeAllChildren();

        // A stack so the tail of a split run can be pushed back for the NEXT match to consume.
        const stack: ElementInfo[] = [...infos].reverse();
        const pop = (): ElementInfo => {
            const e = stack.pop();
            if (e == null)
                throw new Error("Unbalanced runs while replacing tokens — the paragraph ended mid-token");
            return e;
        };

        for (const m of matches) {
            const interval: Interval = { min: m.index, max: m.index + m.length };

            let start = pop();
            while (start.interval.max <= interval.min) { // Before: keep verbatim
                par.appendChild(start.element);
                start = pop();
            }

            const startRun = nodeProvider.castRun(start.element);

            if (start.interval.min < interval.min) {
                // The marker starts mid-run: keep the leading text as its own run.
                const firstRunPart = nodeProvider.newRun(
                    nodeProvider.getRunProperties(startRun)?.cloneNode(true),
                    start.text!.substring(0, m.index - start.interval.min),
                    "preserve");
                par.appendChild(firstRunPart);
            }

            const matchNode = new MatchNode(nodeProvider, m);
            matchNode.runProperties = nodeProvider.getRunProperties(startRun)?.cloneNode(true);
            par.appendChild(matchNode);

            let end = start;
            while (end.interval.max < interval.max) // Ignore: runs wholly inside the marker
                end = pop();

            if (interval.max < end.interval.max) {
                // The marker ends mid-run: push the trailing text back for the next match.
                const textPart = end.text!.substring(interval.max - end.interval.min);
                const endRunPart = nodeProvider.newRun(
                    nodeProvider.getRunProperties(startRun)?.cloneNode(true),
                    textPart,
                    "preserve");
                const info = new ElementInfo(endRunPart, textPart);
                info.interval = { min: interval.max, max: end.interval.max };
                stack.push(info);
            }
        }

        while (stack.length > 0) // Remaining
            par.appendChild(stack.pop()!.element);
    }

    /**
     * A simple spreadsheet cell holds a NAKED `<t>` with no surrounding `<r>`. Promote it into a run when
     * it carries a marker, so the run-splitting above has something to split (Signum's FixNakedText).
     */
    private fixNakedText(par: OxmlElement, nodeProvider: INodeProvider): void {
        if (par.childElements.length !== 1)
            return;

        const only = par.childElements[0];
        if (!nodeProvider.isText(only))
            return;

        const text = nodeProvider.getText(only);
        if (scanKeywords(text).length === 0)
            return;

        par.removeChild(only);
        par.appendChild(nodeProvider.wrapInRun(only as OxmlElement));
    }

    // ---- pass 2: nodes -------------------------------------------------------------------------

    /** Signum's CreateNodes: fold the MatchNodes into TokenNodes and block containers. */
    createNodes(): void {
        for (const part of this.package_.parts) {
            if (!part.isXml)
                continue;

            const root = part.document.root;
            this.newScope();

            for (const matchNode of root.descendantsOfType(MatchNode)) {
                const m = matchNode.match;
                const expr = m.expr;
                const variable = m.dec === "" ? undefined : m.dec;

                switch (m.keyword) {
                    case "":
                        this.handleToken(matchNode, expr, variable);
                        break;

                    case "declare": {
                        const vp = ValueProviderBase.tryParse(expr, variable, this);
                        const node = new DeclareNode(matchNode.nodeProvider, vp!, (f, e) => this.addError(f, e));
                        node.runProperties = matchNode.runProperties?.cloneNode(true);
                        matchNode.parent!.replaceChild(node, matchNode);
                        this.declareVariable(vp);
                        break;
                    }

                    case "any": {
                        const cond = parseCondition(expr, variable, this);
                        const any = new AnyNode(matchNode.nodeProvider, cond);
                        any.anyToken = matchNode;
                        this.pushBlock(any);
                        if (cond instanceof ConditionCompare)
                            this.declareVariable(cond.valueProvider);
                        break;
                    }
                    case "notany": {
                        const an = this.peekBlock(AnyNode);
                        if (an != null)
                            an.notAnyToken = matchNode;
                        break;
                    }
                    case "endany": {
                        const an = this.popBlock(AnyNode);
                        if (an != null) {
                            an.endAnyToken = matchNode;
                            an.replaceBlock();
                        }
                        break;
                    }

                    case "if": {
                        const cond = parseCondition(expr, variable, this);
                        const ifn = new IfNode(matchNode.nodeProvider, cond);
                        ifn.ifToken = matchNode;
                        this.pushBlock(ifn);
                        if (cond instanceof ConditionCompare)
                            this.declareVariable(cond.valueProvider);
                        break;
                    }
                    case "elseif": {
                        const ifn = this.peekBlock(IfNode);
                        if (ifn != null) {
                            const cond = parseCondition(expr, variable, this);
                            ifn.elseIfBranches.push({ token: matchNode, condition: cond, block: undefined });
                            if (cond instanceof ConditionCompare)
                                this.declareVariable(cond.valueProvider);
                        }
                        break;
                    }
                    case "else": {
                        const ifn = this.peekBlock(IfNode);
                        if (ifn != null)
                            ifn.elseToken = matchNode;
                        break;
                    }
                    case "endif": {
                        const ifn = this.popBlock(IfNode);
                        if (ifn != null) {
                            ifn.endIfToken = matchNode;
                            ifn.replaceBlock();
                        }
                        break;
                    }

                    case "foreach": {
                        const vp = ValueProviderBase.tryParse(expr, variable, this);
                        this.assertForeachIsElement(vp, expr);
                        const fn = new ForeachNode(matchNode.nodeProvider, vp!);
                        fn.foreachToken = matchNode;
                        this.pushBlock(fn);
                        this.declareVariable(vp);
                        break;
                    }
                    case "endforeach": {
                        const fn = this.popBlock(ForeachNode);
                        if (fn != null) {
                            fn.endForeachToken = matchNode;
                            this.captureSpreadsheetForeachBlock(fn, matchNode);
                            fn.replaceBlock();
                        }
                        break;
                    }

                    default:
                        this.addError(true, `'${m.keyword}' is deprecated`);
                        break;
                }
            }

            this.closeScope();
        }
    }

    private handleToken(matchNode: MatchNode, expr: string, variable: string | undefined): void {
        const s = splitToken(expr);
        if (s == null) {
            this.addError(true, `${expr} has invalid format`);
            return;
        }

        const vp = ValueProviderBase.tryParse(s.token, variable, this);
        const node = new TokenNode(matchNode.nodeProvider, vp!, s.format);
        node.runProperties = matchNode.runProperties?.cloneNode(true);
        matchNode.parent!.replaceChild(node, matchNode);
        this.declareVariable(vp);
    }

    /** `@foreach[Entity.Details]` over a collection is almost always a missing `.Element` (Signum's check). */
    private assertForeachIsElement(vp: ValueProviderBase | undefined, expr: string): void {
        // The token's TYPE must not be a collection — see the same note in @altea/altea-templating's
        // ValueProviderBase.tryParse. `isCollectionToken()` is a BOUNDARY predicate and would invert this.
        const parsedToken = (vp as { parsedToken?: { queryToken?: QueryToken } } | undefined)?.parsedToken;
        if (parsedToken?.queryToken?.type?.array === true)
            this.addError(false, `@foreach[${expr}] is a collection, missing 'Element' token at the end`);
    }

    /**
     * A row-level `@foreach` in a worksheet is remembered by ROW INDEX before `replaceBlock()` dissolves
     * the markup, so the spreadsheet finalizer can renumber the rows the expansion inserts and shift the
     * formula ranges that referred to them.
     */
    private captureSpreadsheetForeachBlock(fn: ForeachNode, endToken: MatchNode): void {
        if (!(fn.nodeProvider instanceof SpreadsheetNodeProvider))
            return;

        const worksheet = [...fn.foreachToken.ancestors()].find(a => a.qualifiedName === "worksheet");
        const firstRow = rowIndexOf(fn.foreachToken);
        const lastRow = rowIndexOf(endToken);

        if (worksheet != null && firstRow != null && lastRow != null)
            this.spreadsheetForeachBlocks.push({ worksheet, firstRow, lastRow });
    }

    // ---- scopes / block stack ------------------------------------------------------------------

    private newScope(): void {
        if (this.stack.length > 0)
            throw new Error("Stack should be empty");
        this.variables = new ScopedDictionary<ValueProviderBase>(undefined);
    }

    private closeScope(): void {
        if (this.stack.length > 0) {
            const missing = this.stack.map(a =>
                a instanceof IfNode ? "@endif" :
                a instanceof AnyNode ? "@endany" :
                a instanceof ForeachNode ? "@endforeach" :
                "@end?").join(", ");
            this.addError(true, `Missing ${missing}`);
            this.stack.length = 0;
        }
    }

    private pushBlock(node: BlockContainerNode): void {
        this.stack.push(node);
        this.variables = new ScopedDictionary<ValueProviderBase>(this.variables);
    }

    private popBlock<T extends BlockContainerNode>(ctor: abstract new (...args: never[]) => T): T | undefined {
        if (this.stack.length === 0) {
            this.addError(true, `No ${BlockContainerNode.userString(ctor as unknown as Function)} has been opened`);
            return undefined;
        }

        const n = this.stack.pop()!;
        if (!(n instanceof ctor)) {
            this.addError(true, `Unexpected '${BlockContainerNode.userString(n.constructor)}'`);
            return undefined;
        }

        this.variables = this.variables.previous!;
        return n as T;
    }

    private peekBlock<T extends BlockContainerNode>(ctor: abstract new (...args: never[]) => T): T | undefined {
        if (this.stack.length === 0) {
            this.addError(true, `No ${BlockContainerNode.userString(ctor as unknown as Function)} has been opened`);
            return undefined;
        }

        const n = this.stack[this.stack.length - 1];
        if (!(n instanceof ctor)) {
            this.addError(true, `Unexpected '${BlockContainerNode.userString(n.constructor)}'`);
            return undefined;
        }

        // Signum pops the branch's scope and opens a fresh sibling one: `@else` starts a new variable scope
        // at the same depth as the `@if` branch it follows.
        this.variables = new ScopedDictionary<ValueProviderBase>(this.variables.previous);
        return n as T;
    }

    private declareVariable(token: ValueProviderBase | undefined): void {
        const name = token?.variable;
        if (token == null || name == null || name === "")
            return;

        const existing = this.variables.tryGet(name);
        if (existing != null) {
            if (!existing.equalsProvider(token))
                this.addError(true, `There is already a variable '${name}' defined in this scope`);
        } else {
            this.variables.add(name, token);
        }
    }

    // ---- validation ----------------------------------------------------------------------------

    /**
     * Every marker must have been folded into a real node. A leftover MatchNode means an unpaired or
     * misspelled keyword, and Signum reports it with the surrounding text so the author can find it in
     * a document that may be hundreds of paragraphs long.
     */
    assertClean(): void {
        for (const part of this.package_.parts) {
            if (!part.isXml)
                continue;

            const list = part.document.root.descendantsOfType(MatchNode);
            if (list.length === 0)
                continue;

            const detail = list.map(d =>
                `${textBefore(d) ?? "- None - "}\n${d.innerText} <-- Unexpected\n${textAfter(d) ?? "-- None --"}`,
            ).join("\n\n");

            throw new Error(`${list.length} unexpected MatchNode instances found in '${part.uri}': \n${indent(detail, 2)}`);
        }
    }

    /** Every BaseNode still in the package — the renderer's work list. */
    allNodes(): BaseNode[] {
        const out: BaseNode[] = [];
        for (const part of this.package_.parts)
            if (part.isXml)
                out.push(...part.document.root.descendantsOfType(BaseNode));
        return out;
    }
}

// ---- helpers -------------------------------------------------------------------------------------------

const wordprocessing = new WordprocessingNodeProvider();
const drawing = new DrawingNodeProvider();
const spreadsheet = new SpreadsheetNodeProvider();

/** Assign each child the slice of the flattened paragraph text it contributes (Signum's GetElementInfos). */
function getElementInfos(children: readonly OxmlNode[], nodeProvider: INodeProvider): ElementInfo[] {
    const infos = children.map(c => new ElementInfo(c, nodeProvider.isRun(c) ? nodeProvider.getText(c) : undefined));

    let currentPosition = 0;
    for (const ri of infos) {
        ri.interval = { min: currentPosition, max: currentPosition + (ri.text == null ? 0 : ri.text.length) };
        currentPosition = ri.interval.max;
    }

    return infos;
}

/** The `r` attribute of the enclosing `<row>`, as a number. */
function rowIndexOf(node: OxmlNode): number | undefined {
    const row = [...node.ancestors()].find(a => a.qualifiedName === "row");
    const r = row?.getAttribute("r");
    if (r == null)
        return undefined;
    const n = parseInt(r, 10);
    return Number.isNaN(n) ? undefined : n;
}

/** Signum's `Before()`: the nearest preceding sibling (walking up) that carries text. */
function textBefore(element: OxmlNode): string | undefined {
    for (const e of [element, ...element.ancestors()]) {
        const sibling = previousSibling(e);
        if (sibling != null && sibling.innerText !== "")
            return sibling.innerText;
    }
    return undefined;
}

/** Signum's `After()`: the nearest following sibling (walking up) that carries text. */
function textAfter(element: OxmlNode): string | undefined {
    for (const e of [element, ...element.ancestors()]) {
        const sibling = nextSibling(e);
        if (sibling != null && sibling.innerText !== "")
            return sibling.innerText;
    }
    return undefined;
}

function previousSibling(node: OxmlNode): OxmlNode | undefined {
    const p = node.parent;
    if (p == null)
        return undefined;
    const i = p.indexOf(node);
    return i > 0 ? p.childElements[i - 1] : undefined;
}

function nextSibling(node: OxmlNode): OxmlNode | undefined {
    const p = node.parent;
    if (p == null)
        return undefined;
    const i = p.indexOf(node);
    return i >= 0 && i < p.childElements.length - 1 ? p.childElements[i + 1] : undefined;
}

function indent(text: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return text.split("\n").map(l => pad + l).join("\n");
}
