import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";
import * as d3 from "d3";
import { Finder } from "@altea/altea/client/Finder";
import * as AppContext from "@altea/altea/client/AppContext";
import { calculatePoint, wrap, forceBoundingBox } from "../Utils";
import type {
    ClientColorProvider, IRelationInfo, ITableInfo, Point, SchemaMapD3Info,
} from "./ClientColorProvider";

// Port of Signum.Map's Schema/SchemaMap.ts — the d3 force layout of the whole schema: a node per table,
// a curved edge per FK, click to select, shift-click to multi-select, ctrl-click to open the table's
// search page, drag to pin, double-click to unpin.
//
// altea divergences:
//  - **No MList branch.** Signum's edges came in two flavours (`isMList` synthetic owner→MList links and
//    real FKs), which drove the link distance, the arrow marker, the opacity floor and the stroke width.
//    altea has only real FKs (see data/Map.ts), so each of those is now a single expression. The
//    `@backReference` flavour keeps its dashed stroke and its double-headed start marker — that is the
//    edge Signum drew as a "virtual MList".
//  - `.contains(x)` → `.includes(x)` (altea ships no such String/Array extension).
export type RelationFilterMode = "All" | "Selected" | "SelectedAndNeighbors";

export class SchemaMapD3 {

    nodes!: ITableInfo[];
    links!: IRelationInfo[];
    simulation: d3.Simulation<ITableInfo, IRelationInfo>;
    fanIn: { [key: string]: IRelationInfo[] };

    selectedTables: Set<ITableInfo> = new Set();

    link: d3.Selection<SVGPathElement, IRelationInfo, any, any>;

    nodeGroup: d3.Selection<SVGGElement, ITableInfo, any, any>;
    node: d3.Selection<SVGRectElement, ITableInfo, any, any>;
    label: d3.Selection<SVGTextElement, ITableInfo, any, any>;
    titles: d3.Selection<SVGTitleElement, ITableInfo, any, any>;

    constructor(
        public svgElement: SVGElement,
        public providers: { [name: string]: ClientColorProvider },
        public map: SchemaMapD3Info,
        public filter: string,
        public color: string,
        public width: number,
        public height: number,
        public filterMode: RelationFilterMode = "All") {

        this.simulation = d3.forceSimulation<ITableInfo, IRelationInfo>()
            .force("bounding", forceBoundingBox(width, height))
            .force("repulsion", d3.forceManyBody().strength(-120))
            .force("collide", d3.forceCollide(30));

        this.fanIn = map.allLinks.groupToObject(a => a.toTable);

        this.regenerate();

        const svg = d3.select(svgElement)
            .attr("width", width)
            .attr("height", height);

        this.link = svg.append<SVGGElement>("svg:g").attr("class", "links").selectAll(".link")
            .data(map.allLinks)
            .enter().append<SVGPathElement>("path")
            .attr("class", "link")
            .style("stroke-dasharray", d => d.isBackReference ? "4 4" : d.lite ? "2, 2" : null)
            .style("stroke", "var(--bs-body-color)")
            .attr("marker-end", d => "url(#" + (d.lite ? "lite_arrow" : "normal_arrow") + ")")
            .attr("marker-start", d => d.isBackReference ? "url(#back_reference_arrow)" : null);

        this.selectedLinks();

        const nodesG = svg.append<SVGGElement>("svg:g").attr("class", "nodes");

        const drag = d3.drag<SVGGElement, ITableInfo>()
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

        this.nodeGroup = nodesG.selectAll(".nodeGroup")
            .data(map.allNodes)
            .enter()
            .append<SVGGElement>("svg:g")
            .attr("class", "nodeGroup")
            .attr("role", d => this.isFindable(d) ? "button" : null)
            .attr("tabindex", d => this.isFindable(d) ? 0 : null)
            .attr("aria-label", d => `Table ${d.typeName}`)
            .style("cursor", d => this.isFindable(d) ? "pointer" : null)
            .on("click", (e, d) => {

                if (e.ctrlKey && this.isFindable(d)) {
                    window.open(AppContext.toAbsoluteUrl(Finder.findOptionsPath({ queryName: d.typeName })));
                    e.preventDefault();
                    return;
                }

                if (e.shiftKey) {
                    if (this.selectedTables.has(d))
                        this.selectedTables.delete(d);
                    else
                        this.selectedTables.add(d);
                } else {
                    const onlyThis = this.selectedTables.size == 1 && this.selectedTables.has(d);
                    this.selectedTables.clear();
                    if (!onlyThis)
                        this.selectedTables.add(d);
                }

                if (this.filterMode != "All") {
                    this.regenerate();
                    this.showHideNodes();
                }

                this.selectedLinks();
                this.selectedNode();
            })
            .on("keydown", (e: KeyboardEvent, d) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    const synthetic = new MouseEvent("click", { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
                    (e.currentTarget as SVGGElement).dispatchEvent(synthetic);
                }

                if (e.ctrlKey && e.key === "Enter" && this.isFindable(d)) {
                    window.open(AppContext.toAbsoluteUrl(Finder.findOptionsPath({ queryName: d.typeName })));
                    e.preventDefault();
                }
            })
            .on("dblclick", (e, d) => {
                d.fx = null;
                d.fy = null;
                this.simulation.alpha(0.3).restart();
            })
            .call(drag);

        this.node = this.nodeGroup.append<SVGRectElement>("rect")
            .attr("class", d => "node " + d.entityBaseType)
            .attr("rx", n =>
                n.entityBaseType == "Entity" ? 7 :
                    n.entityBaseType == "Part" ? 4 :
                        n.entityBaseType == "Symbol" ? 4 :
                            n.entityBaseType == "EnumEntity" ? 3 : 0);

        const margin = 3;

        this.label = this.nodeGroup.append<SVGTextElement>("text")
            .attr("class", d => "node " + d.entityBaseType)
            .style("cursor", "pointer")
            .text(d => d.niceName)
            .each(function (d) {
                const text = this as SVGTextElement;
                wrap(text, 60);
                const b = text.getBBox();
                d.width = b.width + margin * 2;
                d.height = b.height + margin * 2;
            });

        this.node.attr("width", d => d.width)
            .attr("height", d => d.height);

        this.selectedNode();

        this.showHideNodes();

        this.label.attr("transform", d => "translate(" + d.width / 2 + ", 0)");

        this.titles = this.label.append<SVGTitleElement>("svg:title");

        this.drawColor();

        this.simulation.on("tick", this.onTick);
    }

