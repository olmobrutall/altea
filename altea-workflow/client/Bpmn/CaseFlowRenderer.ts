import "@altea/altea/data/globals/arrayExtensions";
import type NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { Color, Gradient } from "@altea/altea/client/Basics/Color";
import { Enum } from "@altea/altea/data/enum";
import { CaseActivityEntity, DoneType } from "../../data/CaseActivity";
import { CaseFlowColor } from "../../data/Case";
import { CaseNotificationEntity } from "../../data/CaseNotification";
import type { CaseActivityStats, CaseFlow } from "../../data/WorkflowDtos";
import { CustomRenderer } from "./CustomRenderer";
import * as BpmnUtils from "./BpmnUtils";

// Port of Signum.Workflow's Bpmn/CaseFlowRenderer.ts — the CASE FLOW colors: a node the case never reached is
// greyed out, one it did is shaded by how long it took (against the case's own maximum, the activity's average
// or its estimate), and a JUMP — which has no stored connection to draw — is drawn here as a dashed curve.
//
// altea divergences:
//  - `calculatePoint` and the `Rectangle` shape came from Signum.Map (not ported), so they are inlined at the
//    bottom of this file — ~30 lines of geometry with no other consumer.
//  - `Color` / `Gradient` are altea core's (promoted from @altea/altea-chart for this port).
//  - the enum members are ORDINALS, and the dates are the DTO's ISO strings shown as-is (no luxon relative
//    formatter in altea).

export class CaseFlowRenderer extends CustomRenderer {
    static override $inject: string[] = ["config.bpmnRenderer", "eventBus", "styles", "pathMap", "canvas", "textRenderer"];

    constructor(config: any, eventBus: BPMN.EventBus, styles: any, pathMap: any, canvas: any, textRenderer: any) {
        super(config, eventBus, styles, pathMap, canvas, textRenderer);
    }

    caseFlow!: CaseFlow;
    maxDuration!: number;
    viewer!: NavigatedViewer;
    caseFlowColor?: CaseFlowColor;

    gradient: Gradient = new Gradient([
        { value: 0, color: Color.parse("rgb(117, 202, 112)") },
        { value: 0.5, color: Color.parse("rgb(251, 214, 95)") },
        { value: 1, color: Color.parse("rgb(251, 114, 95)") },
    ]);

    override drawConnection(visuals: any, element: BPMN.Connection): SVGElement {

        const path = super.drawConnection(visuals, element);
        const stats = this.caseFlow.connections[element.id];

        if (!stats)
            path.style.setProperty("stroke", "lightgray");
        else {
            const pathGroup = (path.parentNode as SVGGElement).parentNode as SVGGElement;
            const title = titleOf(pathGroup);
            title.textContent = stats.filter(con => con.doneDate != null)
                .map(con => `${Enum.niceName(DoneType, con.doneType!)} (${con.doneBy?.toString()} ${con.doneDate})`)
                .join("\n");
        }

        return path;
    }

