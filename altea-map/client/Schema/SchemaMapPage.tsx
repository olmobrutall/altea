import "@altea/altea/data/globals/arrayExtensions";
import "@altea/altea/data/globals/stringExtensions";
import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { OverlayTrigger, Popover } from "react-bootstrap";
import { useLocation, type Location } from "react-router";
import { Dic } from "@altea/altea/data/globals/helpers";
import * as AppContext from "@altea/altea/client/AppContext";
import { FrameMessage, JavascriptMessage } from "@altea/altea/data/uiMessages";
import { useSize } from "@altea/altea/client/Hooks";
import { QueryString } from "@altea/altea/client/QueryString";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { MapMessage, type SchemaMapInfo } from "../../data/Map";
import { MapClient } from "../MapClient";
import { type RelationFilterMode, SchemaMapD3 } from "./SchemaMap";
import { MAP_MIN_HEIGHT } from "../Utils";
import {
    getAllProviders,
    type ClientColorProvider, type IRelationInfo, type ITableInfo, type SchemaMapD3Info,
} from "./ClientColorProvider";
import "./schemaMap.css";

// Port of Signum.Map's Schema/SchemaMapPage.tsx — the /map page: the filter / colour / show toolbar, the
// help popover, the fullscreen link, and the SVG the d3 controller draws into.
//
// altea divergences:
//  - **No `useExpand()` / `Expander.Options.onGetExpanded` gate.** Signum has an "expand the page to full
//    width" mechanism plus a render-suppressing check; altea has neither, so the early `return null` goes
//    with it and the graph container gets an explicit `MAP_MIN_HEIGHT` instead (see Utils).
//  - `fixSchemaMap` is much shorter: with MList gone `allNodes` IS `tables` and `allLinks` IS
//    `relations`, so the synthetic MList nodes and their links are not built (see data/Map.ts).
//  - The `mlist_arrow` marker is dropped and `virtual_mlist_arrow` is renamed `back_reference_arrow`,
//    matching the field it draws.

interface ParsedQueryString {
    filter?: string;
    color?: string;
    showRelations?: RelationFilterMode;
    tables: Tables;
}

interface Tables {
    [tableName: string]: { x: number; y: number };
}

/** The fullscreen link round-trips the pinned node positions (as fractions) through the query string. */
function getParsedQuery(location: Location): ParsedQueryString {

    const result: ParsedQueryString = { tables: {} };

    const query = QueryString.parse(location.search);
    if (!query)
        return result;

    Dic.foreach(query, (name, value) => {

        if (name == "filter")
            result.filter = value;
        else if (name == "color")
            result.color = value;
        else if (name == "showRelations") {
            if (value == "All" || value == "Selected" || value == "SelectedAndNeighbors")
                result.showRelations = value;
        }
        else {
            result.tables[name] = {
                x: parseFloat(value.before(",")),
                y: parseFloat(value.after(",")),
            };
        }
    });

    return result;
}

