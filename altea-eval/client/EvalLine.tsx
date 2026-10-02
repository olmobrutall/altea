import * as React from "react";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import TypeScriptMonaco from "@altea/altea-monaco/client/TypeScriptMonaco";
import type { MonacoMarker } from "@altea/altea-monaco/client/MonacoComponent";
import { useEvalIntelliSense, type EvalIntelliSense } from "./EvalIntelliSense";
import { EvalMessage, type EvalEmbedded, type EvalFunction } from "../data/Eval";

// One line for the whole editor sandwich: the generated IMPORTS and SIGNATURE above, the script, the
// closing brace below — so the author sees the whole function even though only the body is stored. ONE
// line, because there are eight of them in altea-workflow alone and they differ only in the signature.
//
// The sandwich used to be three ELEMENTS: a `<pre>`, an editor, a `<pre>`. It is now one MODEL, with
// everything but the script banded and refusing edits (see MonacoComponent). That is not cosmetic — a
// function body means nothing to a type checker on its own, and this is what lets Monaco see the
// parameters and the imports the script is written against.
//
// THE IMPORTS ARE WRITTEN HERE, and they are the same ones the server writes. The eager half comes with
// the configuration; the lazy half is discovered by asking Monaco which names it could not resolve and
// looking each up — which is, deliberately, the identical pass EvalCompiler runs (see EvalIntelliSense).
// If the two ever disagree, the editor is wrong and the save is right, which is the safe way round.
//
// ONE KNOWN GAP: an import the author writes at the top of the script. The server HOISTS it above the
// signature (`hoistImports`, so it is legal where TypeScript requires imports to be) and it wins over the
// implicit one; the editor leaves it in the body, where Monaco calls it a misplaced import declaration.
// The script still compiles and still saves — the implicit pass resolves the same names anyway — so the
// cost is a spurious squiggle, and the disambiguation the explicit import buys on the server is not
// reflected here. Closing it needs an editable region ABOVE the signature as well as below it, which the
// one-header/one-footer model cannot express.
//
// The COMPILE ERRORS still come back as an ordinary field error on `script` — `EvalEmbedded`'s validator
// is what produces them — so they render through the FormGroup like any other validation message, and
// every line they name is marked in the editor. Monaco's own diagnostics are the fast feedback; the
// server's are the verdict.
//
// See port/Eval.md.

export interface EvalLineProps<F extends EvalFunction> {
    ctx: TypeContext<EvalEmbedded<F>>;
    /**
     * The generated function's parameter list, e.g. `"e: OrderEntity, ctx: WorkflowTransitionContext"`.
     *
     * The SAME three inputs the eval's own `compile()` hands `EvalEmbedded.wrap`, so the signature above the
     * editor is the one the server really generates rather than a hand-written approximation of it. It used
     * to be a prose `signature` string, which is how the editor came to show a NON-async wrapper for an
     * async eval — flagging every `await` an author wrote, in a script the server compiles happily.
     */
    parameters: string;
    /** Its LOGICAL return type, e.g. `"boolean"`. Emitted as `Promise<Awaited<…>>` when {@link isAsync}. */
    returnType: string;
    /** `async`, when the script may `await`. */
    isAsync?: boolean;
    label?: React.ReactNode;
    height?: number;
}

