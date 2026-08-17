import * as React from "react";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { Finder } from "@altea/altea/client/Finder";
import { getQueryNiceName } from "@altea/altea/client/Reflection";
import { useForceUpdate, useAPI } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { toInt } from "@altea/altea/data/basics";
import CollapsableCard from "@altea/altea/client/Components/CollapsableCard";
import { UserAssetMessage } from "@altea/altea-user-assets/data/UserAssets";
import { UserQueryMessage } from "@altea/altea-user-queries/data/UserQuery";
import { ChartClient } from "../ChartClient";
import { ChartRequestModel } from "../../data/ChartRequest";
import type { IChartBase } from "../../data/ChartRequest";
import {
    UserChartEntity, UserChartColumnEmbedded, UserChartParameterEmbedded,
} from "../../data/UserChart";
import ChartBuilder from "../Templates/ChartBuilder";

// Port of Signum's Signum.Chart/UserChart/UserChart.tsx (the UserChart editor). Signum's UserChartEntity IS
// an IChartBase, so it hands itself straight to <ChartBuilder>. altea's UserChartEntity CANNOT be an
// IChartBase (its columns/parameters are per-owner @part rows wrapping the shared value objects on an
// `element` field — see data/UserChart.ts). So we build an EDITABLE ChartRequestModel adapter whose
// `columns`/`parameters` are the SAME `.element` object references (field edits therefore reflect straight
// into the @part rows), pass that to ChartBuilder, and write the request's structure (chartScript / maxRows /
// chartTimeSeries + the column/parameter COUNT that ChartBuilder.synchronizeColumns changes) back onto the
// entity's @part rows on every ChartBuilder callback.
//
// Deferred (matching the rest of the altea-chart port): the chart FILTERS editor (Signum's
// FilterBuilderEmbedded is bound to the user-queries QueryFilterEmbedded row class, not UserChartFilterEmbedded)
// and the customDrilldowns / "Used by" sections (no EntityStrip / Toolbar / Dashboard yet) — the Advanced
// card keeps the extension seam.
export default function UserChart(p: { ctx: TypeContext<UserChartEntity> }): React.JSX.Element | null {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const uc = ctx.value;
    // A UserChart is always created FROM a chart (with a query fixed at creation) — but guard the query so the
    // generic "Create new" path (a query-less entity) renders the form instead of crashing.
    const queryKey = uc.query?.key;

    // Built once per mount; ChartBuilder mutates it in place, writeBack() reflects it onto the entity.
    const cr = useAPI(() => uc.query == null ? Promise.resolve(undefined) : buildEditableRequest(uc), []);

    function handleChange(): void {
        if (cr != null)
            writeBack(cr, uc);
        forceUpdate();
    }

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(e => e.owner)} />
            <AutoLine ctx={ctx.subCtx(e => e.displayName)} />
            <FormGroup ctx={ctx.subCtx(e => e.query)}>
                {() => uc.query && <span className="form-control-static">{getQueryNiceName(queryKey!)}</span>}
            </FormGroup>

            <EntityLine ctx={ctx.subCtx(e => e.entityType)} onChange={() => forceUpdate()}
                helpText={
                    <div>
                        {UserQueryMessage.MakesThe0AvailableAsAQuickLinkOf1.niceToString(
                            UserChartEntity.niceName(),
                            uc.entityType ? uc.entityType.toString() : UserQueryMessage.TheSelected0.niceToString(ctx.niceName(a => a.entityType)))}
                        {uc.entityType && <br />}
                        {uc.entityType && <CheckboxLine ctx={ctx.subCtx(e => e.hideQuickLink)} inlineCheckbox />}
                    </div>
                } />

            <div className="row">
                <div className="offset-sm-2 col-sm-10">
                    <CollapsableCard header={UserAssetMessage.Advanced.niceToString()} size="xs">
                        <div className="row mt-2 mb-2">
                            <div className="col-sm-6">
                                <AutoLine ctx={ctx.subCtx(e => e.includeDefaultFilters, { labelColumns: 4 })} />
                                {/* EXTENSION POINT: customDrilldowns (EntityStrip) + "Used by" (Toolbar/Dashboard
                                    SearchValueLines) are deferred until those altea modules land. */}
                            </div>
                        </div>
                    </CollapsableCard>
                </div>
            </div>

            {cr == null ? null :
                <ChartBuilder queryKey={queryKey!} ctx={TypeContext.root(cr) as TypeContext<IChartBase>}
                    onInvalidate={handleChange}
                    onRedraw={handleChange}
                    onTokenChange={handleChange}
                    onOrderChanged={handleChange} />}
        </div>
    );
}

// Build an editable ChartRequestModel over the UserChart: the request's columns/parameters ARE the entity's
// shared `.element` value objects, so ChartBuilder's per-field edits mutate the @part rows directly. Tokens
// are resolved client-side (TokenCompleter) and the columns synchronized against the chart script (as
// Signum's ChartScript setter did).
async function buildEditableRequest(uc: UserChartEntity): Promise<ChartRequestModel> {
    const cr = new ChartRequestModel();
    cr.queryKey = uc.query.key;
    cr.chartScript = uc.chartScript;
    cr.maxRows = uc.maxRows;
    cr.chartTimeSeries = uc.chartTimeSeries; // shared — ChartBuilder's time-machine toggle edits it in place
    cr.filterOptions = []; // ChartBuilder does not touch filters (the chart filters editor is deferred)

    const canTimeSeries = uc.chartTimeSeries != null ? SubTokensOptions.CanTimeSeries : 0;
    const colOptions = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate | canTimeSeries;

    const rootToken = await Finder.getQueryRoot(uc.query.key);
    const completer = new Finder.TokenCompleter(rootToken);
    for (const c of uc.columns ?? [])
        if (c.element.token?.tokenString) completer.request(c.element.token.tokenString);
    await completer.finished();
    for (const c of uc.columns ?? []) {
        const te = c.element.token;
        if (te?.tokenString && te.token == null)
            te.token = completer.get(te.tokenString, colOptions);
    }

    cr.columns = (uc.columns ?? []).map(c => c.element);
    cr.parameters = (uc.parameters ?? []).map(p => p.element);

    const cs = await ChartClient.getChartScript(cr.chartScript);
    ChartClient.synchronizeColumns(cr, cs);
    return cr;
}

// Reflect the request's structure back onto the entity's @part rows. Field edits already landed (shared
// `.element` refs); this captures the scalar fields and any column/parameter the ChartScript synchronization
// added or removed, re-using the existing @part row for an unchanged element so its id/order are preserved.
function writeBack(cr: ChartRequestModel, uc: UserChartEntity): void {
    uc.chartScript = cr.chartScript;
    uc.maxRows = cr.maxRows;
    uc.chartTimeSeries = cr.chartTimeSeries;

    uc.columns = cr.columns.map((el, i) => {
        const row = uc.columns.find(c => c.element === el) ?? new UserChartColumnEmbedded();
        row.element = el;
        row.order = toInt(i);
        return row;
    });
    uc.parameters = cr.parameters.map((el, i) => {
        const row = uc.parameters.find(pr => pr.element === el) ?? new UserChartParameterEmbedded();
        row.element = el;
        row.order = toInt(i);
        return row;
    });
}
