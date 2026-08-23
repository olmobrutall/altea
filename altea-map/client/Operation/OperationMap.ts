import * as d3 from "d3";
import { Finder } from "@altea/altea/client/Finder";
import * as AppContext from "@altea/altea/client/AppContext";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { calculatePoint, wrap, colorScale, forceBoundingBox } from "../Utils";
import type { Point, Rectangle } from "../Schema/ClientColorProvider";
import type { MapOperation, MapState, OperationMapInfo } from "../../data/Map";

// Port of Signum.Map's Operation/OperationMap.ts — the d3 force layout of one type's state machine. A
// state and an operation are both NODES; the drawn edges are the TRANSITIONS (fromState → operation →
// toState), each a quadratic curve bent through the operation's node.
//
// altea divergences:
//  - **The wire shapes come from the DATA layer**; only the layout supertypes live here (Signum
//    re-declared `MapState` / `MapOperation` by hand in this file).
//  - **No `fromToStates`.** Signum lets an operation carry an explicit from→to pair list; altea's
//    Graph.* classes have no such option, so the transitions are always the cartesian product — the
//    branch Signum's own code falls back to when `fromToStates` is null (see data/Map.ts).
//  - `Ctrl+Click` on an operation filters the operation log by `operation.key`, altea's ROOTLESS
//    camelCase token, where Signum sends `"Operation.Key"`.
//  - Signum reads a stale global `(<any>event).ctrlKey` in the state click handler (the operations
//    handler next to it correctly reads `e.ctrlKey`) — that is a bug, not a behaviour, so this reads `e`
//    in both.

export interface ForceNode extends d3.SimulationNodeDatum, Rectangle {
    key: string;
}

export interface ForceLink extends d3.SimulationLinkDatum<ForceNode> {
    isFrom: boolean;
}

/** A state node: the server's MapState plus the layout fields and the fan-in/out balance. */
export interface IMapState extends MapState, ForceNode {
    fanOut: number;
    fanIn: number;
    /** -1 (pure source) … +1 (pure sink) — nudges the node rightwards, so the machine reads left to right. */
    fanInOutFactor: number;
}

/** An operation node. */
export interface IMapOperation extends MapOperation, ForceNode { }

export interface Transition {
    sourcePoint: Point;
    fromState: IMapState;
    operation: IMapOperation;
    toState: IMapState;
    targetPoint: Point;
}

/** The map as the page holds it: the server payload plus the resolved node / link / transition arrays. */
export interface OperationMapD3Info extends OperationMapInfo {
    states: IMapState[];
    operations: IMapOperation[];
    allNodes: ForceNode[];
    allLinks: ForceLink[];
    allTransition: Transition[];
}

export class OperationMapD3 {

    simulation: d3.Simulation<ForceNode, ForceLink>;
    selectedNode: ForceNode | undefined;
    link: d3.Selection<SVGPathElement, Transition, any, any>;

    statesGroup!: d3.Selection<SVGGElement, IMapState, any, any>;
    nodeStates!: d3.Selection<SVGRectElement, IMapState, any, any>;
    labelStates!: d3.Selection<SVGTextElement, IMapState, any, any>;

    operationsGroup!: d3.Selection<SVGGElement, IMapOperation, any, any>;
    nodeOperations!: d3.Selection<SVGRectElement, IMapOperation, any, any>;
    labelOperations!: d3.Selection<SVGTextElement, IMapOperation, any, any>;

    constructor(
        public svgElement: SVGElement,
        public queryName: string,
        public map: OperationMapD3Info,
        public color: string,
        public width: number,
        public height: number) {

        this.simulation = d3.forceSimulation<ForceNode, ForceLink>()
            .nodes(map.allNodes)
            .force("bounding", forceBoundingBox(width, height))
            .force("fx", d3.forceX(width / 2))
            .force("fy", d3.forceY(height / 2))
            .force("repulsion", d3.forceManyBody().strength(-200))
            .force("collide", d3.forceCollide(30))
            .force("links", d3.forceLink(map.allLinks))
            .force("fainInOut", forceFanInOut());

        const svg = d3.select(svgElement)
            .attr("width", width)
            .attr("height", height);

        this.link = svg.append<SVGGElement>("svg:g").attr("class", "links").selectAll(".link")
            .data(map.allTransition)
            .enter().append<SVGPathElement>("path")
            .attr("class", "link")
            .style("stroke", "var(--bs-body-color)")
            .attr("marker-end", "url(#normal_arrow)");

        this.selectLinks();

        this.initStates(svg);
        this.initOperations(svg);

        this.simulation.on("tick", () => this.onTick());
    }