    /** Every node here IS an entity table, so findability is just the type-Read gate. */
    isFindable(t: ITableInfo): boolean {
        return Finder.isFindable(t.typeName, true);
    }

    regenerate(): void {

        const parts = this.filter.match(/[+-]?((\w+)|\*)/g);

        function isMatch(str: string): boolean {

            if (!parts)
                return true;

            for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i];
                const pair = p.startsWith("+") ? { isPositive: true, token: p.after("+") } :
                    p.startsWith("-") ? { isPositive: false, token: p.after("-") } :
                        { isPositive: true, token: p };

                if (pair.token == "*" || str.toLowerCase().includes(pair.token.toLowerCase()))
                    return pair.isPositive;
            }

            return false;
        }

        let nodes = this.map.allNodes.filter(n => this.filter == undefined ||
            isMatch(n.namespace.toLowerCase() + "|" + n.tableName.toLowerCase() + "|" + n.niceName.toLowerCase()));

        if (this.filterMode != "All" && this.selectedTables.size > 0) {
            const visible = new Set<ITableInfo>(this.selectedTables);
            if (this.filterMode == "SelectedAndNeighbors") {
                const adj = this.getAdjacency();
                this.selectedTables.forEach(s => {
                    const nbs = adj.get(s);
                    if (nbs) nbs.forEach(nb => visible.add(nb));
                });
            }
            nodes = nodes.filter(n => visible.has(n));
            this.selectedTables.forEach(s => { if (!nodes.includes(s)) nodes.push(s); });
        } else if (this.filterMode != "All" && this.selectedTables.size == 0) {
            nodes = [];
        }

        this.nodes = nodes;

        this.links = this.map.allLinks.filter(l =>
            this.nodes.includes(l.source as ITableInfo) &&
            this.nodes.includes(l.target as ITableInfo));

        const numNodes = this.nodes.length;

        const distance =
            numNodes < 10 ? 110 :
                numNodes < 20 ? 80 :
                    numNodes < 30 ? 65 :
                        numNodes < 50 ? 50 :
                            numNodes < 100 ? 35 :
                                numNodes < 200 ? 30 : 25;

        this.simulation
            .force("link", d3.forceLink<ITableInfo, IRelationInfo>(this.links)
                .distance(d => d.lite ? distance * 1.6 : distance * 1.2)
                .strength(d => 0.7 * this.getOpacity(d.toTable))
            )
            .nodes(this.nodes)
            .alpha(1)
            .restart();
    }

    selectedLinks(): void {
        const sel = this.selectedTables;
        this.link
            .style("stroke-width", d => sel.has(d.source as ITableInfo) || sel.has(d.target as ITableInfo) ? 1.5 : 1)
            .style("opacity", d => sel.has(d.source as ITableInfo) || sel.has(d.target as ITableInfo) ? 1
                : Math.max(.1, this.getOpacity(d.toTable)));
    }

    selectedNode(): void {
        this.label.style("font-weight", d => this.selectedTables.has(d) ? "bold" : null);
    }

    showHideNodes(): void {
        this.nodeGroup.style("display", n => this.nodes.indexOf(n) == -1 ? "none" : "inline");
        this.link.style("display", r => this.links.indexOf(r) == -1 ? "none" : "inline");
    }

    /** The more tables point AT something, the fainter each of those edges is drawn. */
    static opacities: number[] = [1, .9, .8, .7, .6, .5, .4, .3, .25, .2, .15, .1, .07, .05, .03, .02];

    getOpacity(toTable: string): number {
        const length = (this.fanIn[toTable] ?? []).filter(l => this.nodes.indexOf(l.source as ITableInfo) != -1).length;

        const min = Math.min(length, SchemaMapD3.opacities.length - 1);

        return SchemaMapD3.opacities[min];
    }

    setFilter(newFilter: string): void {
        this.filter = newFilter;

        this.regenerate();
        this.selectedLinks();
        this.showHideNodes();
    }

    setFilterMode(value: RelationFilterMode): void {
        if (this.filterMode == value)
            return;
        this.filterMode = value;
        this.regenerate();
        this.selectedLinks();
        this.showHideNodes();
    }

    adjacency: Map<ITableInfo, Set<ITableInfo>> | undefined;

    getAdjacency(): Map<ITableInfo, Set<ITableInfo>> {
        if (this.adjacency)
            return this.adjacency;

        const adj = new Map<ITableInfo, Set<ITableInfo>>();
        this.map.allLinks.forEach(l => {
            const s = l.source as ITableInfo;
            const t = l.target as ITableInfo;
            let ss = adj.get(s);
            if (!ss) { ss = new Set(); adj.set(s, ss); }
            let ts = adj.get(t);
            if (!ts) { ts = new Set(); adj.set(t, ts); }
            ss.add(t);
            ts.add(s);
        });
        this.adjacency = adj;
        return adj;
    }

    setColor(newColor: string): void {
        this.color = newColor;
        this.drawColor();
    }

    drawColor(): void {
        const cp = this.providers[this.color];
        if (cp == null)
            return;

        this.node.style("fill", cp.getFill)
            .style("stroke", cp.getStroke ?? cp.getFill)
            .style("mask", a => (cp.getMask && cp.getMask(a)) || null);

        this.titles.text(t => cp.getTooltip(t) + " (" + t.entityBaseType + ")");
    }

    stop(): void {
        this.simulation.stop();
    }

    onTick = (): void => {

        const visibleLink = this.link.filter(f => this.links.indexOf(f) != -1);

        visibleLink.each(rel => {
            rel.sourcePoint = calculatePoint(rel.source as ITableInfo, rel.target as ITableInfo);
            rel.targetPoint = calculatePoint(rel.target as ITableInfo, rel.source as ITableInfo);
        });

        visibleLink.attr("d", l => this.getPathExpression(l));

        this.nodeGroup.filter(d => this.nodes.indexOf(d) != -1)
            .attr("transform", d => "translate(" +
                (d.x! - d.width / 2) + ", " +
                (d.y! - d.height / 2) + ")");
    };

    getPathExpression(l: IRelationInfo): string {

        const s = l.sourcePoint;
        const t = l.targetPoint;

        if (l.source == l.target) {

            const dx = (l.repetitions % 2) * 2 - 1;
            const dy = ((l.repetitions + 1) % 2) * 2 - 1;

            const source = l.source as ITableInfo;

            const c = calculatePoint(source, {
                x: source.x! + dx * (source.width / 2),
                y: source.y! + dy * (source.height / 2),
            });

            return `M${c.x} ${c.y} C ${c.x! + 50 * dx} ${c.y} ${c.x} ${c.y! + 50 * dy} ${c.x} ${c.y}`;
        } else {
            const p = this.getPointRepetitions(s, t, l.repetitions);
            return `M${s.x} ${s.y} Q ${p.x} ${p.y} ${t.x} ${t.y}`;
        }
    }

    getPointRepetitions(s: Point, t: Point, repetitions: number): Point {

        const m: Point = {
            x: (s.x! + t.x!) / 2,
            y: (s.y! + t.y!) / 2,
        };

        const d: Point = {
            x: (s.x! - t.x!),
            y: (s.y! - t.y!),
        };

        let h = Math.sqrt(d.x! * d.x! + d.y! * d.y!);

        if (h == 0)
            h = 1;

        // 0, 10, -10, 20, -20, 30, -30
        const repPixels = Math.floor(repetitions + 1 / 2) * ((repetitions % 2) * 2 - 1);

        return {
            x: m.x! + (d.y! / h) * 20 * repPixels,
            y: m.y! - (d.x! / h) * 20 * repPixels,
        };
    }
}
