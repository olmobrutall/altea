import ts from "typescript";
import type { ClassMap, Kind } from "./ClassMap.js";

export interface SweepOptions {
    /** The kinds rewritten; every other mapped class is reported. */
    apply: Kind[];
    /** Sections of the map left alone entirely (not rewritten, not reported). */
    skipSections?: string[];
    /** When set, only these sections of the map are looked at. */
    onlySections?: string[];
}

export interface SweepReport {
    line: number;
    text: string;
    reason: "component" | "manual" | "dynamic" | "outside-class-context" | "not-applied";
}

export interface SweepResult {
    content: string;
    changed: number;
    reports: SweepReport[];
}

/** `className`, `class`, `labelClassName`, `buttonClass`, `extraClasses`, … */
const CLASS_NAME = /^(class|className|classes|\w*(Class|ClassName|Classes))$/;
const CLASS_FUNCTIONS = new Set(["classes", "cn", "clsx", "classNames"]);
const CLASS_LIST_METHODS = new Set(["add", "remove", "toggle", "contains", "replace"]);

/**
 * Rewrites Bootstrap classes into their Tailwind / altea translation, but only inside string literals that
 * ARE class lists: a className attribute, a `classes(…)` / `cn(…)` argument, a `*Class` / `*ClassName`
 * property, variable, getter or method, a `classList` call. A string anywhere else is left alone even if
 * it looks like a class — `"small"` is as likely a size as a class — and reported when every word in it is
 * a mapped class, so a human decides.
 */