    initStates(svg: d3.Selection<SVGElement, any, any, any>): void {

        const drag = d3.drag<SVGGElement, IMapState>()
            .on("start", (e, d) => {
                if (!e.active)
                    this.simulation.alphaTarget(0.3).restart();

                d.fx = d.x;
                d.fy = d.y;
            })
            .on("drag", (e, d) => {
                d.fx = e.x;
                d.fy = e.y;
            })
            .on("end", () => {
                this.simulation.alphaTarget(0);
            });

        this.statesGroup = svg.append<SVGGElement>("svg:g").attr("class", "states")
            .selectAll(".stateGroup")
            .data(this.map.states)
            .enter()
            .append<SVGGElement>("svg:g").attr("class", "stateGroup")
            .style("cursor", d => d.token ? "pointer" : null)
            .on("click", (e, d) => {

                this.selectedNode = this.selectedNode == d ? undefined : d;

                this.selectLinks();
                this.selectNodes();

                if (e.defaultPrevented)
                    return;

                if (e.ctrlKey && d.token) {
                    window.open(AppContext.toAbsoluteUrl(Finder.findOptionsPath({
                        queryName: this.queryName,
                        filterOptions: [{ token: d.token, value: d.key }],
                    })));
                    e.preventDefault();
                }
            }).on("dblclick", (e, d) => {
                d.fx = null;
                d.fy = null;
                this.simulation.alpha(0.3).restart();
            }).call(drag);

        this.nodeStates = this.statesGroup.append<SVGRectElement>("rect")
            .attr("class", d => "state " + (
                d.isSpecial ? "special" :
                    d.ignored ? "ignore" : ""))
            .attr("rx", 5)
            .attr("fill-opacity", 0.1);

        this.onStateColorChange();

        const margin = 3;

        this.labelStates = this.statesGroup.append<SVGTextElement>("text")
            .attr("class", "state")
            .style("cursor", d => d.token ? "pointer" : null)
            .text(d => d.niceName)
            .each(function (d) {
                const text = this as SVGTextElement;
                wrap(text, 60);
                const b = text.getBBox();
                d.width = b.width + margin * 2;
                d.height = b.height + margin * 2;
            });

        this.nodeStates.attr("width", d => d.width)
            .attr("height", d => d.height);

        this.labelStates.attr("transform", d => "translate(" + d.width / 2 + ", 0)");

        this.labelStates.append("svg:title")
            .text(t => t.niceName + " (" + t.count + ")");
    }

    initOperations(svg: d3.Selection<SVGElement, any, any, any>): void {

        const drag = d3.drag<SVGGElement, IMapOperation>()
            .on("start", (e, d) => {
                if (!e.active)
                    this.simulation.alphaTarget(0.3).restart();

                d.fx = d.x;
                d.fy = d.y;
            })
            .on("drag", (e, d) => {
                d.fx = e.x;
                d.fy = e.y;
            })
            .on("end", () => {
                this.simulation.alphaTarget(0);
            });

        this.operationsGroup = svg.append<SVGGElement>("svg:g").attr("class", "operations")
            .selectAll(".operation")
            .data(this.map.operations)
            .enter()
            .append<SVGGElement>("svg:g").attr("class", "operation")
            .style("cursor", "pointer")
            .on("click", (e, d) => {

                this.selectedNode = this.selectedNode == d ? undefined : d;

                this.selectLinks();
                this.selectNodes();

                if (e.defaultPrevented)
                    return;

                if (e.ctrlKey) {
                    window.open(AppContext.toAbsoluteUrl(Finder.findOptionsPath({
                        queryName: OperationLogEntity,
                        filterOptions: [{ token: "operation.key", value: d.key }],
                    })));
                    e.preventDefault();
                }
            }).on("dblclick", (e, d) => {
                d.fx = null;
                d.fy = null;
                this.simulation.alpha(0.3).restart();
            }).call(drag);

        this.nodeOperations = this.operationsGroup.append<SVGRectElement>("rect")
            .attr("class", "operation");

        const margin = 1;

        this.labelOperations = this.operationsGroup.append<SVGTextElement>("text")
            .attr("class", "operation")
            .style("cursor", "pointer")
            .text(d => d.niceName)
            .each(function (d) {
                const text = this as SVGTextElement;
                wrap(text, 60);
                const b = text.getBBox();
                d.width = b.width + margin * 2;
                d.height = b.height + margin * 2;
            });

        this.onOperationColorChange();

        this.nodeOperations.attr("width", d => d.width + 2)
            .attr("height", d => d.height + 2);

        this.labelOperations.attr("transform", d => "translate(" + ((d.width / 2) + 1) + ", -1)");

        this.labelOperations.append("svg:title")
            .text(t => t.niceName + " (" + t.count + ")");
    }

