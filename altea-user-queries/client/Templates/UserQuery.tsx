import * as React from "react";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { NumberLine } from "@altea/altea/client/Lines/NumberLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import { Finder } from "@altea/altea/client/Finder";
import { getQueryNiceName } from "@altea/altea/client/Reflection";
import { useForceUpdate, useAPI } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { SearchMessage } from "@altea/altea/data/uiMessages";
import { Enum } from "@altea/altea/data/enum";
import { toInt } from "@altea/altea/data/basics";
import {
    FilterOperationEnum, SystemTimeModeEnum, SystemTimeJoinModeEnum, TimeSeriesUnitEnum,
} from "@altea/altea/data/dynamicQueries";
import CollapsableCard from "@altea/altea/client/Components/CollapsableCard";
import { UserAssetMessage } from "@altea/altea-user-assets/data/UserAssets";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import {
    UserQueryEntity, UserQueryMessage, SystemTimeEmbedded, HealthCheckConditionEmbedded,
} from "../../data/UserQuery";
import { UserQueriesClient } from "../UserQueriesClient";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import { FilterBuilderEmbedded } from "./FilterBuilderEmbedded";

// Port of Signum's Signum.UserQueries/Templates/UserQuery.tsx (the UserQuery editor). Follows Signum's
// layout: an "Advanced" CollapsableCard, group-results, then the Filters / Columns / Orders / Pagination /
// SystemTime / HealthCheck sections. altea divergences (documented inline):
//  - Signum's Finder.getQueryDescription is gone — altea resolves tokens client-side; the "has system time"
//    gate reads the query root's TypeInfos (Finder.getQueryRoot) instead of qd.columns["Entity"].
//  - The DynamicQuery enum fields are now REAL altea enums (int-FK, translatable) — AutoLine auto-dispatches
//    to a localized EnumLine, so the explicit `optionItems={Enum.values(...)}` props are gone. In-memory the
//    value is the numeric ordinal, so comparisons against a member name go through Enum.toName.
//  - The Advanced card keeps EXTENSION POINTS for the deferred Dashboard / Toolbar modules: the "Used by"
//    SearchValueLines and the customDrilldowns EntityStrip are stubbed until those packages land (altea has
//    no ToolbarEntity / DashboardEntity / EntityStrip yet).
//  - altea-only "Show preview" toggle (default OFF): renders a live read-only SearchControl of the query as
//    it is being edited — a convenience the Signum editor does not have.

const CurrentEntityKey = "[CurrentEntity]";

