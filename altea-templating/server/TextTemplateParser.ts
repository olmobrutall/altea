import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { cleanTypeName } from "@altea/altea/data/registration";
import { ValueProviderBase, type ITemplateParser } from "./ValueProviders";
import type { ConditionBase } from "./Conditions";
import { ConditionCompare } from "./Conditions";
import {
    parseCondition, scanKeywords, splitToken, ScopedDictionary, TemplateError,
} from "./TemplateUtils";
import {
    AnyNode, BlockNode, DeclareNode, ForeachNode, IfNode, LiteralNode, ValueNode,
} from "./TextTemplateParser.Nodes";
import type { TemplateSynchronizationContext } from "./TemplateSync";
import type { Type, BaseEntity } from "@altea/altea/data/entity";
import type { ModelClass } from "./ValueProviders";

// Port of Signum.Templating's TextTemplateParser.cs — see port/Templating.md.
//
// Text with `@…` markers → a BlockNode tree. The parser carries the QUERY NAME (tokens resolve from
// registered metadata), and the keyword scan is `scanKeywords` rather than one regex, because a bracket
// body needs balanced nesting.

export namespace TextTemplateParser {

    /** Throw on ANY error (used when saving a template: the text must be valid). */
    export function parse(text: string | null | undefined, queryName: QueryName | undefined, modelType: ModelClass | undefined): BlockNode {
        return new TextTemplateParserImp(text, queryName, modelType).parse();
    }

    /** Always returns a tree; the errors come back as one message (used by the
     *  property validators, so a bad template shows as a validation error instead of an exception). */
    export function tryParse(text: string | null | undefined, queryName: QueryName | undefined, modelType: ModelClass | undefined): { node: BlockNode; errorMessage: string } {
        return new TextTemplateParserImp(text, queryName, modelType).tryParse();
    }

    /**
     * Signum's `TextTemplateParser.Synchronize` — the BODY-TEXT half of the token migration: parse the
     * stored text, repair every token in it against the recorded renames, and write it back out.
     *
     * `tryParse`, not `parse`: the whole reason to run this is that the text no longer parses cleanly, so
     * throwing on the first bad token would skip exactly the templates that need fixing. The errors are
     * ignored here for the same reason — a token that could not be resolved is what `synchronize` then
     * asks about.
     *
     * Answers the text UNCHANGED unless something was actually rewritten (`sc.hasChanges`), so a caller
     * can compare by identity and a clean template is never re-saved. The re-print is `TextNode.write`,
     * the same path `toString` uses.
     */
    export async function synchronize(
        text: string | null | undefined,
        sc: TemplateSynchronizationContext,
    ): Promise<string | null | undefined> {
        if (text == undefined || text === "")
            return text;

        const { node } = tryParse(text, sc.queryName, sc.modelType);

        // SELF-CHECK, before anything is touched: does this tree print back as the text it came from?
        //
        // Not paranoia about `write` — about `tryParse`. A token that fails to RESOLVE is a non-fatal
        // error and leaves the tree complete (which is the whole state this pass exists to repair), but a
        // FATAL one — a template body with tokens and no query, an `as $x` colliding with an outer scope —
        // aborts the parse mid-way, and the tree is then a PREFIX of the template. Writing that back would
        // silently truncate somebody's template instead of repairing it.
        //
        // Signum writes back unconditionally. Refusing loudly is the better failure: the template is left
        // exactly as it was, and the operator is told which one to look at.
        if (print(node) !== text) {
            SafeConsole.writeLineColor(Color.darkRed,
                `  ${cleanTypeName(sc.template.getType())} '${sc.template.toString()}': the body did not`
                + ` parse back to itself, so it is left UNCHANGED. Fix the template by hand.`);
            return text;
        }

        await node.synchronize(sc);

        return sc.hasChanges ? print(node) : text;
    }

    function print(node: BlockNode): string {
        const sb: string[] = [];
        node.write(sb, new ScopedDictionary<ValueProviderBase>(undefined));
        return sb.join("");
    }

    class TextTemplateParserImp implements ITemplateParser {
        private readonly text: string;
        private mainBlock: BlockNode = null!;
        private stack: BlockNode[] = [];
        private errors: TemplateError[] = [];

        variables: ScopedDictionary<ValueProviderBase> = null!;
        readonly modelType: ModelClass | undefined;
        readonly queryName: QueryName | undefined;

        constructor(text: string | null | undefined, queryName: QueryName | undefined, modelType: ModelClass | undefined) {
            this.text = text ?? "";
            this.queryName = queryName;
            this.modelType = modelType;
        }

        assertQueryName(action: string): QueryName {
            if (this.queryName == undefined)
                throw new Error(`No Query selected! Unable to ${action}`);
            return this.queryName;
        }

        addError(fatal: boolean, message: string): void {
            this.errors.push(new TemplateError(fatal, message));
        }

        parse(): BlockNode {
            this.parseInternal();
            if (this.errors.length > 0)
                throw new Error(this.errors.map(a => a.message).join("\n"));
            return this.mainBlock;
        }

        tryParse(): { node: BlockNode; errorMessage: string } {
            this.parseInternal();
            return { node: this.mainBlock, errorMessage: this.errors.map(a => a.message).join("\n") };
        }

        private declareVariable(valueProvider: ValueProviderBase | undefined): void {
            const variable = valueProvider?.variable;
            if (variable == undefined || variable === "")
                return;

            if (this.variables.hasOwn(variable))
                this.addError(true, `There is already a variable '${variable}' defined in this scope`);

            this.variables.add(variable, valueProvider!);
        }

