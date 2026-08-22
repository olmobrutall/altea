import "@altea/altea/data/globals/arrayExtensions";
import type NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { Color, Gradient } from "@altea/altea/client/Basics/Color";
import type { WorkflowModel } from "../../data/Workflow";
import { WorkflowActivityModel } from "../../data/WorkflowNodes";
import type { WorkflowActivityMonitor, WorkflowActivityStats } from "../../data/WorkflowDtos";
import { CustomRenderer } from "./CustomRenderer";
import * as BpmnUtils from "./BpmnUtils";
import type { WorkflowActivityMonitorConfig } from "../ActivityMonitor/WorkflowActivityMonitorConfig";

// Port of Signum.Workflow's Bpmn/WorkflowActivityMonitorRenderer.ts — the ACTIVITY MONITOR's coloring: each
// activity shaded by how many cases sit on it (or by the first aggregate column, when the user asked for one),
// against the busiest node.
//
// altea divergences: the `Color` / `Gradient` import is core's, the model's entities are a plain array, and the
// tooltip's per-column value is shown as a plain number (luxon's Duration formatting is dropped, as elsewhere).

export class WorkflowActivityMonitorRenderer extends CustomRenderer {
    workflowActivityMonitor!: WorkflowActivityMonitor;
    workflowConfig!: WorkflowActivityMonitorConfig;
    workflowModel!: WorkflowModel;

    viewer!: NavigatedViewer;

    gradient: Gradient = new Gradient([
        { value: 0, color: Color.parse("rgb(117, 202, 112)") },
        { value: 0.5, color: Color.parse("rgb(251, 214, 95)") },
        { value: 1, color: Color.parse("rgb(251, 114, 95)") },
    ]);

    override drawShape(visuals: any, element: BPMN.DiElement): SVGElement {
        const result = super.drawShape(visuals, element);

        if (BpmnUtils.isTaskAnyKind(element.type)) {
            const pair = this.workflowModel.entities.singleOrNull(a => a.bpmnElementId === element.id);
            const actMod = pair?.model instanceof WorkflowActivityModel ? pair.model : undefined;

            const stats = actMod == null ? null : this.workflowActivityMonitor.activities
                .singleOrNull(ac => ac.workflowActivity.is(actMod.workflowActivity!));

            if (!stats) {
                result.style.setProperty("stroke", "lightgray");
                result.style.setProperty("fill", "#eee");
            }
            else if (this.workflowConfig.columns.length === 0) {
                const max = Math.max(1, this.workflowActivityMonitor.activities.max(a => a.caseActivityCount) || 0);
                const color = this.gradient.getColor(stats.caseActivityCount / max);
                result.style.setProperty("stroke", color.lerp(0.5, Color.Black).toString());
                result.style.setProperty("fill", color.toString());
            }
            else {
                const max = Math.max(0.01, this.workflowActivityMonitor.activities
                    .max(a => a.customValues[0] as number) || 0);
                const color = this.gradient.getColor(((stats.customValues[0] as number) || 0) / max);
                result.style.setProperty("stroke", color.lerp(0.5, Color.Black).toString());
                result.style.setProperty("fill", color.toString());
            }

            const gParent = (result.parentNode as SVGGElement).parentNode as SVGGElement;
            const title = (Array.from(gParent.childNodes) as SVGElement[])
                .filter(a => a.nodeName === "title").firstOrNull()
                ?? gParent.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title"));

            title.textContent = stats == null ? "" : getTitle(stats, this.workflowConfig);
        }

        return result;
    }
}

function getTitle(stats: WorkflowActivityStats, config: WorkflowActivityMonitorConfig): string {
    let result = `${stats.workflowActivity.toString()} (${stats.caseActivityCount})`;

    if (config.columns.length) {
        result += "\n" + config.columns
            .map((col, i) => `${col.displayName ?? col.token?.niceName() ?? ""}: ${stats.customValues[i] ?? ""}`)
            .join("\n");
    }

    return result;
}

export const __init__: string[] = ["workflowActivityMonitorRenderer"];
export const workflowActivityMonitorRenderer: (string | typeof WorkflowActivityMonitorRenderer)[] =
    ["type", WorkflowActivityMonitorRenderer];