export default function UserQuery(p: { ctx: TypeContext<UserQueryEntity> }): React.JSX.Element | null {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const query = ctx.value.query;
    const ctx4 = ctx.subCtx({ labelColumns: 4 });
    const ctxxs = ctx.subCtx({ formSize: "xs" });

    const [showPreview, setShowPreview] = React.useState(false);

    const canAggregate = ctx.value.groupResults ? SubTokensOptions.CanAggregate : 0;
    const systemTimeMode = ctx.value.systemTime == null ? undefined : Enum.toName(SystemTimeModeEnum, ctx.value.systemTime.mode);
    const canTimeSeries = systemTimeMode === "TimeSeries" ? SubTokensOptions.CanTimeSeries : 0;

    // Whether to offer the system-time section. Signum shows it for ANY entity query (getTypeInfos truthy) and
    // lets server validation reject a system-time request on a non-versioned table — mirror that (rather than
    // the ChartBuilder's stricter systemVersioned-only gate), so the option is available on entity queries.
    const qs = Finder.getSettings(query.key);
    const queryRoot = useAPI(() => Finder.getQueryRoot(query.key), [query.key]);
    const hasSystemTime = qs?.allowSystemTime ?? ((queryRoot?.type.typeInfos().length ?? 0) > 0);

    const columnSubTokens = SubTokensOptions.CanElement | SubTokensOptions.CanToArray | SubTokensOptions.CanSnippet
        | (canAggregate ? canAggregate : SubTokensOptions.CanOperation | SubTokensOptions.CanManual) | canTimeSeries;
    const orderSubTokens = SubTokensOptions.CanElement | SubTokensOptions.CanSnippet | canAggregate | canTimeSeries;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(e => e.displayName)} />
            <EntityLine ctx={ctx.subCtx(e => e.owner)} />
            <FormGroup ctx={ctx.subCtx(e => e.query)}>
                {() => query && <span className="form-control-static">{getQueryNiceName(query.key)}</span>}
            </FormGroup>

            <EntityLine ctx={ctx.subCtx(e => e.entityType)} readOnly={ctx.value.appendFilters || undefined} onChange={() => forceUpdate()}
                helpText={
                    <div>
                        {UserQueryMessage.MakesThe0AvailableAsAQuickLinkOf1.niceToString(
                            UserQueryEntity.niceName(),
                            ctx.value.entityType ? ctx.value.entityType.toString() : UserQueryMessage.TheSelected0.niceToString(ctx.niceName(a => a.entityType)))}
                        {ctx.value.entityType && <br />}
                        {ctx.value.entityType && <span>{UserQueryMessage.Use0ToFilterCurrentEntity.niceToString("")}<code style={{ display: "inline" }}><strong>{CurrentEntityKey}</strong></code></span>}
                        {ctx.value.entityType && <div className="d-flex gap-3">
                            <CheckboxLine ctx={ctx.subCtx(e => e.hideQuickLink)} inlineCheckbox />
                            <CheckboxLine ctx={ctx.subCtx(e => e.showTitleAsBreadcrumb)} inlineCheckbox />
                        </div>}
                    </div>
                } />

            <div className="row">
                <div className="offset-sm-2 col-sm-10">
                    <CollapsableCard header={UserAssetMessage.Advanced.niceToString()} size="xs">
                        <div className="row mt-2 mb-2">
                            <div className="col-sm-6">
                                <AutoLine ctx={ctx4.subCtx(e => e.appendFilters)} readOnly={ctx.value.entityType != null || undefined} onChange={() => forceUpdate()}
                                    helpText={UserQueryMessage.MakesThe0AvailableForCustomDrilldownsAndInContextualMenuWhenGrouping0.niceToString(UserQueryEntity.niceName(), query?.key)} />
                                <AutoLine ctx={ctx4.subCtx(e => e.refreshMode)} />
                                {/* EXTENSION POINT: customDrilldowns (Signum's EntityStrip) is deferred — altea
                                    has no EntityStrip yet, and CustomDrilldowns targets other UserQueries. */}
                            </div>
                            <div className="col-sm-6">
                                {/* EXTENSION POINT: "Used by" (Signum's Toolbar / ToolbarMenu / Dashboard
                                    SearchValueLines) is deferred until the Toolbar & Dashboard modules land. */}
                            </div>
                        </div>
                    </CollapsableCard>
                </div>
            </div>

            <h2 className="d-inline-block h4">
                <CheckboxLine ctx={ctx4.subCtx(e => e.groupResults)} onChange={() => forceUpdate()} inlineCheckbox="block" formSize="lg" />
            </h2>

            <div className="my-2">
                <h2 className="h4">{ctx.niceName(a => a.filters)}</h2>
                <div className="ms-3">
                    <AutoLine ctx={ctxxs.subCtx(e => e.includeDefaultFilters)} valueColumns={4} />
                    {/* altea divergence: a "Show preview" toggle (default OFF) that runs the query-so-far. */}
                    <label className="d-flex align-items-center gap-2 mb-2" style={{ cursor: "pointer" }}>
                        <input type="checkbox" className="form-check-input mt-0" checked={showPreview} onChange={() => setShowPreview(!showPreview)} />
                        {UserQueryMessage.Preview.niceToString()}
                    </label>
                    <FilterBuilderEmbedded ctx={ctxxs.subCtx(e => e.filters)}
                        avoidFieldSet
                        subTokenOptions={SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | canAggregate | canTimeSeries}
                        queryKey={query.key}
                        showPinnedFilterOptions={true} />
                    {showPreview && <FilterPreview uq={ctx.value} />}
                </div>
            </div>

            <div className="my-2">
                <h2 className="h4">{ctx.niceName(a => a.columns)}</h2>
                <div className="ms-3">
                    <AutoLine ctx={ctxxs.subCtx(e => e.columnsMode)} valueColumns={4} />
                    <EntityTable ctx={ctxxs.subCtx(e => e.columns)} avoidFieldSet columns={[
                        {
                            property: a => a.token,
                            template: (cctx, row) =>
                                <div>
                                    <QueryTokenEmbeddedBuilder
                                        ctx={cctx.subCtx(a => a.token, { formGroupStyle: "SrOnly" })}
                                        queryKey={query.key}
                                        onTokenChanged={() => { cctx.value.summaryToken = null; row.forceUpdate(); }}
                                        subTokenOptions={columnSubTokens} />
                                    <div className="d-flex">
                                        <label className="col-form-label col-form-label-xs me-2" style={{ minWidth: "140px" }}>
                                            <input type="checkbox" className="form-check-input" disabled={cctx.value.token == null || cctx.readOnly}
                                                checked={cctx.value.summaryToken != null}
                                                onChange={() => { cctx.value.summaryToken = cctx.value.summaryToken == null ? seedSummaryToken(cctx.value.token) : null; row.forceUpdate(); }} />
                                            {" "}{SearchMessage.SummaryHeader.niceToString()}
                                        </label>
                                        <div className="flex-grow-1">
                                            {cctx.value.summaryToken &&
                                                <QueryTokenEmbeddedBuilder
                                                    ctx={cctx.subCtx(a => a.summaryToken, { formGroupStyle: "SrOnly" })}
                                                    queryKey={query.key}
                                                    subTokenOptions={SubTokensOptions.CanElement | SubTokensOptions.CanAggregate} />}
                                        </div>
                                    </div>
                                </div>,
                        },
                        {
                            property: a => a.displayName,
                            template: (cctx, row) =>
                                <TextBoxLine ctx={cctx.subCtx(a => a.displayName)} readOnly={cctx.value.hiddenColumn || undefined}
                                    valueHtmlAttributes={{ placeholder: cctx.value.token?.tokenString }}
                                    helpText={
                                        <div>
                                            <AutoLine ctx={cctx.subCtx(a => a.combineRows)} readOnly={cctx.value.hiddenColumn || undefined} />
                                            <CheckboxLine ctx={cctx.subCtx(a => a.hiddenColumn)} inlineCheckbox="block"
                                                onChange={() => { cctx.value.summaryToken = null; cctx.value.displayName = null; cctx.value.combineRows = null; row.forceUpdate(); }} />
                                        </div>
                                    } />,
                        },
                    ]} />
                </div>
            </div>

            <div className="my-2">
                <h2 className="h4">{ctx.niceName(a => a.orders)}</h2>
                <div className="ms-3">
                    <EntityTable ctx={ctxxs.subCtx(e => e.orders)} avoidFieldSet columns={[
                        {
                            property: a => a.token,
                            template: octx =>
                                <QueryTokenEmbeddedBuilder
                                    ctx={octx.subCtx(a => a.token, { formGroupStyle: "SrOnly" })}
                                    queryKey={query.key}
                                    subTokenOptions={orderSubTokens} />,
                        },
                        { property: a => a.orderType },
                    ]} />
                </div>
            </div>

            <div className="my-4">
                <h3 className="h5">{UserQueryMessage.Pagination.niceToString()}</h3>
                <div className="ms-3 row">
                    <div className="col-sm-6"><AutoLine ctx={ctxxs.subCtx(e => e.paginationMode, { labelColumns: { sm: 4 } })} formGroupStyle="Basic" /></div>
                    <div className="col-sm-6"><AutoLine ctx={ctxxs.subCtx(e => e.elementsPerPage, { labelColumns: { sm: 4 } })} formGroupStyle="Basic" /></div>
                </div>
            </div>

            {(hasSystemTime || ctx.value.systemTime) &&
                <EntityDetail ctx={ctx.subCtx(a => a.systemTime)} avoidFieldSet="h5" onChange={() => forceUpdate()}
                    getComponent={stc => <SystemTime ctx={stc} />} />}

            <EntityDetail ctx={ctx.subCtx(a => a.healthCheck)} avoidFieldSet="h5"
                onChange={() => forceUpdate()}
                getComponent={hcctx =>
                    <div>
                        <HealthCondition ctx={hcctx.subCtx(a => a.failWhen)} color="var(--bs-danger-bg-subtle)" queryNiceName={getQueryNiceName(query.key)} />
                        <HealthCondition ctx={hcctx.subCtx(a => a.degradedWhen)} color="var(--bs-warning-bg-subtle)" queryNiceName={getQueryNiceName(query.key)} />
                    </div>} />
        </div>
    );
}