export function sweepSource(fileName: string, content: string, map: ClassMap, options: SweepOptions): SweepResult {
    const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true,
        fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

    const edits: { start: number; end: number; text: string }[] = [];
    const reports: SweepReport[] = [];
    const inContext = new Set<ts.Node>();
    let changed = 0;

    const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
    const report = (node: ts.Node, text: string, reason: SweepReport["reason"]): void => {
        reports.push({ line: lineOf(node.getStart(source)), text, reason });
    };

    const lookup = (cls: string) => {
        const t = map.translate(cls);
        return t == null || options.skipSections?.includes(t.section) || (options.onlySections && !options.onlySections.includes(t.section)) ? undefined : t;
    };

    /** Rewrites the whole words of a literal; a word touching a `${}` or `+` boundary is reported, not guessed. */
    function rewriteText(node: ts.Node, text: string, openStart: boolean, openEnd: boolean): string {
        const parts = text.split(/(\s+)/);
        const overridden = overriddenByLaterRule(parts);
        return parts.map((word, i) => {
            if (overridden.has(word)) {
                changed++;
                return "";
            }
            if (word.length === 0 || /^\s+$/.test(word))
                return word;
            const touchesStart = i === 0 && openStart;
            const touchesEnd = i === parts.length - 1 && openEnd;
            if (touchesStart || touchesEnd) {
                if (/^[a-z]+(-[a-z0-9]+)*-$/.test(word) && looksBootstrapPrefix(word, map))
                    report(node, word + "…", "dynamic");
                return word;
            }
            const t = lookup(word);
            if (t == null)
                return word;
            if (!options.apply.includes(t.kind)) {
                report(node, word, t.kind === "C" ? "component" : t.kind === "M" ? "manual" : "not-applied");
                return word;
            }
            changed++;
            return t.classes.join(" ");
        }).join("").replace(/ {2,}/g, " ");
    }

    function literal(node: ts.Node, concatenated: { left: boolean; right: boolean }): void {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            const replaced = rewriteText(node, node.text, concatenated.left, concatenated.right);
            if (replaced !== node.text) {
                const quote = content[node.getStart(source)];
                edits.push({ start: node.getStart(source) + 1, end: node.getEnd() - 1, text: escapeFor(replaced, quote) });
            }
        } else if (ts.isTemplateExpression(node)) {
            const pieces: [ts.TemplateLiteralLikeNode, boolean, boolean][] = [
                [node.head, concatenated.left, true],
                ...node.templateSpans.map((s, i): [ts.TemplateLiteralLikeNode, boolean, boolean] =>
                    [s.literal, true, i < node.templateSpans.length - 1 || concatenated.right]),
            ];
            for (const [piece, openStart, openEnd] of pieces) {
                const raw = piece.rawText ?? piece.text;
                const replaced = rewriteText(piece, raw, openStart, openEnd);
                if (replaced !== raw) {
                    const start = piece.getStart(source) + 1;
                    const end = piece.getEnd() - (ts.isTemplateTail(piece) ? 1 : 2);
                    edits.push({ start, end, text: replaced });
                }
            }
        }
    }

    function classExpression(node: ts.Node, concatenated = { left: false, right: false }): void {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
            inContext.add(node);
            literal(node, concatenated);
            return;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            classExpression(node.left, { left: concatenated.left, right: true });
            classExpression(node.right, { left: true, right: concatenated.right });
            return;
        }
        if (ts.isConditionalExpression(node)) {
            classExpression(node.whenTrue);
            classExpression(node.whenFalse);
            return;
        }
        if (ts.isBinaryExpression(node)) {
            const op = node.operatorToken.kind;
            if (op === ts.SyntaxKind.AmpersandAmpersandToken)
                classExpression(node.right);
            else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
                classExpression(node.left);
                classExpression(node.right);
            }
            return;
        }
        if (ts.isCallExpression(node)) {
            if (ts.isIdentifier(node.expression) && CLASS_FUNCTIONS.has(node.expression.text))
                node.arguments.forEach(a => classExpression(a));
            return;
        }
        if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node) || ts.isArrayLiteralExpression(node)
            || ts.isAsExpression(node) || ts.isNonNullExpression(node))
            ts.forEachChild(node, child => classExpression(child));
    }

    function returnsOf(body: ts.Node): void {
        if (ts.isReturnStatement(body)) {
            if (body.expression)
                classExpression(body.expression);
            return;
        }
        if (ts.isFunctionLike(body))
            return;
        ts.forEachChild(body, returnsOf);
    }

    function nameOf(name: ts.Node | undefined): string | undefined {
        if (name == null)
            return undefined;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))
            return name.text;
        return undefined;
    }

    function visit(node: ts.Node): void {
        if (ts.isJsxAttribute(node) && CLASS_NAME.test(node.name.getText(source)) && node.initializer) {
            classExpression(node.initializer);
            return;
        }
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
            const isClassList = ts.isPropertyAccessExpression(callee) && CLASS_LIST_METHODS.has(callee.name.text)
                && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "classList";
            if ((name && CLASS_FUNCTIONS.has(name) && ts.isIdentifier(callee)) || isClassList) {
                node.arguments.forEach(a => classExpression(a));
                return;
            }
        }
        if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node))
            && CLASS_NAME.test(nameOf(node.name) ?? "") && node.initializer) {
            classExpression(node.initializer);
            return;
        }
        if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "className"
            && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
            classExpression(node.right);
            return;
        }
        if ((ts.isGetAccessorDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node))
            && CLASS_NAME.test(nameOf(node.name) ?? "") && node.body) {
            returnsOf(node.body);
            return;
        }
        if (ts.isStringLiteral(node) && !inContext.has(node) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent))
            reportLookalike(node);
        ts.forEachChild(node, visit);
    }

    function reportLookalike(node: ts.StringLiteral): void {
        const words = node.text.trim().split(/\s+/);
        if (words.length === 0 || words[0] === "")
            return;
        const translations = words.map(w => lookup(w));
        if (translations.every(t => t != null && options.apply.includes(t.kind)) && words.some(w => w.includes("-")))
            report(node, node.text, "outside-class-context");
    }

    visit(source);

    edits.sort((a, b) => b.start - a.start);
    let result = content;
    for (const e of edits)
        result = result.slice(0, e.start) + e.text + result.slice(e.end);

    return { content: result, changed, reports };
}

/**
 * Two Bootstrap classes setting the same property resolve by Bootstrap's CSS order, and two translated
 * utilities would not resolve the same way. `display-6 h2` (a Signum idiom) is a display size: `.display-*`
 * and `.lead` come after `.h1`…`.h6` in bootstrap.css, so the heading class is dropped.
 */
function overriddenByLaterRule(words: string[]): Set<string> {
    if (!words.some(w => /^display-\d$/.test(w) || w === "lead"))
        return new Set();
    return new Set(words.filter(w => /^h[1-6]$/.test(w)));
}

function escapeFor(text: string, quote: string): string {
    return quote === "`" ? text : text.replace(new RegExp(quote, "g"), "\\" + quote);
}

/** `text-`, `btn-outline-`, `bg-` — a prefix some mapped class starts with. */
function looksBootstrapPrefix(prefix: string, map: ClassMap): boolean {
    return ["text-", "bg-", "border-", "btn-", "alert-", "badge-", "text-bg-", "link-", "table-", "col-", "d-", "m", "p"]
        .some(p => prefix === p || (p.length > 1 && prefix.startsWith(p))) && map.size > 0;
}
