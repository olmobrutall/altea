import * as React from "react";
import { Tab, Tabs } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { NumberLine } from "@altea/altea/client/Lines/NumberLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { RenderEntity } from "@altea/altea/client/Lines/RenderEntity";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { ViewPromise } from "@altea/altea/client/EntitySettings";
import SelectorModal from "@altea/altea/client/SelectorModal";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";
import CollapsableCard from "@altea/altea/client/Components/CollapsableCard";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { Enum } from "@altea/altea/data/enum";
import { cleanTypeName } from "@altea/altea/data/registration";
import { UserAssetMessage } from "@altea/altea-user-assets/data/UserAssets";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import {
    DashboardEntity, DashboardMessage, InteractionGroupEnum, DashboardEntity_Parts, type IPartEntity,
} from "../../data/Dashboard";
import { DashboardClient } from "../DashboardClient";
import { EntityGridItem, type EntityGridItemProps, EntityGridRepeater } from "./EntityGridRepeater";
import { parseIcon, fallbackIcon } from "@altea/altea/client/Components/IconHelpers";
import "../Dashboard.css";

// Port of Signum's Signum.Dashboard/Admin/Dashboard.tsx — the dashboard EDITOR: the header fields, the
// "Parts" tab (the 12-column drag/resize grid, each cell rendering its part's own editor) and the
// "Token equivalences" tab.
//
// altea divergences:
//  - The "used by" Toolbar SearchValueLines and the CacheQueryConfiguration block are gone (Toolbar /
//    CachedQuery are not ported).
//  - `getTypeInfos(pr.type)` → `ctx.memberType.typeInfos()` (altea's TypeReference facet accessor).
//  - The part editors receive the owning `dashboard` through RenderEntity's `extraProps` (as Signum did);
//    altea's TypeContext has no `findParentCtx`, so that is the ONLY channel — every part editor takes a
//    `dashboard?: DashboardEntity` prop.

const interactionColors = ["#DFFF00", "#FFBF00", "#FF7F50", "#DE3163", "#9FE2BF", "#40E0D0", "#6495ED", "#CCCCFF"];