// Seed a summary (aggregate) token from the column's own token — Signum's QueryTokenEmbedded.New(token).
function seedSummaryToken(columnToken: QueryTokenEmbedded | null): QueryTokenEmbedded {
    const t = new QueryTokenEmbedded();
    t.tokenString = columnToken?.tokenString ?? "";
    t.token = columnToken?.token ?? null;
    return t;
}

// altea-only live preview: run the query as edited so far in a read-only SearchControl.
function FilterPreview(p: { uq: UserQueryEntity }): React.JSX.Element | null {
    const fo = useAPI(() => UserQueriesClient.Converter.toFindOptions(p.uq, undefined).catch(() => undefined), []);
    if (!fo)
        return null;
    return (
        <div className="border rounded p-2 my-2">
            <SearchControl findOptions={fo} tag="UserQueryPreview" searchOnLoad={true}
                avoidChangeUrl={true} hideFullScreenButton={true} showBarExtension={false} />
        </div>
    );
}

function SystemTime(p: { ctx: TypeContext<SystemTimeEmbedded> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx.subCtx({ formSize: "xs", formGroupStyle: "Basic" });
    const mode = Enum.toName(SystemTimeModeEnum, ctx.value.mode);
    return (
        <div>
            <div className="row">
                <div className="col-sm-3">
                    <AutoLine ctx={ctx.subCtx(e => e.mode)} onChange={() => {
                        const m = Enum.toName(SystemTimeModeEnum, ctx.value.mode);
                        ctx.value.startDate = m === "All" ? null : ctx.value.startDate;
                        ctx.value.endDate = (m === "All" || m === "AsOf") ? null : ctx.value.endDate;
                        ctx.value.joinMode = m === "AsOf" ? null : (ctx.value.joinMode ?? Enum.toValue(SystemTimeJoinModeEnum, "FirstCompatible"));
                        ctx.value.timeSeriesStep = m === "TimeSeries" ? toInt(1) : null;
                        ctx.value.timeSeriesUnit = m === "TimeSeries" ? Enum.toValue(TimeSeriesUnitEnum, "Day") : null;
                        ctx.value.timeSeriesMaxRowsPerStep = m === "TimeSeries" ? toInt(10) : null;
                        ctx.value.splitQueries = false;
                        forceUpdate();
                    }} />
                </div>
                <div className="col-sm-3">
                    {mode === "All" ? null : <AutoLine ctx={ctx.subCtx(e => e.startDate)} label={mode === "AsOf" ? UserQueryMessage.Date.niceToString() : undefined} mandatory />}
                </div>
                <div className="col-sm-3">
                    {(mode === "All" || mode === "AsOf") ? null : <AutoLine ctx={ctx.subCtx(e => e.endDate)} mandatory />}
                </div>
                <div className="col-sm-3">
                    {(mode === "AsOf" || mode === "TimeSeries") ? null : <AutoLine ctx={ctx.subCtx(e => e.joinMode)} mandatory />}
                </div>
            </div>
            {mode === "TimeSeries" &&
                <div className="row">
                    <div className="col-sm-3"><AutoLine ctx={ctx.subCtx(e => e.timeSeriesStep)} mandatory /></div>
                    <div className="col-sm-3"><AutoLine ctx={ctx.subCtx(e => e.timeSeriesUnit)} mandatory /></div>
                    <div className="col-sm-3"><AutoLine ctx={ctx.subCtx(e => e.timeSeriesMaxRowsPerStep)} mandatory /></div>
                </div>}
        </div>
    );
}

// Signum's HealthCondition: a "{count} {op} {value}" threshold with an enable checkbox. altea has no
// message.formatHtml, so the label is composed as plain JSX; the operation is a real FilterOperation enum.
function HealthCondition(p: { ctx: TypeContext<HealthCheckConditionEmbedded | null>, color: string, queryNiceName: string }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx.subCtx({ formGroupStyle: "None", formSize: "xs" }) as TypeContext<HealthCheckConditionEmbedded>;
    return (
        <label className="d-flex flex-row align-items-center gap-2">
            <input type="checkbox" checked={p.ctx.value != null} className="form-check-input me-2"
                onChange={() => { p.ctx.value = p.ctx.value == null ? new HealthCheckConditionEmbedded() : null; forceUpdate(); }} />
            {p.ctx.value == null ? p.ctx.niceName() :
                <span style={{ backgroundColor: p.color }} className="d-flex flex-row align-items-center gap-2 p-2">
                    <strong>{ctx.niceName()}</strong>
                    {p.queryNiceName}
                    <EnumLine ctx={ctx.subCtx(a => a.operation)} formGroupHtmlAttributes={{ className: "d-inline-block" }} />
                    <NumberLine ctx={ctx.subCtx(a => a.value)} formGroupHtmlAttributes={{ className: "d-inline-block" }} />
                </span>}
        </label>
    );
}
