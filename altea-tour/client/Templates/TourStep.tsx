import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import MarkdownCodeMirror from "@altea/altea-codemirror/client/MarkdownCodeMirror";
import { DashboardEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import {
    TourStepEntity, CssStepEmbedded, CssStepType, PopoverAlign, PopoverSide, TourMessage, cssStepSelector,
} from "../../data/Tour";
import PropertyRouteCombo from "../PropertyRouteCombo";

// Port of Signum.Tour's Templates/TourStep.tsx — one step: its title, the CSS steps that AND into its
// anchor selector, where the popover sits, and its markdown body.
//
// altea divergences:
//  - `MarkdownLine` (Signum.Markdown, unported) → @altea/altea-codemirror's `MarkdownCodeMirror`, which is
//    what that package ships in its place.
//  - the "Property" step binds a route STRING through a local `PropertyRouteCombo` (altea has no
//    PropertyRouteEntity and no framework combo — see ../PropertyRouteCombo).
//  - the live selector preview calls the SAME `cssStepSelector` the server uses to build the DTO (it lives
//    in the data layer for exactly this reason), so the preview cannot drift from what the player gets.
//  - `Finder.getQueryDescription` is gone (altea has no QueryDescription): the user query's own stored
//    columns are the choices, which is what a tour step can actually point at anyway.

export default function TourStep(p: {
    ctx: TypeContext<TourStepEntity>;
    invalidate: () => void;
    rootTypeName?: string | null;
    dashboard?: DashboardEntity | null;
    userQuery?: UserQueryEntity | null;
}): React.JSX.Element {
    const ctx = p.ctx;
    const sc = ctx.subCtx({ labelColumns: 2 });
    const sc4 = ctx.subCtx({ labelColumns: 4 });
    const forceUpdate = useForceUpdate();

    // Signum's handleSideChange: a top/bottom popover centres, a left/right one starts.
    function handleSideChange(): void {
        const side = ctx.value.side;
        if (side === PopoverSide.Top || side === PopoverSide.Bottom)
            ctx.value.align = PopoverAlign.Center;
        else if (side === PopoverSide.Left || side === PopoverSide.Right)
            ctx.value.align = PopoverAlign.Start;
        forceUpdate();
        p.invalidate();
    }

    // The three anchor sources are mutually exclusive (the trigger picked one); ToolbarContent always last.
    function availableCssStepTypes(): CssStepType[] {
        if (p.userQuery != null)
            return [CssStepType.TableColumn, CssStepType.CSSSelector, CssStepType.ToolbarContent];
        if (p.dashboard != null)
            return [CssStepType.DashboardPart, CssStepType.CSSSelector, CssStepType.ToolbarContent];
        if (p.rootTypeName != null)
            return [CssStepType.Property, CssStepType.CSSSelector, CssStepType.ToolbarContent];
        return [CssStepType.CSSSelector, CssStepType.ToolbarContent];
    }

    const dashboardPartOptions = React.useMemo(() =>
        (p.dashboard?.parts ?? []).map(pp => ({
            key: String(pp.id),
            label: pp.title || pp.content?.toString() || String(pp.id),
        })), [p.dashboard]);

    const tableColumnOptions = React.useMemo(() =>
        (p.userQuery?.columns ?? [])
            .filter(c => !c.hiddenColumn && c.token?.tokenString)
            .map(c => ({ key: c.token!.tokenString, label: c.displayName || c.token!.tokenString })),
        [p.userQuery]);

    return (
        <div>
            <AutoLine ctx={sc.subCtx(a => a.title)} onChange={p.invalidate} />
            <div className="mt-3">
                <FormGroup ctx={ctx} label={TourMessage.FinalCSSSelector.niceToString()}>
                    {id => <>
                        <div className="mb-2">
                            <code id={id}>{ctx.value.cssSteps
                                .map(s => cssStepSelector(s, lite => lite.toString()))
                                .filter(s => s != null)
                                .join(" ")}</code>
                        </div>
                        <EntityTable ctx={sc.subCtx(a => a.cssSteps)} avoidFieldSet onChange={forceUpdate} columns={[
                            {
                                property: a => a.type,
                                template: (cctx, row) => <EnumLine ctx={cctx.subCtx(a => a.type)} onChange={() => {
                                    // Exactly one field is set per step (the PropertyValidation in data/Tour),
                                    // so switching the discriminator clears the others.
                                    cctx.value.cssSelector = null;
                                    cctx.value.property = null;
                                    cctx.value.toolbarContent = null;
                                    cctx.value.dashboardPart = null;
                                    cctx.value.tableColumn = null;
                                    row.forceUpdate();
                                }} optionItems={availableCssStepTypes()} />,
                                headerHtmlAttributes: { style: { width: "20%" } },
                            },
                            {
                                header: TourMessage.CssStep.niceToString(),
                                template: cctx => renderCssStep(cctx),
                                headerHtmlAttributes: { style: { width: "80%" } },
                            },
                        ]} />
                    </>}
                </FormGroup>
            </div>

            <div className="row mt-4 mb-2">
                <div className="col-sm-10 offset-sm-2">
                    <div className="row">
                        <div className="col-sm-4">
                            <AutoLine ctx={sc4.subCtx(a => a.side)} onChange={handleSideChange} mandatory />
                        </div>
                        <div className="col-sm-4">
                            <AutoLine ctx={sc4.subCtx(a => a.align)} />
                        </div>
                        <div className="col-sm-4">
                            <EnumLine ctx={sc4.subCtx(a => a.click)} onChange={forceUpdate} />
                        </div>
                    </div>
                </div>
            </div>

            <FormGroup ctx={sc.subCtx(a => a.description)}>
                {() => <MarkdownCodeMirror ctx={sc.subCtx(a => a.description)} onChange={forceUpdate} />}
            </FormGroup>
        </div>
    );

    function renderCssStep(cctx: TypeContext<CssStepEmbedded>): React.JSX.Element | null {
        switch (cctx.value.type) {
            case CssStepType.CSSSelector:
                return <TextBoxLine ctx={cctx.subCtx(a => a.cssSelector)} onChange={forceUpdate}
                    valueHtmlAttributes={{ className: "font-monospace", placeholder: "#someId div.some-class" }} />;

            case CssStepType.Property:
                return p.rootTypeName == null ? null
                    : <PropertyRouteCombo ctx={cctx.subCtx(a => a.property)} rootTypeName={p.rootTypeName} onChange={forceUpdate} />;

            case CssStepType.ToolbarContent:
                return <EntityLine ctx={cctx.subCtx(a => a.toolbarContent)} onChange={forceUpdate} create={false} />;

            case CssStepType.DashboardPart:
                return <OptionSelect value={cctx.value.dashboardPart} options={dashboardPartOptions}
                    readOnly={cctx.readOnly}
                    onChange={v => { cctx.value.dashboardPart = v; forceUpdate(); }} />;

            case CssStepType.TableColumn:
                return <OptionSelect value={cctx.value.tableColumn} options={tableColumnOptions}
                    readOnly={cctx.readOnly}
                    onChange={v => { cctx.value.tableColumn = v; forceUpdate(); }} />;

            default:
                return null;
        }
    }
}

function OptionSelect(p: {
    value: string | null;
    options: { key: string; label: string }[];
    readOnly?: boolean;
    onChange: (value: string | null) => void;
}): React.JSX.Element {
    return (
        <select className="form-select form-select-sm" value={p.value ?? ""} disabled={p.readOnly}
            onChange={e => p.onChange(e.currentTarget.value === "" ? null : e.currentTarget.value)}>
            <option value="">-</option>
            {p.options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
    );
}
