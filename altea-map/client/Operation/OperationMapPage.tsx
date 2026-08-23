import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";
import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useLocation, useParams, type Location } from "react-router";
import { Dic } from "@altea/altea/data/globals/helpers";
import * as AppContext from "@altea/altea/client/AppContext";
import { FrameMessage, JavascriptMessage } from "@altea/altea/data/uiMessages";
import { useAPI, useSize } from "@altea/altea/client/Hooks";
import { QueryString } from "@altea/altea/client/QueryString";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { MapMessage, type OperationMapInfo } from "../../data/Map";
import { MapClient } from "../MapClient";
import {
    OperationMapD3,
    type ForceLink, type ForceNode, type IMapState, type OperationMapD3Info, type Transition,
} from "./OperationMap";
import { MAP_MIN_HEIGHT } from "../Utils";
import "./operationMap.css";

// Port of Signum.Map's Operation/OperationMapPage.tsx — the /map/:type page: the colour dropdown, the
// fullscreen link, and the SVG the d3 controller draws into.
//
// altea divergences (both shared with SchemaMapPage):
//  - no `useExpand()` / `Expander` gate — altea has no such mechanism, so the graph container carries an
//    explicit `MAP_MIN_HEIGHT` (see Utils);
//  - no `fromToStates` branch in `fixOperationMap`: the transitions are the cartesian product of each
//    operation's from and to state lists (see data/Map.ts).

interface ParsedQueryString {
    color?: string;
    nodes: Nodes;
}

export interface Nodes {
    [nodeName: string]: { x: number; y: number };
}

function getParsedQuery(loc: Location): ParsedQueryString {
    const result: ParsedQueryString = { nodes: {} };

    const query = QueryString.parse(loc.search);
    if (!query)
        return result;

    Dic.foreach(query, (name, value) => {
        if (name == "color")
            result.color = value;
        else
            result.nodes[name] = {
                x: parseFloat(value.before(",")),
                y: parseFloat(value.after(",")),
            };
    });

    return result;
}

