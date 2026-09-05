import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { EvalLine } from "@altea/altea-eval/client/EvalLine";
import type { DynamicApiEntity } from "../../data/DynamicApi";

// Port of Signum.Dynamic's Api/DynamicApi.tsx.
//
// The signature is where this differs most from Signum, and deliberately: its script is the BODY OF A
// CONTROLLER CLASS (it declares `[HttpGet]` methods), while altea has no controllers — a route is
// registered by calling `ws.get(path, meta, handler)`. So the script here is handed the route builder, and
// the editor says so.
export default function DynamicApiComponent(p: { ctx: TypeContext<DynamicApiEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(a => a.name)} />
            <CheckboxLine ctx={ctx.subCtx(a => a.isDisabled)} onChange={forceUpdate} />

            <EvalLine ctx={ctx.subCtx(a => a.eval)} signature="(ws: WebBuilder) => void" height={400} />
        </div>
    );
}