        private popBlock(type: Function): BlockNode | undefined {
            if (this.stack.length <= 1) {
                this.addError(true, `No ${BlockNode.userString(type)} has been opened`);
                return undefined;
            }
            const n = this.stack.pop()!;
            this.variables = this.variables.previous!;
            if (n.owner == undefined || n.owner.constructor !== type) {
                this.addError(true, `Unexpected '${BlockNode.userString(n.owner)}'`);
                return undefined;
            }
            return n;
        }

        private pushBlock(block: BlockNode): void {
            this.stack.push(block);
            this.variables = new ScopedDictionary<ValueProviderBase>(this.variables);
        }

        private get peek(): BlockNode { return this.stack[this.stack.length - 1]; }

        private parseInternal(): void {
            try {
                this.mainBlock = new BlockNode(undefined);
                this.stack = [];
                this.errors = [];
                this.variables = new ScopedDictionary<ValueProviderBase>(undefined);
                this.pushBlock(this.mainBlock);

                const matches = scanKeywords(this.text);

                if (matches.length === 0) {
                    this.peek.nodes.push(new LiteralNode(this.text));
                    this.stack.pop();
                    return;
                }

                let index = 0;
                for (const match of matches) {
                    if (index < match.index)
                        this.peek.nodes.push(new LiteralNode(this.text.slice(index, match.index)));

                    const { expr, keyword, dec: variable } = match;
                    switch (keyword) {
                        case "":
                        case "raw": {
                            const s = splitToken(expr);
                            if (s == undefined) {
                                this.addError(true, `${expr} has invalid format`);
                            } else {
                                const t = ValueProviderBase.tryParse(s.token, variable, this);
                                this.peek.nodes.push(new ValueNode(t, s.format, keyword === "raw"));
                                this.declareVariable(t);
                            }
                            break;
                        }
                        case "declare": {
                            const t = ValueProviderBase.tryParse(expr, variable, this);
                            this.peek.nodes.push(new DeclareNode(t, (f, e) => this.addError(f, e)));
                            this.declareVariable(t);
                            break;
                        }
                        case "any": {
                            const cond: ConditionBase = parseCondition(expr, variable, this);
                            const any = new AnyNode(cond);
                            this.peek.nodes.push(any);
                            this.pushBlock(any.anyBlock);
                            if (cond instanceof ConditionCompare)
                                this.declareVariable(cond.valueProvider);
                            break;
                        }
                        case "notany": {
                            const an = this.popBlock(AnyNode)?.owner as AnyNode | undefined;
                            if (an != undefined)
                                this.pushBlock(an.createNotAny());
                            break;
                        }
                        case "endany":
                            this.popBlock(AnyNode);
                            break;
                        case "foreach": {
                            const vp = ValueProviderBase.tryParse(expr, variable, this);
                            if (vp != undefined && vp.type?.array === true && !isElementToken(vp))
                                this.addError(false, `@foreach[${expr}] is a collection, missing 'Element' token at the end`);

                            const fn = new ForeachNode(vp);
                            this.peek.nodes.push(fn);
                            this.pushBlock(fn.block);
                            if (vp != undefined)
                                vp.isForeach = true;
                            this.declareVariable(vp);
                            break;
                        }
                        case "endforeach":
                            this.popBlock(ForeachNode);
                            break;
                        case "if": {
                            const cond: ConditionBase = parseCondition(expr, variable, this);
                            const ifn = new IfNode(cond);
                            this.peek.nodes.push(ifn);
                            this.pushBlock(ifn.ifBlock);
                            if (cond instanceof ConditionCompare)
                                this.declareVariable(cond.valueProvider);
                            break;
                        }
                        case "elseif": {
                            const ifn = this.popBlock(IfNode)?.owner as IfNode | undefined;
                            if (ifn != undefined) {
                                const cond: ConditionBase = parseCondition(expr, variable, this);
                                this.pushBlock(ifn.createElseIf(cond));
                                if (cond instanceof ConditionCompare)
                                    this.declareVariable(cond.valueProvider);
                            }
                            break;
                        }
                        case "else": {
                            const ifn = this.popBlock(IfNode)?.owner as IfNode | undefined;
                            if (ifn != undefined)
                                this.pushBlock(ifn.createElse());
                            break;
                        }
                        case "endif":
                            this.popBlock(IfNode);
                            break;
                        default:
                            this.addError(true, `'${keyword}' is deprecated`);
                            break;
                    }
                    index = match.index + match.length;
                }

                if (this.stack.length !== 1)
                    this.addError(true, `Last block is not closed: ${BlockNode.userString(this.peek.owner)}`);

                const lastM = matches[matches.length - 1];
                if (lastM.index + lastM.length < this.text.length)
                    this.peek.nodes.push(new LiteralNode(this.text.slice(lastM.index + lastM.length)));

                this.stack.pop();
            } catch (e) {
                this.addError(true, (e as Error).message);
            }
        }
    }

    /** The query a template's tokens were written against, for an error message. */
    export function queryKeyOf(queryName: QueryName | undefined): string {
        return queryName == undefined ? "" : getKey(queryName);
    }
}

/** True when the @foreach's provider already ends in an `Element` token (so it yields the ELEMENT, not
 *  the collection). `isElement()` says exactly that. */
function isElementToken(vp: ValueProviderBase): boolean {
    const anyVp = vp as { parsedToken?: { queryToken?: { isElement(): boolean } } };
    return anyVp.parsedToken?.queryToken?.isElement() ?? false;
}

export { BlockNode, TextTemplateParameters } from "./TextTemplateParser.Nodes";
