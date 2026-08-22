import * as React from "react";
import type { Location } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import * as AppContext from "@altea/altea/client/AppContext";
import { useAPI } from "@altea/altea/client/Hooks";
import { getTypeInfo, getQueryNiceName } from "@altea/altea/client/Reflection";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { TypeInfo } from "@altea/altea/data/reflection";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { ToolbarConfig, type ToolbarContext } from "@altea/altea-toolbar/client/ToolbarConfig";
import type { ToolbarResponse } from "@altea/altea-toolbar/data/ToolbarResponse";
import { ToolbarNavItem } from "@altea/altea-toolbar/client/Renderers/ToolbarRenderer";
import { WorkflowEntity, WorkflowMainEntityStrategy, WorkflowPermission } from "../data/Workflow";
import { InboxRowModel } from "../data/CaseActivity";
import { WorkflowClient } from "./WorkflowClient";

// Port of Signum.Workflow's WorkflowToolbarMenuConfig.tsx — ONE toolbar element (a WorkflowToolbarMenu
// permission) expands into the whole workflow menu: the inbox, plus a "start a case" item per workflow ×
// main-entity strategy. Signum's older navbar `WorkflowDropdown.tsx` is NOT ported — this config superseded it,
// and eastwind's Layout renders the toolbar sidebar.
//
// altea divergences: `mainEntityStrategies` is a plain array of @part rows carrying an ORDINAL, and
// `location.href.contains` becomes `window.location.href.includes`.

export default class WorkflowToolbarMenuConfig extends ToolbarConfig<PermissionSymbol> {

    constructor() {
        super(PermissionSymbol);
    }

    override getDefaultIcon(): IconProp {
        return "shuffle";
    }

    override isApplicableTo(element: ToolbarResponse<PermissionSymbol>): boolean {
        return element.content != null && element.content.is(WorkflowPermission.WorkflowToolbarMenu);
    }

    override getMenuItem(res: ToolbarResponse<PermissionSymbol>, key: number | string,
        ctx: ToolbarContext): React.JSX.Element {
        return <WorkflowDropdownImp key={key} />;
    }

    override isCompatibleWithUrlPrio(res: ToolbarResponse<PermissionSymbol>, location: Location, query: any):
        { prio: number, inferredEntity?: Lite<Entity> } | null {
        return null;
    }

    override navigateTo(): Promise<string> {
        return Promise.resolve("");
    }
}

interface WorkflowStart {
    workflow: WorkflowEntity;
    typeInfo: TypeInfo;
    mainEntityStrategy: WorkflowMainEntityStrategy;
}

function WorkflowDropdownImp(): React.JSX.Element | null {
    const [show, setShow] = React.useState(false);

    const starts = useAPI(() => WorkflowClient.API.starts(), []);

    function getStarts(starts: WorkflowEntity[]): { key: string, elements: WorkflowStart[] }[] {
        return starts.flatMap(w => {
            const typeInfo = getTypeInfo(w.mainEntityType!.cleanName);

            return w.mainEntityStrategies.map(ws => ({
                workflow: w, typeInfo, mainEntityStrategy: ws.strategy,
            }) as WorkflowStart);
        }).filter(kvp => !!kvp.typeInfo)
            .groupBy(kvp => cleanTypeName(kvp.typeInfo.ctor!));
    }

    if (!starts)
        return null;

    const inboxItem = (key?: string): React.JSX.Element =>
        <ToolbarNavItem key={key} title={getQueryNiceName(InboxRowModel)}
            active={window.location.href.includes("/find/InboxRowModel")}
            onClick={(e: React.MouseEvent<any>) => { AppContext.pushOrOpenInTab(Options.getInboxUrl(), e); }}
            icon={ToolbarConfig.coloredIcon("inbox", "steelblue")} />;

    return (
        <div>
            {starts.length === 0 && inboxItem()}

            {starts.length > 0 &&
                <>
                    <ToolbarNavItem
                        title={WorkflowEntity.nicePluralName()}
                        onClick={() => setShow(!show)}
                        icon={
                            <div style={{ display: "inline-block", position: "relative" }}>
                                <div className="nav-arrow-icon" style={{ position: "absolute" }}>
                                    <FontAwesomeIcon icon={show ? "caret-down" : "caret-right"} className="icon" />
                                </div>
                                <div className="nav-icon-with-arrow">
                                    {ToolbarConfig.coloredIcon("shuffle", "mediumvioletred")}
                                </div>
                            </div>
                        } />

                    <div style={{ display: show ? "block" : "none" }}>

                        {inboxItem("inbox")}

                        {getStarts(starts).flatMap((kvp, i) => kvp.elements.map((val, j) =>
                            <ToolbarNavItem key={i + "-" + j}
                                title={val.workflow.toString()
                                    + (val.mainEntityStrategy === WorkflowMainEntityStrategy.CreateNew ? ""
                                        : ` (${Enum.niceName(WorkflowMainEntityStrategy, val.mainEntityStrategy)})`)}
                                onClick={(e: React.MouseEvent<any>) => {
                                    AppContext.pushOrOpenInTab(WorkflowClient.workflowStartUrl(
                                        val.workflow.toLite(), val.mainEntityStrategy), e);
                                }}
                                active={false}
                                icon={ToolbarConfig.coloredIcon("square-plus", "seagreen")}
                            />)
                        )}
                    </div>
                </>
            }
        </div>
    );
}

export namespace Options {
    export function getInboxUrl(): string {
        return WorkflowClient.getDefaultInboxUrl();
    }
}
