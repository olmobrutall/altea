import { initialize, TypeScriptWorker, ts as services } from "monaco-editor/esm/vs/language/typescript/ts.worker";
import type * as T from "typescript";
import type { ClassInfo, DecoratorInfo, MemberInfo, NamespaceInfo, NamespaceMemberInfo, Span, SyntaxContext, TypeShape } from "./syntaxContext";

// Monaco's TypeScript worker, extended. `customWorkerPath` would be the documented way, but it loads the
// extension with `importScripts`, which a module worker (what the bundler builds) does not have — so this
// is the worker entry instead: importing Monaco's module installs its own `onmessage`, and the assignment
// below replaces it before the first message arrives.
//
// What it adds is read from the program the worker already holds, so it is exact and costs no second
// parse: `alteaSyntaxContext` (see ./syntaxContext).

const ts = services.typescript;

class AlteaTypeScriptWorker extends TypeScriptWorker {

    async alteaSyntaxContext(fileName: string, offset: number): Promise<SyntaxContext | null> {
        const source = this._languageService.getProgram()?.getSourceFile(fileName);
        if (source == null)
            return null;

        const classes = source.statements.filter(ts.isClassDeclaration).map(c => classInfo(c, source));
        const cls = classes.find(c => c.start <= offset && offset <= c.end);
        // From the start of its LINE: a cursor in the indentation is on the member too.
        const member = cls?.members.find(m => m.lineStart <= offset && offset <= m.end);
        const namespaces = source.statements.filter(ts.isModuleDeclaration).map(n => namespaceInfo(n, source));
        return { class: cls, member, classes, namespaces };
    }
}

function span(node: T.Node, source: T.SourceFile): Span {
    return { start: node.getStart(source), end: node.getEnd() };
}

function classInfo(c: T.ClassDeclaration, source: T.SourceFile): ClassInfo {
    const extendsClause = c.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    const open = c.members.pos;
    return {
        ...span(c, source),
        name: c.name?.text ?? "",
        nameSpan: c.name != null ? span(c.name, source) : { start: c.getStart(source), end: c.getStart(source) },
        exported: (ts.getModifiers(c) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword),
        baseText: extendsClause?.types[0]?.getText(source),
        decorators: decorators(c, source),
        bodyStart: open,
        bodyEnd: c.getEnd() - 1,
        members: c.members.map(m => memberInfo(m, source)),
    };
}

function memberInfo(m: T.ClassElement, source: T.SourceFile): MemberInfo {
    const start = m.getStart(source);
    const lineStart = source.text.lastIndexOf("\n", start - 1) + 1;
    const indent = /^[ \t]*/.exec(source.text.slice(lineStart, start))?.[0] ?? "";
    const name = m.name;

    const info: MemberInfo = {
        start,
        end: m.getEnd(),
        kind: ts.isPropertyDeclaration(m) ? "property"
            : ts.isMethodDeclaration(m) ? "method"
                : ts.isGetAccessorDeclaration(m) ? "getter"
                    : ts.isSetAccessorDeclaration(m) ? "setter"
                        : ts.isConstructorDeclaration(m) ? "constructor" : "other",
        name: name?.getText(source) ?? "",
        nameSpan: name != null ? span(name, source) : { start, end: start },
        lineStart,
        indent,
        accessor: false,
        decorators: decorators(m, source),
    };

    const accessorKeyword = (ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).find(x => x.kind === ts.SyntaxKind.AccessorKeyword);
    if (accessorKeyword != null) {
        info.accessor = true;
        info.accessorSpan = span(accessorKeyword, source);
    }

    if (ts.isPropertyDeclaration(m)) {
        if (m.type != null) {
            info.typeText = m.type.getText(source);
            info.typeSpan = span(m.type, source);
            info.typeShape = typeShape(m.type, source);
        }
        if (m.initializer != null) {
            info.initializerSpan = span(m.initializer, source);
            info.initializerText = m.initializer.getText(source);
        }
    }
    return info;
}

function lineStartOf(source: T.SourceFile, position: number): number {
    return source.text.lastIndexOf("\n", position - 1) + 1;
}

function indentOf(source: T.SourceFile, position: number): string {
    return /^[ \t]*/.exec(source.text.slice(lineStartOf(source, position), position))?.[0] ?? "";
}

function namespaceInfo(n: T.ModuleDeclaration, source: T.SourceFile): NamespaceInfo {
    const start = n.getStart(source);
    const block = n.body != null && ts.isModuleBlock(n.body) ? n.body : undefined;
    const close = n.getEnd() - 1;
    const members: NamespaceMemberInfo[] = [];

    for (const s of block?.statements ?? []) {
        const sStart = s.getStart(source);
        if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations)
                members.push({
                    kind: "const", name: d.name.getText(source), typeText: d.type?.getText(source),
                    start: sStart, end: s.getEnd(), indent: indentOf(source, sStart),
                });
        } else if (ts.isFunctionDeclaration(s)) {
            const body = s.body;
            members.push({
                kind: "function", name: s.name?.text ?? "", start: sStart, end: s.getEnd(), indent: indentOf(source, sStart),
                bodyStart: body != null ? body.getStart(source) + 1 : undefined,
                closeLineStart: body != null ? lineStartOf(source, body.getEnd() - 1) : undefined,
            });
        } else {
            members.push({ kind: "other", name: "", start: sStart, end: s.getEnd(), indent: indentOf(source, sStart) });
        }
    }

    return {
        start,
        end: n.getEnd(),
        name: n.name.getText(source),
        exported: (ts.getModifiers(n) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword),
        indent: indentOf(source, start),
        bodyStart: block != null ? block.getStart(source) + 1 : close,
        closeLineStart: lineStartOf(source, close),
        members,
    };
}

function decorators(node: T.Node, source: T.SourceFile): DecoratorInfo[] {
    return (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []).map(d => {
        const call = ts.isCallExpression(d.expression) ? d.expression : undefined;
        const callee = call?.expression ?? d.expression;
        const result: DecoratorInfo = { ...span(d, source), name: callee.getText(source) };
        if (call != null) {
            // Between the parentheses, whether or not there are arguments.
            const open = source.text.indexOf("(", callee.getEnd());
            const close = call.getEnd() - 1;
            result.argsSpan = { start: open + 1, end: close };
            result.argsText = source.text.slice(open + 1, close);
        }
        return result;
    });
}

function typeShape(type: T.TypeNode, source: T.SourceFile): TypeShape | undefined {
    let core = type;
    let nullable = false;
    if (ts.isUnionTypeNode(type)) {
        const rest = type.types.filter(t => !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword));
        if (rest.length !== 1)
            return undefined;
        nullable = rest.length < type.types.length;
        core = rest[0];
    }

    let array = false;
    if (ts.isArrayTypeNode(core)) {
        array = true;
        core = core.elementType;
    }

    let lite = false;
    if (ts.isTypeReferenceNode(core) && core.typeName.getText(source) === "Lite" && core.typeArguments?.length === 1) {
        lite = true;
        core = core.typeArguments[0];
    }

    return { base: core.getText(source), lite, array, nullable };
}

self.onmessage = () => initialize((ctx, createData) => new AlteaTypeScriptWorker(ctx, createData));