    override drawShape(visuals: any, element: BPMN.DiElement): SVGElement {

        const result = super.drawShape(visuals, element);

        if (element.type === "label") {
            if (!this.caseFlow.allNodes.includes(element.businessObject.id)
                && !this.caseFlow.connections[element.businessObject.id])
                result.style.setProperty("fill", "gray");
        }
        else if (element.type === "bpmn:StartEvent" || element.type === "bpmn:EndEvent"
            || BpmnUtils.isGatewayAnyKind(element.type)) {

            if (!this.caseFlow.allNodes.includes(element.id)) {
                result.style.setProperty("stroke", "lightgray");
                result.style.setProperty("fill", "#eee");
            }
        }
        else if (BpmnUtils.isTaskAnyKind(element.type)) {

            const stats = this.caseFlow.activities[element.id];
            if (!stats) {
                result.style.setProperty("stroke", "lightgray");
                result.style.setProperty("fill", "#eee");
            }
            else {
                const compare =
                    this.caseFlowColor === CaseFlowColor.AverageDuration
                        ? (stats[0].averageDuration == null ? undefined : stats[0].averageDuration * 2)
                        : this.caseFlowColor === CaseFlowColor.EstimatedDuration
                            ? (stats[0].estimatedDuration == null ? undefined : stats[0].estimatedDuration * 2)
                            : this.caseFlowColor === CaseFlowColor.CaseMaxDuration ? this.maxDuration : undefined;

                const sumDuration = stats.map(a => a.duration || 0).sum();

                if (compare != null && sumDuration > 0) {
                    const color = this.gradient.getColor(sumDuration / compare);
                    result.style.setProperty("stroke", color.lerp(0.5, Color.Black).toString());
                    result.style.setProperty("fill", color.toString());
                }

                const gParent = (result.parentNode as SVGGElement).parentNode as SVGGElement;
                const title = titleOf(gParent);
                title.textContent = stats.map((a, i) => i === 0 || i === stats.length - 1 ? getTitle(a) :
                    i === 1 ? `(…${stats.length - 2} ${CaseActivityEntity.nicePluralName()})` : "")
                    .filter(a => a).join("\n\n");

                this.drawJumps(gParent, element);
            }
        }

        return result;
    }

    /** A JUMP has no stored connection, so the diagram draws it: a dashed quadratic curve between the two
     *  shapes' bounds (or a small loop when an activity jumps to itself). */
    private drawJumps(gParent: SVGGElement, element: BPMN.DiElement): void {
        const ggParent = gParent.parentNode as SVGGElement;

        const pathGroups = (Array.from(ggParent.childNodes) as SVGPathElement[])
            .filter(a => a.nodeName === "g" && (a as unknown as { className: string }).className === "jump-group");
        const jumps = this.caseFlow.jumps.filter(j => j.fromBpmnElementId === element.id);

        const toCenteredRectangle = (bounds: BPMN.BoundsElement): Rectangle => ({
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            width: bounds.width,
            height: bounds.height,
        });

        pathGroups.slice(jumps.length).forEach(path => (path.parentNode as SVGGElement).removeChild(path));

        if (jumps.length === 0)
            return;

        const moddleElements = (this.viewer as unknown as {
            _definitions: { diagrams: { plane: { planeElement: BPMN.ModdleElement[] } }[] };
        })._definitions.diagrams[0].plane.planeElement;

        const fromModdle = moddleElements.filter(a => a.id === element.id + "_di").single();
        const fromRec = toCenteredRectangle(fromModdle.bounds);

        jumps.forEach((jump, i) => {
            const pathGroup = pathGroups[i]
                ?? ggParent.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "g"));
            pathGroup.classList.add("jump-group");

            const path = (Array.from(pathGroup.childNodes).filter(a => a.nodeName === "path").singleOrNull() as SVGPathElement | null)
                ?? pathGroup.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path"));

            const toModdle = moddleElements.filter(a => a.id === jump.toBpmnElementId + "_di").single();

            if (toModdle.id !== fromModdle.id) {
                const toRec = toCenteredRectangle(toModdle.bounds);

                const fromPoint = calculatePoint(fromRec, toRec);
                const toPoint = calculatePoint(toRec, fromRec);

                const curveness = 0.2;
                const controlPoint = {
                    x: (fromPoint.x + toPoint.x) / 2 + (toPoint.y - fromPoint.y) * curveness,
                    y: (fromPoint.y + toPoint.y) / 2 - (toPoint.x - fromPoint.x) * curveness,
                };

                path.setAttribute("d",
                    `M${fromPoint.x} ${fromPoint.y} Q ${controlPoint.x} ${controlPoint.y} ${toPoint.x} ${toPoint.y}`);
            }
            else {
                const unit = 30;
                const corner = { x: fromRec.x + fromRec.width / 2, y: fromRec.y - fromRec.height / 2 };

                const fromPoint = { x: corner.x, y: corner.y + unit };
                const fromCPoint = { x: corner.x + unit * 2, y: corner.y + unit / 2 };
                const toCPoint = { x: corner.x - unit / 2, y: corner.y - unit * 2 };
                const toPoint = { x: corner.x - unit, y: corner.y };
                path.setAttribute("d", `M${fromPoint.x} ${fromPoint.y} C ${fromCPoint.x} ${fromCPoint.y} `
                    + `${toCPoint.x} ${toCPoint.y} ${toPoint.x} ${toPoint.y}`);
            }

            path.style.setProperty("fill", "transparent");
            path.style.setProperty("stroke-width", "2px");
            path.style.setProperty("stroke", getDoneColor(jump.doneType));
            path.style.setProperty("stroke-linejoin", "round");
            path.style.setProperty("stroke-dasharray", "5 5");
            path.style.setProperty("marker-end", "url(#sequenceflow-end-white-black)");

            const title = titleOf(pathGroup as unknown as SVGGElement);
            title.textContent = `${Enum.niceName(DoneType, jump.doneType!)} `
                + `(${jump.doneBy?.toString()} ${jump.doneDate})`;
        });
    }
}