export default function OperationMapPage(): React.JSX.Element | null {
    const params = useParams() as { type: string };
    const location = useLocation();

    const [color, setColor] = React.useState<string>("state");
    const [nodes, setNodes] = React.useState<Nodes | undefined>(undefined);

    const operationMapInfo = useAPI(() => MapClient.API.operations(params.type), [params.type]);

    React.useEffect(() => {
        const parsedQuery = getParsedQuery(location);

        setNodes(parsedQuery.nodes);
        setColor(parsedQuery.color ?? "state");
    }, []);

    const { size, setContainer } = useSize();

    function handleFullscreenClick(): void {

        const pinned = (operationMapInfo as OperationMapD3Info).allNodes.filter(a => a.fx != null && a.fy != null)
            .toObject(a => a.key, a =>
                (a.fx! / size!.width!).toPrecision(4) + "," +
                (a.fy! / size!.height!).toPrecision(4));

        const query = { ...pinned, color: color };

        window.open(AppContext.toAbsoluteUrl("/map/" + params.type + "?" + QueryString.stringify(query)));
    }

    function renderFilter(): React.JSX.Element {
        return (
            <div className="container">
                <div className="row align-items-center">
                    <div className="col-auto">
                        <label htmlFor="color"> {MapMessage.Color.niceToString()}</label>
                    </div>
                    <div className="col-auto">
                        <select className="form-select form-select-sm" id="color" value={color} onChange={e => setColor(e.currentTarget.value)}>
                            <option value="state">{MapMessage.StateColor.niceToString()}</option>
                            <option value="rows">{MapMessage.Rows.niceToString()}</option>
                        </select>
                    </div>
                    <div className="col-auto">
                        <span style={{ marginLeft: "10px" }}>
                            {MapMessage.Press0ToExploreEachTable.niceToString().formatHtml(<u>Ctrl + Click</u>)}
                        </span>
                        &nbsp;
                        <LinkButton id="sfFullScreen" className="sf-popup-fullscreen" onClick={handleFullscreenClick} title={FrameMessage.Fullscreen.niceToString()}>
                            <FontAwesomeIcon aria-hidden={true} icon="up-right-from-square" />
                        </LinkButton>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
            {renderFilter()}
            {!(operationMapInfo && nodes) ?
                <span>{JavascriptMessage.loading.niceToString()}</span> :
                <div ref={setContainer} style={{ display: "flex", flexGrow: 1, minHeight: MAP_MIN_HEIGHT }}>
                    {size?.height && size?.width &&
                        <OperationMapRenderer
                            operationMapInfo={operationMapInfo}
                            nodes={nodes}
                            color={color}
                            height={size.height}
                            width={size.width}
                            queryName={params.type}
                        />}
                </div>}
        </div>
    );
}

export interface OperationMapRendererProps {
    queryName: string;
    operationMapInfo: OperationMapInfo;
    width: number;
    height: number;
    nodes: Nodes;
    color: string;
}

export function OperationMapRenderer(p: OperationMapRendererProps): React.JSX.Element {

    const svgRef = React.useRef<SVGSVGElement>(null);
    const mapD3 = React.useRef<OperationMapD3 | null>(null);

    React.useEffect(() => {
        const map = fixOperationMap(p.operationMapInfo as OperationMapD3Info, p.nodes);
        mapD3.current = new OperationMapD3(svgRef.current!, p.queryName, map, p.color, p.width, p.height);
        return () => mapD3.current!.stop();
    }, []);

    React.useEffect(() => {
        mapD3.current!.setColor(p.color);
    }, [p.color]);

    /**
     * Resolve the payload into the graph d3 mutates: place each node, build the SPRING links (state ↔
     * operation, which is what the force layout pulls on) and the drawn TRANSITIONS (fromState →
     * operation → toState), then compute each state's fan-in / fan-out balance.
     */
    function fixOperationMap(map: OperationMapD3Info, nodes: Nodes): OperationMapD3Info {
        map.allNodes = (map.operations as ForceNode[]).concat(map.states);

        map.allNodes.forEach(a => {
            const c = nodes[a.key];
            if (c) {
                a.fx = c.x * p.width;
                a.fy = c.y * p.height;
            } else {
                a.x = Math.random() * p.width;
                a.y = Math.random() * p.height;
            }
        });

        const statesDic = map.states.toObject(g => g.key);

        const fromRelationships = map.operations
            .flatMap(op => op.fromStates.map(s => ({ source: statesDic[s], target: op, isFrom: true }) as ForceLink));

        const toRelationships = map.operations
            .flatMap(op => op.toStates.map(s => ({ source: op, target: statesDic[s], isFrom: false }) as ForceLink));

        map.allLinks = fromRelationships.concat(toRelationships);

        map.allTransition = map.operations.flatMap(o =>
            o.fromStates.flatMap(f => o.toStates.map(t => ({
                fromState: statesDic[f],
                operation: o,
                toState: statesDic[t],
            }) as Transition)));

        const fanOut = map.operations.flatMap(a => a.fromStates.map(s => ({ s, weight: 1.0 / a.fromStates.length }))).groupToObject(a => a.s);
        const fanIn = map.operations.flatMap(a => a.toStates.map(s => ({ s, weight: 1.0 / a.toStates.length }))).groupToObject(a => a.s);

        map.states.forEach((m: IMapState) => {
            m.fanOut = fanOut[m.key] ? fanOut[m.key].reduce((acum, e) => acum + e.weight, 0) : 0;
            m.fanIn = fanIn[m.key] ? fanIn[m.key].reduce((acum, e) => acum + e.weight, 0) : 0;

            m.fanInOutFactor = (m.fanIn - m.fanOut) / (m.fanIn + m.fanOut);
        });

        return map;
    }

    return (
        <div id="map" style={{ backgroundColor: "var(--bs-transparent)", width: "100%", height: p.height + "px" }}>
            <svg id="svgMap" ref={svgRef}>
                <defs>
                    <marker id="normal_arrow" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="10" markerHeight="10" orient="auto">
                        <path fill="gray" d="M0,0L0,-5L10,0L0,5L0,0" />
                    </marker>
                </defs>
            </svg>
        </div>
    );
}
