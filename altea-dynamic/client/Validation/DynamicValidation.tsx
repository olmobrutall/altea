import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { EvalLine } from "@altea/altea-eval/client/EvalLine";
import type { DynamicValidationEntity } from "../../data/DynamicValidation";

// Port of Signum.Dynamic's Validation/DynamicValidation.tsx.
//
// altea divergences:
//  - `SubEntity` is a route STRING rather than a `PropertyRouteEntity` lite (altea has no such table), so
//    it is a text line. It is matched as a PREFIX (see DynamicValidationLogic), which is what makes
//    "validate this embedded's whole sub-tree" expressible — hence the hint.
//  - `isDisabled` comes from Signum's DisabledMixin, which altea does not have; the flag is a plain field
//    and is edited here, the same call client/CSS/DynamicCSSOverride makes.
//  - the eval is rendered by @altea/altea-eval's shared `EvalLine`, where Signum spells the
//    signature / editor / closing-brace sandwich out inline.
export default function DynamicValidationComponent(p: { ctx: TypeContext<DynamicValidationEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    const entityTypeName = ctx.value.entityType?.className ?? "…";

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(a => a.name)} />
            <EntityLine ctx={ctx.subCtx(a => a.entityType)} onChange={forceUpdate} />
            <AutoLine ctx={ctx.subCtx(a => a.subEntity)}
                helpText="A property route, e.g. shipAddress.city. Empty means the whole entity; a route also covers everything below it." />
            <CheckboxLine ctx={ctx.subCtx(a => a.disabled)} onChange={forceUpdate} />

            <EvalLine ctx={ctx.subCtx(a => a.eval)}
                signature={"(e: " + entityTypeName + ", fi: FieldInfo) => string | null"} />
        </div>
    );
}