/** The `<title>` child of an SVG group, created on first use (what shows the tooltip). */
function titleOf(group: SVGGElement): SVGElement {
    return (Array.from(group.childNodes) as SVGElement[]).filter(a => a.nodeName === "title").firstOrNull()
        ?? group.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title"));
}

function getDoneColor(doneType: DoneType | null): string {
    switch (doneType) {
        case DoneType.Jump: return "blue";
        case DoneType.Timeout: return "gold";
        case DoneType.ScriptSuccess: return "green";
        case DoneType.ScriptFailure: return "violet";
        case DoneType.Next: return "#ff7504";
        default: return "magenta";
    }
}

function getTitle(stats: CaseActivityStats): string {
    let result = `${stats.workflowActivity.toString()} (${CaseNotificationEntity.nicePluralName()} ${stats.notifications})
${CaseActivityEntity.nicePropertyName(a => a.startDate)}: ${stats.startDate}`;

    if (stats.doneDate != null)
        result += `
${CaseActivityEntity.nicePropertyName(a => a.doneDate)}: ${stats.doneDate}
${CaseActivityEntity.nicePropertyName(a => a.doneBy)}: ${stats.doneBy?.toString()} (${Enum.niceName(DoneType, stats.doneType!)})
${CaseActivityEntity.nicePropertyName(a => a.duration)}: ${formatMinutes(stats.duration)}`;

    result += `
${Enum.niceName(CaseFlowColor, CaseFlowColor.AverageDuration)}: ${formatMinutes(stats.averageDuration)}
${Enum.niceName(CaseFlowColor, CaseFlowColor.EstimatedDuration)}: ${formatMinutes(stats.estimatedDuration)}`;

    return result;
}

function formatMinutes(minutes: number | null): string {
    return minutes == null ? "" : minutes.toFixed(2) + " min";
}

// ---- Geometry (inlined from Signum.Map's Utils.ts + ClientColorProvider's Rectangle) --------------------

interface Point { x: number; y: number }
interface Rectangle extends Point { width: number; height: number }

/** Where the line from `rectangle`'s centre towards `point` crosses the rectangle's border. */
function calculatePoint(rectangle: Rectangle, point: Point): Point {
    const vector = { x: point.x - rectangle.x, y: point.y - rectangle.y };
    const half = { x: rectangle.width / 2, y: rectangle.height / 2 };
    const ratio = getRatio(vector, half) ?? 0;

    return { x: rectangle.x + vector.x * ratio, y: rectangle.y + vector.y * ratio };
}

function getRatio(vOut: Point, vIn: Point): number | undefined {
    const x = Math.abs(vOut.x);
    const y = Math.abs(vOut.y);

    if (x === 0 && y === 0)
        return undefined;

    if (x === 0)
        return vIn.y / y;

    if (y === 0)
        return vIn.x / x;

    return Math.min(vIn.x / x, vIn.y / y);
}

export const __init__: string[] = ["caseFlowRenderer"];
export const caseFlowRenderer: (string | typeof CaseFlowRenderer)[] = ["type", CaseFlowRenderer];
