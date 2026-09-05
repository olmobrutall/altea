import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { EvalLine } from "@altea/altea-eval/client/EvalLine";
import PropertyRouteCombo from "@altea/altea/client/Components/PropertyRouteCombo";
import { PropertyRoute, PropertyRouteType } from "@altea/altea/data/propertyRoute";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import type { DynamicValidationEntity } from "../../data/DynamicValidation";

// Port of Signum.Dynamic's Validation/DynamicValidation.tsx.
//
// altea divergences:
//  - `SubEntity` binds a `PropertyRouteEntity` through the framework's `PropertyRouteCombo`, as in Signum,
//    and with Signum's same `routes` restriction to mixins and non-collection embeddeds.
//  - `isDisabled` comes from Signum's DisabledMixin, which altea does not have; the flag is a plain field
//    and is edited here, the same call client/CSS/DynamicCSSOverride makes.
//  - the eval is rendered by @altea/altea-eval's shared `EvalLine`, where Signum spells the
//    signature / editor / closing-brace sandwich out inline.
export default function DynamicValidationComponent(p: { ctx: TypeContext<DynamicValidationEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    const entityTypeName = ctx.value.entityType?.className ?? "…";

    const subEntityRoutes = React.useMemo(() => {
        const ti = ctx.value.entityType == null ? undefined : tryGetTypeInfo(ctx.value.entityType.cleanName);
        if (ti?.ctor == null)
            return [];
        return PropertyRoute.generateRoutes(ti.ctor)
            .filter(pr => pr.propertyRouteType === PropertyRouteType.Mixin
                || (pr.type.is(EmbeddedEntity) && !pr.type.array));
    }, [ctx.value.entityType]);

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(a => a.name)} />
            <EntityLine ctx={ctx.subCtx(a => a.entityType)} onChange={forceUpdate} />
            {/*
              * Signum's same combo and the same `routes` restriction: only a MIXIN or a non-collection
              * EMBEDDED is a sub-entity a validation can be attached to — a value route is a field, which
              * is what the eval's `fi` argument already names.
              */}
            <PropertyRouteCombo ctx={ctx.subCtx(a => a.subEntity)} type={ctx.value.entityType}
                routes={subEntityRoutes} onChange={forceUpdate} />
            <CheckboxLine ctx={ctx.subCtx(a => a.isDisabled)} onChange={forceUpdate} />

            <EvalLine ctx={ctx.subCtx(a => a.eval)}
                signature={"(e: " + entityTypeName + ", fi: FieldInfo) => string | null"} />
        </div>
    );
}
