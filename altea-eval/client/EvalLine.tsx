import * as React from "react";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { MonacoMarker } from "@altea/altea-monaco/client/MonacoComponent";
import { EvalMonaco } from "./EvalMonaco";
import { EvalMessage, type EvalEmbedded, type EvalFunction } from "../data/Eval";

// One line for the whole editor sandwich: the generated IMPORTS and SIGNATURE above, the script, the
// closing brace below — so the author sees the whole function even though only the body is stored. ONE
// line, because there are eight of them in altea-workflow alone and they differ only in the signature.
//
// The sandwich used to be three ELEMENTS: a `<pre>`, an editor, a `<pre>`. It is now one MODEL, with
// everything but the script banded and refusing edits (see MonacoComponent). That is not cosmetic — a
// function body means nothing to a type checker on its own, and this is what lets Monaco see the
// parameters and the imports the script is written against (see EvalMonaco).
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

    function handleCodeChange(newScript: string): void {
        ctx.value.script = newScript;
        forceUpdate();
    }

    const markers = React.useMemo(() => errorMarkers(scriptCtx.error), [scriptCtx.error]);

    return (
        <FormGroup ctx={ctx} label={p.label ?? scriptCtx.niceName()} error={scriptCtx.error}>
            {() => (
                <EvalMonaco code={ctx.value.script ?? ""}
                    header={[{ text: signature(p) + " {" }]}
                    footer={[{ text: "}" }]}
                    subject={ctx.value}
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

