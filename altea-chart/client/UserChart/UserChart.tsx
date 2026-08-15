import * as React from "react";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { getQueryNiceName } from "@altea/altea/client/Reflection";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { UserQueryMessage } from "@altea/altea-user-queries/data/UserQuery";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-queries/client/Templates/QueryTokenEmbeddedBuilder";
import { ChartClient } from "../ChartClient";
import { ChartMessage } from "../../data/ChartMessage";
import { UserChartEntity } from "../../data/UserChart";

// Port of Signum's Signum.Chart/UserChart/UserChart.tsx (the UserChart editor). This first cut covers owner /
// display name / query / chart script / entity-type quick-link scope / includeDefaultFilters / maxRows, and
// the column + parameter bindings (as EntityTables). Mirrors UserQuery.tsx's structure.
//
// altea divergences (documented): the interactive CHART BUILDER (Signum's <ChartBuilder> — chart-type
// picker, per-column chart-slot UI, live redraw) and the interactive FILTERS editor (FilterBuilderEmbedded,
// which in altea is bound to UserQuery's own filter-row class) are DEFERRED — they depend on the chart-host
// infrastructure (ChartRequestView "handle" / ButtonBarChart) not yet ported to altea-chart. Columns bind
// their query token via QueryTokenEmbeddedBuilder (reused from altea-user-queries).
export default function UserChart(p: { ctx: TypeContext<UserChartEntity> }): React.JSX.Element | null {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const query = ctx.value.query;
    const ctxxs = ctx.subCtx({ formSize: "xs" });

    const canTimeSeries = ctx.value.chartTimeSeries != null ? SubTokensOptions.CanTimeSeries : 0;
    const columnSubTokens = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate | canTimeSeries;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(e => e.owner)} />
            <AutoLine ctx={ctx.subCtx(e => e.displayName)} />
            <FormGroup ctx={ctx.subCtx(e => e.query)}>
                {() => query && <span className="form-control-static">{getQueryNiceName(query.key)}</span>}
            </FormGroup>
            <FormGroup ctx={ctx.subCtx(e => e.chartScript)}>
                {() => <span className="form-control-static">{ctx.value.chartScript ? ChartClient.symbolNiceName(ctx.value.chartScript) : ""}</span>}
            </FormGroup>

            <EntityLine ctx={ctx.subCtx(e => e.entityType)} onChange={() => forceUpdate()}
                helpText={UserQueryMessage.MakesThe0AvailableAsAQuickLinkOf1.niceToString(
                    UserChartEntity.niceName(),
                    ctx.value.entityType ? ctx.value.entityType.toString() : UserQueryMessage.TheSelected0.niceToString(ctx.niceName(a => a.entityType)))} />

            {ctx.value.entityType != null &&
                <CheckboxLine ctx={ctx.subCtx(e => e.hideQuickLink)} inlineCheckbox />}

            <AutoLine ctx={ctxxs.subCtx(e => e.includeDefaultFilters)} />
            <AutoLine ctx={ctxxs.subCtx(e => e.maxRows)} />

            <div className="my-2">
                <h2 className="h4">{ctx.niceName(a => a.columns)}</h2>
                <div className="ms-3">
                    <EntityTable ctx={ctxxs.subCtx(e => e.columns)} columns={[
                        {
                            header: ChartMessage.ChartToken.niceToString(),
                            template: cctx =>
                                <QueryTokenEmbeddedBuilder
                                    ctx={cctx.subCtx(a => a.element).subCtx(x => x.token, { formGroupStyle: "SrOnly" })}
                                    queryKey={query.key}
                                    subTokenOptions={columnSubTokens}
                                    onTokenChanged={() => forceUpdate()} />,
                        },
                        {
                            header: ChartMessage.Data.niceToString(),
                            template: cctx => <AutoLine ctx={cctx.subCtx(a => a.element).subCtx(x => x.displayName, { formGroupStyle: "SrOnly" })} />,
                        },
                    ]} />
                </div>
            </div>

            <div className="my-2">
                <h2 className="h4">{ctx.niceName(a => a.parameters)}</h2>
                <div className="ms-3">
                    <EntityTable ctx={ctxxs.subCtx(e => e.parameters)} columns={[
                        {
                            header: "Name",
                            template: pctx => <AutoLine ctx={pctx.subCtx(a => a.element).subCtx(x => x.name, { formGroupStyle: "SrOnly" })} />,
                        },
                        {
                            header: "Value",
                            template: pctx => <AutoLine ctx={pctx.subCtx(a => a.element).subCtx(x => x.value, { formGroupStyle: "SrOnly" })} />,
                        },
                    ]} />
                </div>
            </div>
        </div>
    );
}
