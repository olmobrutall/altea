import * as React from "react";
import type { Location } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import * as AppContext from "@altea/altea/client/AppContext";
import type { Entity, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { parseIcon, fallbackIcon } from "@altea/altea/client/Components/IconHelpers";
import type { ToolbarResponse } from "../data/ToolbarResponse";
import { ToolbarNavItem, renderExtraIcons, isActive } from "./Renderers/ToolbarRenderer";

// Faithful port of Signum's ToolbarConfig.tsx (Signum.Toolbar/ToolbarConfig.tsx): the per-content-type
// CLIENT strategy — how an element pointing at a T is iconified, counted, navigated to, and recognised as
// "the current page". Each module subclasses it for its own asset (QueryToolbarConfig here;
// UserQueryToolbarConfig / UserChartToolbarConfig / DashboardToolbarConfig in their own modules) and
// registers it with `ToolbarClient.registerConfig`.
//
// altea divergences:
//  - `parseIcon` / `fallbackIcon` come from altea's IconHelpers (Signum: Components/IconTypeahead).
//  - `Type<T>` is always a constructor in altea, so `config.type` is the ctor and the registry keys off its
//    clean name (see ToolbarClient.registerConfig).

export abstract class ToolbarConfig<T extends Entity> {
    type: Type<T>;
    constructor(type: Type<T>) {
        this.type = type;
    }

    getIcon(element: ToolbarResponse<T>, entity: Lite<Entity> | null): React.ReactElement | null {
        const defaultIcon = this.getDefaultIcon();
        return (
            <>
                {ToolbarConfig.coloredIcon(parseIcon(element.iconName) ?? defaultIcon, element.iconColor)}
                {this.getCounter(element, entity)}
            </>
        );
    }

    /** Signum's hook for a url carrying `:id2`/`:key2`: pick the SECOND entity the url needs. */
    async selectSubEntityForUrl(element: ToolbarResponse<T>, entity: Lite<Entity> | null): Promise<Lite<Entity> | undefined> {
        return undefined;
    }

    abstract getDefaultIcon(): IconProp;

    static coloredIcon(icon: IconProp | undefined, color: string | undefined): React.ReactElement | null {
        if (!icon)
            return null;

        return <FontAwesomeIcon aria-hidden={true} icon={fallbackIcon(icon)} className={"icon"} color={color} />;
    }

    /** Signum's hook for the result-count badge (QueryToolbarConfig / UserQueryToolbarConfig fill it). */
    getCounter(element: ToolbarResponse<T>, entity: Lite<Entity> | null): React.ReactElement | undefined {
        return undefined;
    }

    abstract navigateTo(element: ToolbarResponse<T>, selectedEntity: Lite<Entity> | null): Promise<string | null>;

    /** Signum's `isCompatibleWithUrlPrio`: does the CURRENT location correspond to this element (and with
     *  what priority, so the most specific element wins the "active" highlight)? */
    abstract isCompatibleWithUrlPrio(element: ToolbarResponse<T>, location: Location, query: any, entityType?: string): { prio: number, inferredEntity?: Lite<Entity> } | null;

    handleNavigateClick(e: React.MouseEvent<any> | undefined, res: ToolbarResponse<any>, selectedEntity: Lite<Entity> | null): void {
        e?.preventDefault();
        this.navigateTo(res, selectedEntity).then(url => {
            if (url)
                AppContext.pushOrOpenInTab(url, e);
        });
    }

    /** Signum's `isApplicableTo`: lets two configs share one content TYPE and split by the response (the
     *  registry picks the single applicable one). */
    isApplicableTo(element: ToolbarResponse<T>): boolean {
        return true;
    }

    getMenuItem(res: ToolbarResponse<T>, key: number | string, ctx: ToolbarContext, selectedEntity: Lite<Entity> | null): React.JSX.Element {
        return (
            <ToolbarNavItem key={key}
                title={res.label}
                content={res.content}
                onClick={(e: React.MouseEvent<any>) => {
                    this.handleNavigateClick(e, res, selectedEntity);
                    if (ctx.onAutoClose && !(e.ctrlKey || (e as React.MouseEvent<any>).button == 1))
                        ctx.onAutoClose();
                }}
                active={isActive(ctx.active, res, selectedEntity)}
                extraIcons={renderExtraIcons(res.extraIcons, ctx, selectedEntity)}
                icon={this.getIcon(res, selectedEntity)}
            />
        );
    }
}

/** Signum's ToolbarContext — threaded down the render tree: close the sidebar after a click, ask for a
 *  refresh, and know which response is currently active. */
export interface ToolbarContext {
    onAutoClose?: () => void;
    onRefresh: () => void;
    active: InferActiveResponse | null;
}

/** Signum's InferActiveResponse — which element the current URL corresponds to, with what priority, and (for
 *  an entity-scoped menu) which entity the URL implies. */
export interface InferActiveResponse {
    prio: number;
    response: ToolbarResponse<any>;
    inferredEntity?: Lite<Entity>;
    menuWithEntity?: { menu: ToolbarResponse<any>, entity: Lite<Entity> };
}

/** Signum's IconColor — the icon + color pair a config may hand back. */
export interface IconColor {
    icon: IconProp;
    iconColor: string;
}
