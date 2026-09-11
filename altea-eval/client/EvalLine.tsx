import * as React from "react";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import TypeScriptCodeMirror from "@altea/altea-codemirror/client/TypeScriptCodeMirror";
import type { EvalEmbedded } from "../data/Eval";

// One line for the whole editor sandwich: the generated SIGNATURE above, the code editor, the closing
// brace below — so the author sees the whole function even though only the body is stored. ONE line,
// because there are eight of them in altea-workflow alone and they differ only in the signature.
//
// The COMPILE ERRORS come back as an ordinary field error on `script` — `EvalEmbedded`'s validator is what
// produces them — so they render through the FormGroup like any other validation message, and the
// offending line is highlighted in the editor.
//
// See port/Eval.md.

export interface EvalLineProps<F> {
    ctx: TypeContext<EvalEmbedded<F>>;
    /**
     * The generated function's signature, shown above the editor. It is a HINT: the server builds the real
     * wrapper (see the eval's `compile()`), so keep the two in step.
     */
    signature: string;
    label?: React.ReactNode;
    height?: number;
}

export function EvalLine<F>(p: EvalLineProps<F>): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const scriptCtx = ctx.subCtx(e => e.script);

    function handleCodeChange(newScript: string): void {
        ctx.value.script = newScript;
        forceUpdate();
    }

    return (
        <FormGroup ctx={ctx} label={p.label ?? scriptCtx.niceName()} error={scriptCtx.error}>
            {() => (
                <div className="code-container">
                    <pre style={{ border: "0px", margin: "0px" }}>{p.signature + " {"}</pre>
                    <TypeScriptCodeMirror code={ctx.value.script ?? ""}
                        isReadOnly={ctx.readOnly}
                        errorLineNumber={errorLine(scriptCtx.error)}
                        onChange={handleCodeChange} />
                    <pre style={{ border: "0px", margin: "0px" }}>{"}"}</pre>
                </div>
            )}
        </FormGroup>
    );
}

/**
 * The first line number in a compile-error message, so the editor can mark it. `EvalMessage.Line0_1`
 * formats each diagnostic as `Line {n}: …`, and the numbers are already relative to the SCRIPT (the compiler
 * subtracts the generated preamble), which is what the editor needs.
 */
function errorLine(error: string | undefined): number | undefined {
    const match = error == null ? null : /^\s*Line (\d+):/m.exec(error);
    return match == null ? undefined : Number(match[1]);
}