export function EvalLine<F extends EvalFunction>(p: EvalLineProps<F>): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const scriptCtx = ctx.subCtx(e => e.script);
    const script = ctx.value.script ?? "";

    const intelliSense = useEvalIntelliSense();

    // A path under the root the declarations were laid out for, so a relative specifier (`./app/orders/…`,
    // which is how an app's own modules are named) resolves — and distinct per line, so two editors on one
    // page do not share a program.
    const path = React.useMemo(() => `file:///eval/__altea_eval_${nextEditorId++}__.ts`, []);

    // The names this script turned out to need. Only ever grows while the line shows ONE eval: a name that
    // resolved once stays resolvable, and re-checking after every keystroke would make the editor flicker
    // between knowing and not knowing what `OrderEntity` is.
    const [implicit, setImplicit] = React.useState<readonly string[]>([]);

    // ...but it is reset when the line is pointed at a DIFFERENT eval. React reuses a component instance
    // across a navigation that lands on the same shape of page, so without this the names the LAST entity
    // needed are still written into this one's header — an email template for a password reset carrying an
    // `import { OrderEntity }` it never asked for, from the workflow condition edited before it.
    const subject = ctx.value;
    React.useEffect(() => setImplicit([]), [subject]);

    const header = React.useMemo(
        () => buildHeader(intelliSense, implicit, signature(p)),
        [intelliSense, implicit, p.parameters, p.returnType, p.isAsync]);

    // The same implicit-import pass the server runs, against the model the author is typing into. Debounced
    // because it costs a round trip to the worker, and a declaration fetch when it finds something.
    React.useEffect(() => {
        if (intelliSense == null)
            return;

        let cancelled = false;
        const handle = setTimeout(() => void (async () => {
            const unresolved = await intelliSense.unresolvedNames(path);
            const found = unresolved.filter(n =>
                intelliSense.specifierFor(n) != null && !implicit.includes(n));
            if (found.length === 0 || cancelled)
                return;

            await intelliSense.load(found.map(n => intelliSense.specifierFor(n)!));
            if (!cancelled)
                setImplicit(previous => [...new Set([...previous, ...found])]);
        })(), 400);

        return () => { cancelled = true; clearTimeout(handle); };
    }, [intelliSense, path, script, header, implicit]);

    function handleCodeChange(newScript: string): void {
        ctx.value.script = newScript;
        forceUpdate();
    }

    const markers = React.useMemo(() => errorMarkers(scriptCtx.error), [scriptCtx.error]);

    return (
        <FormGroup ctx={ctx} label={p.label ?? scriptCtx.niceName()} error={scriptCtx.error}>
            {() => (
                <TypeScriptMonaco code={script}
                    header={header}
                    footer={"}"}
                    path={path}
                    isReadOnly={ctx.readOnly}
                    height={p.height}
                    markers={markers}
                    fenceHint={EvalMessage.TheWrapperIsGeneratedEditTheScriptBetweenTheBraces.niceToString()}
                    onChange={handleCodeChange} />
            )}
        </FormGroup>
    );
}

/**
 * The generated module above the script: what every script gets, then what this one turned out to need,
 * then the signature. Identical in shape to what `EvalEmbedded.wrap` builds on the server — the author is
 * looking at the real thing, not a mock-up of it.
 */
function buildHeader(intelliSense: EvalIntelliSense | null, implicit: readonly string[],
    signature: string): string {

    if (intelliSense == null)
        return signature + " {";        // before the configuration lands, the signature alone

    const grouped = new Map<string, string[]>();
    for (const name of implicit) {
        const specifier = intelliSense.specifierFor(name);
        if (specifier == null)
            continue;
        let group = grouped.get(specifier);
        if (group == null)
            grouped.set(specifier, group = []);
        group.push(name);
    }

    return [
        ...intelliSense.eagerLines,
        ...[...grouped].map(([specifier, names]) =>
            `import { ${names.sort().join(", ")} } from "${specifier}";`),
        "",
        signature + " {",
    ].join("\n");
}

/**
 * Every `Line {n}: {message}` in a compile error, as a marker. The numbers are already relative to the
 * SCRIPT — the compiler subtracts the generated wrapper before reporting — which is exactly what the
 * editor wants, and one error message can name several lines.
 */
function errorMarkers(error: string | undefined): MonacoMarker[] {
    if (error == null)
        return [];

    return [...error.matchAll(/^\s*Line (\d+): (.*)$/gm)]
        .map(m => ({ line: Number(m[1]), message: m[2] }));
}

/**
 * The generated function's opening line — character for character what `EvalEmbedded.wrap` emits on the
 * server, which is the point: the author is looking at the real wrapper, and anything they write is
 * checked against it rather than against a plausible-looking stand-in.
 */
function signature(p: { parameters: string; returnType: string; isAsync?: boolean }): string {
    return `export default ${p.isAsync ? "async " : ""}function evaluate(${p.parameters}): `
        + (p.isAsync ? `Promise<Awaited<${p.returnType}>>` : p.returnType);
}

let nextEditorId = 1;
