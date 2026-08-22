import BpmnRenderer from "bpmn-js/lib/draw/BpmnRenderer";
import { BootstrapStyle, ConnectionType } from "../../data/WorkflowNodes";
import * as BpmnUtils from "./BpmnUtils";

// Port of Signum.Workflow's Bpmn/CustomRenderer.ts — the diagram's colors: a per-element-kind palette, and a
// per-connection-TYPE stroke so a jump / decision / script-exception route is visible at a glance.
//
// altea divergence: the connection type and the decision style are ENUM ORDINALS now (altea's enum
// convention), so the switches compare with `ConnectionType.Jump` rather than the string "Jump".

const bootstrapStyleToColor: Record<number, string> = {
    [BootstrapStyle.Light]: "#f8f9fa",
    [BootstrapStyle.Dark]: "#343a40",
    [BootstrapStyle.Primary]: "#007bff",
    [BootstrapStyle.Secondary]: "#6c757d",
    [BootstrapStyle.Success]: "#28a745",
    [BootstrapStyle.Info]: "#17a2b8",
    [BootstrapStyle.Warning]: "#ffc107",
    [BootstrapStyle.Danger]: "#dc3545",
};

export class CustomRenderer extends BpmnRenderer {
    static $inject: string[] = ["config.bpmnRenderer", "eventBus", "styles", "pathMap", "canvas", "textRenderer"];

    constructor(config: any, eventBus: BPMN.EventBus, styles: any, pathMap: any, canvas: any, textRenderer: any) {
        super(config, eventBus, styles, pathMap, canvas, textRenderer, 1200);
    }

    getConnectionType!: (element: BPMN.Connection) => ConnectionType | undefined;
    getDecisionStyle!: (element: BPMN.Connection) => BootstrapStyle | undefined;

    override drawConnection(visuals: any, element: BPMN.Connection): SVGElement {
        const result = super.drawConnection(visuals, element);
        const ct = this.getConnectionType(element);
        const ds = this.getDecisionStyle(element);

        if (ct != null && ct !== ConnectionType.Normal)
            result.style.setProperty("stroke",
                ct === ConnectionType.Jump ? "blue" :
                    ct === ConnectionType.ScriptException ? "var(--bs-magenta)" :
                        ct === ConnectionType.Decision && ds != null
                            ? (bootstrapStyleToColor[ds] ?? "var(--bs-body-color)")
                            : "gray");

        return result;
    }

    override drawShape(visuals: any, element: BPMN.DiElement): SVGElement {

        const result = super.drawShape(visuals, element);

        let strokeColor = "";
        let fillColor = "";

        if (element.type === "bpmn:StartEvent") {
            strokeColor = "#62A716";
            fillColor = "#E6FF97";
        }
        else if (element.type === "bpmn:EndEvent") {
            strokeColor = "#990000";
            fillColor = "#EEAAAA";
        }
        else if (element.type === "bpmn:IntermediateThrowEvent" || element.type === "bpmn:IntermediateCatchEvent") {
            strokeColor = "#A09B58";
            fillColor = "#FEFAEF";
        }
        else if (BpmnUtils.isTaskAnyKind(element.type)) {
            strokeColor = "#03689A";
            fillColor = "#ECEFFF";
        }
        else if (BpmnUtils.isGatewayAnyKind(element.type)) {
            strokeColor = "#ACAC28";
            fillColor = "#FFFFCC";
        }
        else if (element.type === "bpmn:TextAnnotation" || element.type === "bpmn:DataObjectReference"
            || element.type === "bpmn:DataStoreReference") {
            strokeColor = "#666666";
            fillColor = "#F0F0F0";
        }
        else if (element.type === "bpmn:Lane" || element.type === "bpmn:Participant") {
            strokeColor = "#CCCCCC";
            fillColor = "#FFFFFF";
        }

        if (strokeColor.length > 0)
            result.style.setProperty("stroke", strokeColor);

        if (fillColor.length > 0)
            result.style.setProperty("fill", fillColor);

        return result;
    }
}

export const __init__: string[] = ["customRenderer"];
export const customRenderer: (string | typeof CustomRenderer)[] = ["type", CustomRenderer];
