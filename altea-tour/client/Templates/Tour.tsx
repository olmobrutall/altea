import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityTabRepeater } from "@altea/altea/client/Lines/EntityTabRepeater";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { TourTriggerSymbol } from "@altea/altea/data/tourTrigger";
import { toInt } from "@altea/altea/data/basics";
import { DashboardEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { TourEntity, TourStepEntity, PopoverSide } from "../../data/Tour";
import { TourClient } from "../TourClient";
import TourStep from "./TourStep";

// Port of Signum.Tour's Templates/Tour.tsx — the tour editor: pick the trigger, then author the steps.
//
// The trigger decides what a step can point at, so this view resolves it once and hands the answer down:
// an entity TYPE (directly, or through a TourTriggerSymbol registered for one) offers PROPERTY steps, a
// DASHBOARD offers its parts, a USER QUERY its columns.
//
// altea divergences:
//  - `EntityAccordion` is not ported (as altea-email's EmailTemplate notes), so the steps use
//    `EntityTabRepeater` — the closest thing with a per-item title.
//  - the symbol's type comes back as a clean NAME, not a `Lite<TypeEntity>` (see TourClient.API).
export default function Tour(p: { ctx: TypeContext<TourEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx.subCtx({ labelColumns: { sm: 2 } });
    const trigger = p.ctx.value.trigger;

    // A TourTriggerSymbol trigger may be REGISTERED for an entity type (TourTriggerLogic.registerTriggerType),
    // in which case its properties are offered exactly as a Lite<TypeEntity> trigger's would be.
    const symbolTypeName = useAPI(() =>
        trigger != null && trigger.entityType === TourTriggerSymbol
            ? TourClient.API.getTriggerType(trigger)
            : Promise.resolve(null),
        [trigger]);

    const typeEntity = Navigator.useFetchInState(
        trigger != null && trigger.entityType === TypeEntity ? trigger as never : null) as TypeEntity | null | undefined;

    const dashboard = Navigator.useFetchInState(
        trigger != null && trigger.entityType === DashboardEntity ? trigger as never : null) as DashboardEntity | null | undefined;

    const userQuery = Navigator.useFetchInState(
        trigger != null && trigger.entityType === UserQueryEntity ? trigger as never : null) as UserQueryEntity | null | undefined;

    const rootTypeName = typeEntity?.cleanName ?? symbolTypeName ?? null;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(a => a.trigger)} onChange={forceUpdate} />

            <EntityTabRepeater ctx={ctx.subCtx(a => a.steps)} avoidFieldSet="h4"
                onCreate={() => Promise.resolve(TourStepEntity.create({ side: PopoverSide.Bottom, order: toInt(0) }))}
                getComponent={sctx => <TourStep ctx={sctx} invalidate={forceUpdate}
                    rootTypeName={rootTypeName} dashboard={dashboard ?? null} userQuery={userQuery ?? null} />}
                getTitle={sctx => sctx.value.title || ""} />

            <div className="row mt-4">
                <div className="col-sm-4">
                    <CheckboxLine ctx={ctx.subCtx(a => a.showProgress)} inlineCheckbox={true} />
                </div>
                <div className="col-sm-4">
                    <CheckboxLine ctx={ctx.subCtx(a => a.animate)} inlineCheckbox={true} />
                </div>
                <div className="col-sm-4">
                    <CheckboxLine ctx={ctx.subCtx(a => a.showCloseButton)} inlineCheckbox={true} />
                </div>
            </div>
        </div>
    );
}
