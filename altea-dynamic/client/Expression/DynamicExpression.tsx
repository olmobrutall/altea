import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import TypeScriptCodeMirror from "@altea/altea-codemirror/client/TypeScriptCodeMirror";
import type { DynamicExpressionEntity } from "../../data/DynamicExpression";

// Port of Signum.Dynamic's Expression/DynamicExpression.tsx — the editor for a query expression defined
// from the running application.
//
// altea divergences:
//  - the SIGNATURE line shows what is actually generated: `(e: FromType) => ReturnType`, where Signum
//    shows a C# `static Expression<Func<FromType, ReturnType>>`. It is the real shape (see
//    DynamicExpressionLogic), so an author writing `e.…` can see why.
//  - Signum's "Test" button, which compiles the body a second time as a delegate and evaluates it against
//    one entity, is NOT ported: `IDynamicExpressionEvaluator` has no counterpart (see the entity), and the
//    compile that matters happens on the next restart, where its diagnostics reach the dynamic panel.
export default function DynamicExpressionComponent(p: { ctx: TypeContext<DynamicExpressionEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    function handleCodeChange(newBody: string): void {
        ctx.value.body = newBody;
        forceUpdate();
    }

    const signature = "(e: " + (ctx.value.fromType || "…") + ") => " + (ctx.value.returnType || "…");

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(a => a.name)} onChange={forceUpdate} />
            <AutoLine ctx={ctx.subCtx(a => a.fromType)} onChange={forceUpdate} />
            <AutoLine ctx={ctx.subCtx(a => a.returnType)} onChange={forceUpdate} />
            <AutoLine ctx={ctx.subCtx(a => a.format)} />
            <AutoLine ctx={ctx.subCtx(a => a.unit)} />
            <EnumLine ctx={ctx.subCtx(a => a.translation)} />

            <div className="mt-3">
                <pre className="mb-1"><small>{signature}</small></pre>
                <div className="code-container">
                    <TypeScriptCodeMirror code={ctx.value.body ?? ""} onChange={handleCodeChange} />
                </div>
            </div>
        </div>
    );
}