export default function Dashboard(p: { ctx: TypeContext<DashboardEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const ctxBasic = ctx.subCtx({ formGroupStyle: "Basic" });
    const ctxLabel5 = ctx.subCtx({ labelColumns: 5 });
    const icon = parseIcon(ctx.value.iconName) ?? "border-none";

    // Signum did this in the C# setter of EntityType (altea entities are plain field bags).
    function handleEntityTypeChange(): void {
        if (!ctx.value.entityType) {
            ctx.value.embeddedInEntity = null;
            ctx.value.showTitleAsBreadcrumb = false;
        }

        forceUpdate();
    }

    // The queries the parts read — offered in the token-equivalence editor (Signum's allQueryNames).
    const allQueryKeys = (ctx.value.parts ?? [])
        .flatMap(part => part.content == null ? [] : DashboardClient.getQueryNames(part.content))
        .distinctBy(a => a)
        .orderBy(a => a);

    // `pr` is the part ROW's property route (the grid line passes `propertyRoute.add("Item")`), so the
    // content field's implementedBy list — the pickable part types — reads off it (Signum used
    // `DashboardEntity.memberInfo(a => a.parts![0].element.content)`).
    function handleOnCreate(pr: PropertyRoute): Promise<DashboardEntity_Parts | undefined> {
        const contentType = pr.add("content").fieldInfo!;
        return SelectorModal.chooseType(contentType.typeInfos(), {
            buttonDisplay: ti => {
                const ic = DashboardClient.icon(cleanTypeName(ti.ctor!));
                return <><FontAwesomeIcon aria-hidden={true} icon={ic.icon} color={ic.iconColor} /><span className="ms-2">{ti.getNiceName()}</span></>;
            },
        }).then(ti => {
            if (ti == undefined)
                return undefined;

            const part = new DashboardEntity_Parts();
            part.content = new (ti.ctor as unknown as new () => IPartEntity)();
            return part;
        });
    }

    function renderPart(tc: TypeContext<DashboardEntity_Parts>): React.JSX.Element {
        return <DashboardPart tc={tc} dashboard={ctx.value} />;
    }

    return (
        <div>
            <div>
                <EntityLine ctx={ctx.subCtx(cp => cp.owner)} create={false} />
                <AutoLine ctx={ctx.subCtx(cp => cp.displayName)}
                    helpText={<div className="d-flex">
                        {icon && <div className="mx-2">
                            <FontAwesomeIcon icon={fallbackIcon(icon)} style={{ color: ctx.value.iconColor ?? undefined, fontSize: "25px", cursor: "pointer" }}
                                onClick={() => selectIcon(ctx).then(a => {
                                    if (a) {
                                        ctx.value.iconName = a.iconName;
                                        ctx.value.iconColor = a.iconColor;
                                        ctx.value.titleColor = (a as DashboardEntity).titleColor;
                                        forceUpdate();
                                    }
                                })} />
                        </div>}
                        <CheckboxLine ctx={ctx.subCtx(cp => cp.hideDisplayName)} inlineCheckbox />
                    </div>} />

                <div className="row">
                    <div className="col-sm-8">
                        <EntityLine ctx={ctx.subCtx(cp => cp.entityType)} onChange={handleEntityTypeChange} labelColumns={3}
                            helpText={ctx.value.entityType && <div className="d-flex gap-3">
                                <CheckboxLine ctx={ctx.subCtx(e => e.hideQuickLink)} inlineCheckbox />
                                <CheckboxLine ctx={ctx.subCtx(e => e.showTitleAsBreadcrumb)} inlineCheckbox />
                            </div>}
                        />
                    </div>
                    {ctx.value.entityType && <div className="col-sm-4">
                        <AutoLine ctx={ctxLabel5.subCtx(f => f.embeddedInEntity)} />
                    </div>}
                </div>

                <CollapsableCard header={UserAssetMessage.Advanced.niceToString()} size="xs">
                    <div className="row">
                        <div className="col-sm-3 pt-3">
                            <NumberLine ctx={ctxBasic.subCtx(cp => cp.dashboardPriority)} />
                            <AutoLine ctx={ctxBasic.subCtx(cp => cp.autoRefreshPeriod)} />
                        </div>
                        <div className="col-sm-3 pt-3">
                            <TextBoxLine ctx={ctxBasic.subCtx(cp => cp.key)} />
                        </div>
                    </div>
                </CollapsableCard>
            </div>

            <Tabs id={ctxBasic.getUniqueId("tabs")} className="mt-3">
                <Tab title={ctxBasic.niceName(a => a.parts)} eventKey="parts">
                    <CheckboxLine ctx={ctxBasic.subCtx(cp => cp.combineSimilarRows)} inlineCheckbox={true} />
                    <div className="sf-dashboard-admin">
                        <EntityGridRepeater ctx={ctx.subCtx(cp => cp.parts)} getComponent={renderPart} onCreate={handleOnCreate} />
                    </div>
                </Tab>
                <Tab title={ctxBasic.niceName(a => a.tokenEquivalencesGroups)} eventKey="equivalences">
                    <EntityRepeater ctx={ctx.subCtx(a => a.tokenEquivalencesGroups, { formSize: "xs" })} avoidFieldSet getComponent={ctxGr =>
                        <div>
                            <EnumLine ctx={ctxGr.subCtx(pp => pp.interactionGroup)}
                                onRenderDropDownListItem={io => <span className="sf-dot-container">
                                    {/* altea enums are int-FK ORDINALS, so the option value IS the colour index
                                        (Signum looked the member name up in InteractionGroup.values()). */}
                                    <span className="sf-dot" style={{ backgroundColor: interactionColors[io.value as number] }} />
                                    {io.label}
                                </span>} />
                            <EntityTable ctx={ctxGr.subCtx(pp => pp.tokenEquivalences)} avoidFieldSet columns={[
                                {
                                    property: te => te.query,
                                    template: (ectx, row) => <EntityCombo ctx={ectx.subCtx(te => te.query)} onChange={row.forceUpdate} />,
                                    headerHtmlAttributes: { style: { width: "30%" } },
                                },
                                {
                                    property: te => te.token,
                                    template: ectx => ectx.value.query && <QueryTokenEmbeddedBuilder ctx={ectx.subCtx(te => te.token)}
                                        queryKey={ectx.value.query.key}
                                        subTokenOptions={SubTokensOptions.CanAggregate | SubTokensOptions.CanElement | SubTokensOptions.CanAnyAll} />,
                                    headerHtmlAttributes: { style: { width: "100%" } },
                                },
                            ]} />
                            {allQueryKeys.length > 0 &&
                                <span className="text-muted small">{allQueryKeys.join(", ")}</span>}
                        </div>
                    } />
                </Tab>
            </Tabs>
        </div>
    );

    function selectIcon(iconCtx: TypeContext<DashboardEntity | DashboardEntity_Parts>): Promise<DashboardEntity | DashboardEntity_Parts | undefined> {
        return Navigator.view(iconCtx.value, {
            propertyRoute: iconCtx.propertyRoute,
            getViewPromise: () => new ViewPromise(import("./PanelIcon")),
            modalSize: "md",
            buttons: "ok_cancel",
            isOperationVisible: () => false,
            requiresSaveOperation: false,
        });
    }
}

// (Signum's IsQueryCachedLine has no altea counterpart: CachedQuery is deferred, so no part carries an
// `isQueryCached` flag.)

export function DashboardPart(p: {
    tc: TypeContext<DashboardEntity_Parts>;
    dashboard: DashboardEntity;
} & Pick<EntityGridItemProps, "onResizerDragStart" | "onTitleDragStart" | "onTitleDragEnd" | "onRemove">): React.JSX.Element {

    const forceUpdate = useForceUpdate();

    const tc = p.tc;
    const tcs = tc.subCtx({ formGroupStyle: "SrOnly", formSize: "xs", placeholderLabels: true });

    const icon = parseIcon(tc.value.iconName) ?? "border-none";

    const avoidDrag: React.HTMLAttributes<any> = {
        draggable: true,
        onDragStart: e => {
            e.preventDefault();
            e.stopPropagation();
        },
    };

    function handleSettingsClick(e: React.MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();

        Navigator.view(tc.value, {
            propertyRoute: tc.propertyRoute,
            getViewPromise: () => new ViewPromise(import("./PanelPart")),
            modalSize: "lg",
            buttons: "ok_cancel",
            isOperationVisible: () => false,
            requiresSaveOperation: false,
        }).then(result => {
            if (result) {
                // Copy the chrome properties the modal edited back onto the grid cell (Signum did the same:
                // the modal edits a copy of the part row).
                tc.value.iconName = result.iconName;
                tc.value.iconColor = result.iconColor;
                tc.value.titleColor = result.titleColor;
                tc.value.customColor = result.customColor;
                tc.value.interactionGroup = result.interactionGroup;
                tc.value.tooltip = result.tooltip;
                forceUpdate();
            }
        });
    }

    function renderTitle(smallMode: boolean): React.JSX.Element {
        const hideTitleCheckbox = (
            <CheckboxLine ctx={tcs.subCtx(pp => pp.hideTitle)} inlineCheckbox onChange={() => forceUpdate()}
                labelHtmlAttributes={{ style: { whiteSpace: "nowrap" } }} />
        );

        return (
            <div>
                <div className="d-flex">
                    {icon && <div className="mx-2">
                        <button type="button" style={{ background: "none", border: "none", padding: 0 }}
                            aria-label={DashboardMessage.SelectIcon.niceToString()}
                            onClick={handleSettingsClick}>
                            <FontAwesomeIcon aria-hidden={true} icon={fallbackIcon(icon)}
                                style={{ color: tc.value.iconColor ?? undefined, fontSize: "25px" }} {...avoidDrag as any} />
                        </button>
                    </div>}
                    <div style={{ flexGrow: 1 }} className="me-2">
                        {(smallMode || !tc.value.hideTitle) &&
                            <TextBoxLine ctx={tcs.subCtx(pp => pp.title)}
                                label={tc.value.content?.toString() ?? tcs.niceName(pp => pp.title)}
                                valueHtmlAttributes={avoidDrag}
                                helpText={smallMode ? hideTitleCheckbox : undefined} />}
                        {tc.value.interactionGroup != null && (
                            <div className="mt-1">
                                <span className="badge" style={{ backgroundColor: interactionColors[tc.value.interactionGroup as number] }}>
                                    {Enum.niceName(InteractionGroupEnum, tc.value.interactionGroup)}
                                </span>
                            </div>
                        )}
                    </div>
                    {!smallMode &&
                        <div className="me-2">
                            {hideTitleCheckbox}
                        </div>}
                </div>
            </div>
        );
    }

    return (
        <EntityGridItem title={renderTitle} customColor={tc.value.customColor ?? undefined}
            sizeDeps={[tc.value.columns, tc.value.startColumn, tc.value.row]}
            onResizerDragStart={p.onResizerDragStart}
            onTitleDragStart={p.onTitleDragStart}
            onTitleDragEnd={p.onTitleDragEnd}
            onRemove={p.onRemove}>
            {smallMode => <RenderEntity ctx={tc.subCtx(a => a.content)} extraProps={{ dashboard: p.dashboard, smallMode }} />}
        </EntityGridItem>
    );
}