export default function SchemaMapPage(): React.JSX.Element | null {
    const location = useLocation();

    const [filter, setFilter] = React.useState<string>("");
    const [color, setColor] = React.useState<string>("");
    const [showRelations, setShowRelations] = React.useState<RelationFilterMode>("All");
    const [tables, setTables] = React.useState<Tables | undefined>(undefined);
    const [schemaInfo, setSchemaInfo] = React.useState<SchemaMapInfo | undefined>(undefined);
    const [providers, setProviders] = React.useState<{ [name: string]: ClientColorProvider } | undefined>(undefined);

    React.useEffect(() => {
        MapClient.API.types().then(smi => {
            const parsedQuery = getParsedQuery(location);
            getAllProviders(smi).then(providers => {

                // The server announces the dropdown entries and the client owns the scales, so a mismatch
                // means one half was not registered — worth failing loudly rather than rendering a page
                // whose "Color" dropdown silently paints nothing.
                const missingProviders = smi.providers.filter(p => !providers.some(p2 => p2.name == p.name));
                if (missingProviders.length)
                    throw new Error(`Missing ClientColorProvider for ${missingProviders.map(a => "'" + a.name + "'").joinComma("and")} found`);

                const extraProviders = providers.filter(p => !smi.providers.some(p2 => p2.name == p.name));
                if (extraProviders.length)
                    throw new Error(`Extra ClientColorProvider for ${extraProviders.map(a => "'" + a.name + "'").joinComma("and")} found`);

                setFilter(parsedQuery.filter ?? "");
                setTables(parsedQuery.tables);
                setColor(parsedQuery.color ?? smi.providers.first().name);
                setShowRelations(parsedQuery.showRelations ?? "All");
                setSchemaInfo(smi);
                setProviders(providers.toObject(a => a.name));
            });
        });
    }, []);

    const { size, setContainer } = useSize();

    function handleFullscreenClick(): void {

        const pinned = (schemaInfo as SchemaMapD3Info).allNodes.filter(a => a.fx != null && a.fy != null)
            .toObject(a => a.tableName, a =>
                (a.fx! / size!.width!).toPrecision(4) + "," +
                (a.fy! / size!.height!).toPrecision(4));

        const query = {
            ...pinned, filter: filter, color: color,
            showRelations: showRelations != "All" ? showRelations : undefined,
        };

        window.open(AppContext.toAbsoluteUrl("/map?" + QueryString.stringify(query)));
    }

    function renderFilter(): React.JSX.Element {
        return (
            <div className="container">
                <div className="row align-items-center">
                    <div className="col-auto">
                        <label htmlFor="filter"> {MapMessage.Filter.niceToString()}</label>&nbsp;
                    </div>
                    <div className="col-auto">
                        <input type="text" className="form-control form-control-sm" id="filter" placeholder="type or package" value={filter} onChange={e => setFilter(e.currentTarget.value)} />
                    </div>
                    <div className="col-auto">
                        <label htmlFor="color"> {MapMessage.Color.niceToString()}</label>&nbsp;
                    </div>
                    <div className="col-auto">
                        <select className="form-select form-select-sm" id="color" value={color} onChange={e => setColor(e.currentTarget.value)}>
                            {schemaInfo?.providers.map((a, i) =>
                                <option key={i} value={a.name}>{a.niceName}</option>)}
                        </select>
                    </div>
                    <div className="col-auto">
                        <label htmlFor="showItems"> {MapMessage.Show.niceToString()}</label>&nbsp;
                    </div>
                    <div className="col-auto">
                        <select className="form-select form-select-sm" id="showItems" value={showRelations} onChange={e => setShowRelations(e.currentTarget.value as RelationFilterMode)}>
                            <option value="All">{MapMessage.All.niceToString()}</option>
                            <option value="Selected">{MapMessage.Selected.niceToString()}</option>
                            <option value="SelectedAndNeighbors">{MapMessage.SelectedAndNeighbors.niceToString()}</option>
                        </select>
                    </div>
                    <div className="col-auto">
                        <OverlayTrigger
                            trigger="click"
                            rootClose
                            placement="bottom-end"
                            overlay={
                                <Popover id="schemaMapHelpPopover">
                                    <Popover.Header as="h3">{MapMessage.Help.niceToString()}</Popover.Header>
                                    <Popover.Body>
                                        <div>{MapMessage.HelpClick.niceToString()}</div>
                                        <div className="mt-1">{MapMessage.HelpShiftClick.niceToString()}</div>
                                        <div className="mt-1">{MapMessage.HelpCtrlClick.niceToString()}</div>
                                    </Popover.Body>
                                </Popover>
                            }>
                            <LinkButton title={MapMessage.Help.niceToString()} id="sfMapHelp" className="me-2">
                                <FontAwesomeIcon aria-hidden={true} icon="circle-question" />
                            </LinkButton>
                        </OverlayTrigger>
                        <LinkButton title={FrameMessage.Fullscreen.niceToString()} id="sfFullScreen" className="sf-popup-fullscreen" onClick={handleFullscreenClick}>
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
            {!(schemaInfo && providers && tables) ?
                <span>{JavascriptMessage.loading.niceToString()}</span> :
                <div ref={setContainer} style={{ display: "flex", flexGrow: 1, minHeight: MAP_MIN_HEIGHT }}>
                    {size?.height && size?.width &&
                        <SchemaMapRenderer
                            schemaMapInfo={schemaInfo}
                            tables={tables}
                            filter={filter}
                            color={color}
                            showRelations={showRelations}
                            height={size.height}
                            width={size.width}
                            providers={providers}
                        />}
                </div>}
        </div>
    );
}

export interface SchemaMapRendererProps {
    schemaMapInfo: SchemaMapInfo;
    filter: string;
    color: string;
    showRelations: RelationFilterMode;
    width: number;
    height: number;
    providers: { [name: string]: ClientColorProvider };
    tables: Tables;
}

export function SchemaMapRenderer(p: SchemaMapRendererProps): React.JSX.Element {

    const mapD3Ref = React.useRef<SchemaMapD3 | undefined>(undefined);
    const svgRef = React.useRef<SVGSVGElement>(null);

    React.useEffect(() => {
        const map = fixSchemaMap(p.schemaMapInfo as SchemaMapD3Info, p.tables);
        mapD3Ref.current = new SchemaMapD3(svgRef.current!, p.providers, map, p.filter, p.color, p.width, p.height, p.showRelations);

        return () => { mapD3Ref.current!.stop(); };
    }, []);

    React.useEffect(() => { mapD3Ref.current!.setColor(p.color); }, [p.color]);
    React.useEffect(() => { mapD3Ref.current!.setFilter(p.filter); }, [p.filter]);
    React.useEffect(() => { mapD3Ref.current!.setFilterMode(p.showRelations); }, [p.showRelations]);

    /**
     * Resolve the payload into the graph d3 mutates: place each node (pinned from the query string, else
     * at random), point each relation at its endpoint objects, and number the edges that share a pair so
     * they bow out separately.
     */
    function fixSchemaMap(map: SchemaMapD3Info, tables: Tables): SchemaMapD3Info {

        map.allNodes = map.tables as ITableInfo[];

        map.allNodes.forEach(a => {
            const c = tables[a.tableName];
            if (c) {
                a.fx = c.x * p.width;
                a.fy = c.y * p.height;
            }
            else {
                a.x = Math.random() * p.width;
                a.y = Math.random() * p.height;
            }
        });

        const nodesDic = map.allNodes.toObject(g => g.tableName);

        map.allLinks = map.relations as IRelationInfo[];
        map.allLinks.forEach(a => {
            a.source = nodesDic[a.fromTable];
            a.target = nodesDic[a.toTable];
        });

        const repsDic: { [tableName: string]: number } = {};

        map.allLinks.forEach(l => {

            const sourceName = (l.source as ITableInfo).tableName;
            const targetName = (l.target as ITableInfo).tableName;

            const relName = sourceName > targetName ?
                sourceName + "-" + targetName :
                targetName + "-" + sourceName;

            if (repsDic[relName] == undefined)
                repsDic[relName] = 0;

            l.repetitions = repsDic[relName];
            repsDic[relName]++;
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

                    <marker id="lite_arrow" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="10" markerHeight="10" orient="auto">
                        <path fill="gray" d="M5,0L0,-5L10,0L0,5L5,0" />
                    </marker>

                    {/* Signum's `virtual_mlist_arrow`, renamed for the field it now draws: a `@backReference`. */}
                    <marker id="back_reference_arrow" viewBox="-10 -5 20 10" refX="-10" refY="0" markerWidth="10" markerHeight="20" orient="auto">
                        <path fill="gray" d="M0,0 L0,-8 L-10,0 L0,8 L0,0 L10,8 L10,-8 L0,0" />
                    </marker>

                    {Dic.getValues(p.providers).map(a => a.defs).filter(defs => !!defs).flatMap(defs => defs!)}
                </defs>
            </svg>
        </div>
    );
}