    selectLinks(): void {
        const isSel = (d: Transition): boolean =>
            d.fromState == this.selectedNode || d.toState == this.selectedNode || d.operation == this.selectedNode;

        this.link.style("stroke-width", d => isSel(d) ? 1.5 : 1)
            .style("opacity", d => isSel(d) ? 1 : 0.5);
    }

    selectNodes(): void {
        this.labelStates.style("font-weight", d => d == this.selectedNode ? "bold" : null);
        this.labelOperations.style("font-weight", d => d == this.selectedNode ? "bold" : null);
    }

    setColor(newColor: string): void {
        this.color = newColor;
        this.onStateColorChange();
        this.onOperationColorChange();
    }

    onStateColorChange(): void {

        let c: (d: IMapState) => string;

        if (this.color == "rows") {
            const colorStates = colorScale(Math.max(1, ...this.map.states.map(a => a.count)));
            c = d => colorStates(d.count);
        } else {
            const scale = d3.scaleOrdinal(d3.schemeCategory10);
            c = d => d.color ?? (d.isSpecial ? "lightgray" : scale(d.key));
        }

        this.nodeStates
            .attr("stroke", c)
            .attr("fill", c);
    }

    onOperationColorChange(): void {
        let c: (d: IMapOperation) => string;

        if (this.color == "rows") {
            const colorOperations = colorScale(Math.max(1, ...this.map.operations.map(a => a.count)));
            c = d => colorOperations(d.count);
        } else {
            c = () => "transparent";
        }

        this.nodeOperations
            .attr("stroke", c)
            .attr("fill", c);
    }

    onTick(): void {

        this.link.each(rel => {
            rel.sourcePoint = calculatePoint(rel.fromState, rel.operation);
            rel.targetPoint = calculatePoint(rel.toState, rel.operation);
        });

        this.link.attr("d", l => this.getPathExpression(l));

        this.statesGroup.attr("transform", d => "translate(" + (d.x! - d.width / 2) + ", " + (d.y! - d.height / 2) + ")");
        this.operationsGroup.attr("transform", d => "translate(" + (d.x! - d.width / 2) + ", " + (d.y! - d.height / 2) + ")");
    }

    getPathExpression(t: Transition): string {
        if (t.fromState == t.toState) {

            const dx = t.sourcePoint.x! - t.operation.x!;
            const dy = t.sourcePoint.y! - t.operation.y!;

            return `M${t.sourcePoint.x} ${t.sourcePoint.y} C ${t.operation.x! - dy} ${t.operation.y! + dx} ${t.operation.x! + dy} ${t.operation.y! - dx} ${t.targetPoint.x} ${t.targetPoint.y}`;
        }

        return `M${t.sourcePoint.x} ${t.sourcePoint.y} Q ${t.operation.x} ${t.operation.y} ${t.targetPoint.x} ${t.targetPoint.y}`;
    }

    stop(): void {
        this.simulation.stop();
    }
}

/** A custom force pushing sinks right and sources left, so the machine reads in the direction it runs. */
export function forceFanInOut(): (alpha: number) => void {
    let nodes: IMapState[];
    const fanInConstant = 30;

    function force(alpha: number): void {
        nodes.forEach(d => {
            if (d.fanInOutFactor != null) {
                d.vx = d.vx! + d.fanInOutFactor * fanInConstant * alpha;
            }
        });
    }

    (force as unknown as { initialize: (n: IMapState[]) => void }).initialize = function (n: IMapState[]) {
        nodes = n;
    };

    return force;
}
