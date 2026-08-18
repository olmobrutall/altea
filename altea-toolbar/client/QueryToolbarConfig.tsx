import * as React from "react";
import type { Location } from "react-router";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import { classes } from "@altea/altea/data/globals";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import type { FindOptions } from "@altea/altea/client/FindOptions";
import SearchValue from "@altea/altea/client/SearchControl/SearchValue";
import { useAPI, useInterval } from "@altea/altea/client/Hooks";
import type { ShowCount } from "../data/Toolbar";
import type { ToolbarResponse } from "../data/ToolbarResponse";
import { ToolbarConfig } from "./ToolbarConfig";

// Faithful port of Signum's QueryToolbarConfig.tsx (Signum.Toolbar/QueryToolbarConfig.tsx): the config for an
// element whose content is a QUERY — it navigates to that query's SearchPage (or opens it in a modal when
// `openInPopup`), and can show a live result-count badge.
//
// altea divergences:
//  - `getToString(element.content)` → `element.content!.toString()` (a QueryEntity lite's toStr IS its key,
//    which is what `queryName` wants).
//  - `SearchToolbarCount` watched the entity types behind the query's `Entity` column through
//    `Finder.getQueryDescription`. altea HAS NO QueryDescription (a documented framework divergence): the
//    equivalent facts come from the query's ROOT TOKEN (`Finder.getQueryRoot`), whose `type` is the one shared
//    TypeReference — `typeInfos()` gives the same list Signum split out of `qd.columns["Entity"].type.name`.

export default class QueryToolbarConfig extends ToolbarConfig<QueryEntity> {
    constructor() {
        const type = QueryEntity;
        super(type);
    }

    override getCounter(element: ToolbarResponse<QueryEntity>, entity: Lite<Entity> | null): React.ReactElement | undefined {
        if (element.showCount != null) {
            return (
                <SearchToolbarCount
                    findOptions={{ queryName: element.content!.toString() }}
                    color={element.iconColor ?? "red"}
                    autoRefreshPeriod={element.autoRefreshPeriod}
                    showCount={element.showCount} />
            );
        }

        return undefined;
    }

    getDefaultIcon(): IconProp {
        return "rectangle-list";
    }

    override handleNavigateClick(e: React.MouseEvent<any> | undefined, res: ToolbarResponse<QueryEntity>, selectedEntity: Lite<Entity> | null): void {
        if (!res.openInPopup)
            super.handleNavigateClick(e, res, selectedEntity);
        else {
            Finder.explore({ queryName: res.content!.toString() });
        }
    }

    navigateTo(res: ToolbarResponse<QueryEntity>): Promise<string> {
        return Promise.resolve(Finder.findOptionsPath({ queryName: res.content!.toString() }));
    }

    isCompatibleWithUrlPrio(res: ToolbarResponse<QueryEntity>, location: Location, query: any, entityType?: string): { prio: number, inferredEntity?: Lite<Entity> } | null {
        if (location.pathname == Finder.findOptionsPath({ queryName: res.content!.toString() }))
            return { prio: 1 };

        return null;
    }
}

interface CountIconProps {
    color?: string;
    autoRefreshPeriod?: number;
    findOptions: FindOptions;
    moreThanZero?: boolean;
    showCount: ShowCount;
}

/** Signum's SearchToolbarCount: the live count badge — refreshed on a timer AND whenever an entity of one of
 *  the query's types changes. */
export function SearchToolbarCount(p: CountIconProps): React.JSX.Element {

    const deps = useInterval(p.autoRefreshPeriod == null ? null : p.autoRefreshPeriod! * 1000, 0, a => a + 1);

    const [invalidations, setInvalidation] = React.useState<number>(0);

    // altea's stand-in for `qd.columns["Entity"].type.name.split(",")` — see the file header.
    const root = useAPI(() => Finder.getQueryRoot(p.findOptions.queryName), [p.findOptions.queryName]);
    const types = root?.type.typeInfos()?.map(ti => cleanTypeName(ti.ctor!)) ?? [];

    Navigator.useEntityChanged(types, () => setInvalidation(a => a + 1), [types.join(",")]);

    return <SearchValue deps={[deps, invalidations]}
        findOptions={p.findOptions}
        avoidNotifyPendingRequest={true}
        onRender={(val: number | null | undefined) => val == 0 && p.moreThanZero ? null :
            <ToolbarCount num={val} showCount={p.showCount} />}
    />;
}

export function ToolbarCount(p: { num: number | null | undefined, showCount: ShowCount }): React.JSX.Element | null {

    if (!p.num && p.showCount == "MoreThan0")
        return null;

    return (
        <div className="sf-toolbar-count-container">
            <div className={classes("badge badge-pill sf-toolbar-count", !p.num ? "text-bg-tertiary" : "text-bg-danger")}>{p.num ?? "…"}</div>
        </div>
    );
}
