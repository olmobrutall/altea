import * as React from "react";
import { useLocation, type Location } from "react-router";
import "@altea/altea/data/globals/arrayExtensions";
import { classes } from "@altea/altea/data/globals";
import { useAPI, useUpdatedRef } from "@altea/altea/client/Hooks";
import { QueryString } from "@altea/altea/client/QueryString";
import type { ToolbarResponse } from "../../data/ToolbarResponse";
import { ToolbarClient } from "../ToolbarClient";
import type { InferActiveResponse, ToolbarContext } from "../ToolbarConfig";
import { inferActive, isCompatibleWithUrl, renderNavItem } from "./ToolbarRenderer";
import "@altea/altea/client/Frames/Widgets.css";
import "./Toolbar.css";

// Faithful port of Signum's ToolbarTopRenderer.tsx (Signum.Toolbar/Renderers/ToolbarTopRenderer.tsx): the
// `Top` toolbar, rendered inside the navbar. Same element machinery as the sidebar (renderNavItem), only the
// container differs — plus one behavioural detail Signum has here and not in the sidebar: if the ACTIVE
// response is still compatible with the new location, the active item is left alone (a top bar should not
// flicker while navigating within one section).
//
// No altea divergences beyond the import paths.

export default function ToolbarTopRenderer(): React.ReactElement | null {
    const response = useAPI(() => ToolbarClient.API.getCurrentToolbar("Top"), []);
    const responseRef = useUpdatedRef(response);

    const [refresh, setRefresh] = React.useState(false);
    const [active, setActive] = React.useState<InferActiveResponse | null>(null);
    const activeRef = useUpdatedRef(active);

    function changeActive(location: Location): void {
        const query = QueryString.parse(location.search);
        if (responseRef.current) {
            if (activeRef.current && isCompatibleWithUrl(activeRef.current.response, location, query, undefined)) {
                return;
            }

            const newActive = inferActive(responseRef.current, location, query);
            setActive(newActive ?? null);
        }
    }
    const location = useLocation();
    React.useEffect(() => {
        if (response != null)
            changeActive(location);
    }, [response, location]);

    function handleRefresh(): number {
        return window.setTimeout(() => setRefresh(!refresh), 500);
    }

    const ctx: ToolbarContext = {
        active: active,
        onRefresh: handleRefresh,
    };

    return (
        <div className={classes("nav navbar-nav")}>
            {response && response.elements && response.elements.map((res: ToolbarResponse<any>, i: number) => renderNavItem(res, i, ctx, null))}
        </div>
    );
}
