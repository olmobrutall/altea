import { Lite } from "@altea/altea/data/lite";
import type { WorkflowConditionEntity } from "../../data/WorkflowCondition";
import type { WorkflowActionEntity } from "../../data/WorkflowAction";

// Port of Signum.Workflow's Bpmn/ConnectionIcons.ts — the little colored tabs on a shape's border that say
// "this connection carries a CONDITION (blue, on the way out) / an ACTION (amber, on the way in)", each a
// clickable overlay that opens the referenced entity.
//
// Verbatim apart from the imports and `liteKey(lite)` → `lite.key()`.

export function getOrientation(rect: BPMN.DiElement, reference: BPMN.DiElement, padding: number): string {
    padding = padding || 0;

    const sPadding = { x: padding, y: padding };

    function asTRBL(bounds: { x: number; y: number; width: number; height: number }): { top: number; right: number; bottom: number; left: number } {
        return {
            top: bounds.y,
            right: bounds.x + (bounds.width || 0),
            bottom: bounds.y + (bounds.height || 0),
            left: bounds.x,
        };
    }

    const rectOrientation = asTRBL(rect);
    const referenceOrientation = asTRBL(reference);

    const top = rectOrientation.bottom + sPadding.y <= referenceOrientation.top;
    const right = rectOrientation.left - sPadding.x >= referenceOrientation.right;
    const bottom = rectOrientation.top - sPadding.y >= referenceOrientation.bottom;
    const left = rectOrientation.right + sPadding.x <= referenceOrientation.left;

    const vertical = top ? "top" : (bottom ? "bottom" : null);
    const horizontal = left ? "left" : (right ? "right" : null);

    if (horizontal && vertical)
        return vertical + "-" + horizontal;

    return horizontal || vertical || "intersect";
}

export class ConnectionIcons {
    static $inject: string[] = ["elementRegistry", "overlays", "eventBus"];

    _overlays: BPMN.Overlays;
    _elementRegistry: BPMN.ElementRegistry;
    active: boolean;

    constructor(elementRegistry: BPMN.ElementRegistry, overlays: BPMN.Overlays, eventBus: BPMN.EventBus) {
        this._overlays = overlays;
        this._elementRegistry = elementRegistry;
        this.active = false;

        eventBus.on("elements.changed", () => {
            if (this.active) {
                this.hide();
                this.show();
            }
        });
    }

    _addOverlay(shape: BPMN.DiElement, waypoint: BPMN.DiElement,
        lite: Lite<WorkflowConditionEntity | WorkflowActionEntity>, color: string): void {

        let orientation = getOrientation(waypoint, shape, -7);

        if (orientation === "intersect") {
            // Try again with a bigger padding to get an orientation that is not 'intersect'. Otherwise the
            // boundary would not be visible when the connection attaches on the diagonal edge of a gateway.
            orientation = getOrientation(waypoint, shape, -20);
        }

        const strokeWidth = 5;
        const defaultLength = 20;
        const margin = 0;

        const position: BPMN.RelativePosition = {};
        let height: number;
        let width: number;

        if (/left/.test(orientation)) {
            width = strokeWidth;
            height = defaultLength;
            position.left = -width - margin;
            position.top = waypoint.y - shape.y - defaultLength / 2;
        }
        else if (/right/.test(orientation)) {
            width = strokeWidth;
            height = defaultLength;
            position.right = shape.x + shape.width - waypoint.x - margin;
            position.top = waypoint.y - shape.y - defaultLength / 2;
        }
        else if (orientation === "top") {
            width = defaultLength;
            height = strokeWidth;
            position.left = waypoint.x - shape.x - defaultLength / 2;
            position.top = -height - margin;
        }
        else {
            width = defaultLength;
            height = strokeWidth;
            position.bottom = -margin;
            position.left = waypoint.x - shape.x - defaultLength / 2;
        }

        const title = htmlEscape(`${lite.entityType.name}: ${lite.toString() ?? ""}`);

        this._overlays.add(shape, "transaction-boundaries", {
            position,
            html: `<div class="connection-icon" data-key="${lite.key()}" title="${title}" `
                + `style="width: ${width}px; height: ${height}px; background: ${color}; cursor:pointer;"> </div>`,
        });
    }

    hasAction!: (con: BPMN.Connection) => Lite<WorkflowActionEntity> | undefined;
    hasCondition!: (con: BPMN.Connection) => Lite<WorkflowConditionEntity> | undefined;

    show(): void {
        this._elementRegistry.forEach(element => {
            if (element.type === "label")
                return;

            element.incoming.forEach(con => {
                const action = this.hasAction(con);
                if (action) {
                    const waypoint = con.waypoints.last();
                    this._addOverlay(element, waypoint, action, "#ffc800");
                }
            });

            element.outgoing.forEach(con => {
                const condition = this.hasCondition(con);
                if (condition) {
                    const waypoint = con.waypoints.first();
                    this._addOverlay(element, waypoint, condition, "#0000ff");
                }
            });
        });

        this.active = true;
    }

    hide(): void {
        this._overlays.remove({ type: "transaction-boundaries" });
        this.active = false;
    }

    toggle(): void {
        if (this.active)
            this.hide();
        else
            this.show();
    }
}

function htmlEscape(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export const __init__: string[] = ["connectionIcons"];
export const connectionIcons: (string | typeof ConnectionIcons)[] = ["type", ConnectionIcons];
