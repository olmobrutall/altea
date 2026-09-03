import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { EvalLine } from "@altea/altea-eval/client/EvalLine";
import type {
    DynamicTypeConditionEntity, DynamicTypeConditionSymbolEntity,
} from "../../data/DynamicTypeCondition";

// Port of Signum.Dynamic's TypeCondition/DynamicTypeCondition.tsx (both views live in one file there too).
//
// The hint on the script is altea's and it matters: a dynamic condition is GENERATED, so it becomes a real
// query filter and narrows a search — which means the body must be an expression the LINQ provider can
// lower, not arbitrary code.
export default function DynamicTypeConditionComponent(p: { ctx: TypeContext<DynamicTypeConditionEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    const entityTypeName = ctx.value.entityType?.className ?? "…";

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(a => a.symbolName)} />
            <EntityLine ctx={ctx.subCtx(a => a.entityType)} onChange={forceUpdate} />

            <EvalLine ctx={ctx.subCtx(a => a.eval)}
                signature={"(e: " + entityTypeName + ") => boolean"} />
        </div>
    );
}

/** Signum's DynamicTypeConditionSymbol view — just the name (it is a symbol a USER invented). */
export function DynamicTypeConditionSymbolComponent(
    p: { ctx: TypeContext<DynamicTypeConditionSymbolEntity> },
): React.JSX.Element {
    return <AutoLine ctx={p.ctx.subCtx(a => a.name)} />;
}
