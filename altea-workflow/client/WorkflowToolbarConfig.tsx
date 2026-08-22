import type { Location } from "react-router";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { ToolbarConfig } from "@altea/altea-toolbar/client/ToolbarConfig";
import type { ToolbarResponse } from "@altea/altea-toolbar/data/ToolbarResponse";
import { WorkflowEntity, WorkflowMainEntityStrategy } from "../data/Workflow";
import { WorkflowClient } from "./WorkflowClient";

// Port of Signum.Workflow's WorkflowToolbarConfig.tsx — a toolbar element pointing at a WORKFLOW starts a new
// case of it, asking which main-entity strategy to use when the workflow declares more than one.
//
// altea divergences: `mainEntityStrategies` is a plain array of @part rows (no MList wrapper), and the stored
// strategy is an ORDINAL, so `chooseEnum` — which takes member NAMES — needs `Enum.toName`.

export default class WorkflowToolbarConfig extends ToolbarConfig<WorkflowEntity> {

    constructor() {
        super(WorkflowEntity);
    }

    override getDefaultIcon(): IconProp {
        return "shuffle";
    }

    override async navigateTo(element: ToolbarResponse<WorkflowEntity>): Promise<string | null> {
        const starts = await WorkflowClient.API.starts();

        const strategies = starts.single(s => s.toLite().is(element.content!))
            .mainEntityStrategies.map(a => Enum.toName(WorkflowMainEntityStrategy, a.strategy));

        const strategy = await SelectorModal.chooseEnum(WorkflowMainEntityStrategy, strategies);

        if (strategy == null)
            return null;

        return WorkflowClient.workflowStartUrl(element.content!, Enum.toValue(WorkflowMainEntityStrategy, strategy));
    }

    override isCompatibleWithUrlPrio(res: ToolbarResponse<WorkflowEntity>, location: Location, query: any):
        { prio: number, inferredEntity?: Lite<Entity> } | null {
        return location.pathname.startsWith(WorkflowClient.workflowStartUrl(res.content!)) ? ({ prio: 2 }) : null;
    }
}
