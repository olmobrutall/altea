import * as React from "react";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { Finder } from "@altea/altea/client/Finder";
import { getQueryNiceName } from "@altea/altea/client/Reflection";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { Enum } from "@altea/altea/data/enum";
import {
    ColumnOptionsModeEnum, PaginationModeEnum, OrderTypeEnum, SystemTimeModeEnum, SystemTimeJoinModeEnum,
} from "@altea/altea/data/dynamicQueries";
import { UserQueryEntity, UserQueryMessage, SystemTimeEmbedded } from "../../data/UserQuery";
import QueryTokenEmbeddedBuilder from "./QueryTokenEmbeddedBuilder";
import { FilterBuilderEmbedded } from "./FilterBuilderEmbedded";

// Port of Signum's Signum.UserQueries/Templates/UserQuery.tsx (the UserQuery editor). This first cut covers
// display name / owner / query, group results, columns, orders, pagination and system-time. The FILTERS
// section (Signum's FilterBuilderEmbedded) and the advanced HealthCheck / CustomDrilldowns / "used by" bits
// are DEFERRED — FilterBuilderEmbedded is a large component ported in a following pass.
export default function UserQuery(p: { ctx: TypeContext<UserQueryEntity> }): React.JSX.Element | null {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const query = ctx.value.query;
    const ctxxs = ctx.subCtx({ formSize: "xs" });

    const canAggregate = ctx.value.groupResults ? SubTokensOptions.CanAggregate : 0;
    const canTimeSeries = ctx.value.systemTime?.mode === "TimeSeries" ? SubTokensOptions.CanTimeSeries : 0;

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

            <EntityLine ctx={ctx.subCtx(e => e.entityType)} onChange={() => forceUpdate()}
                helpText={UserQueryMessage.MakesThe0AvailableAsAQuickLinkOf1.niceToString(
                    UserQueryEntity.niceName(),
                    ctx.value.entityType ? ctx.value.entityType.toString() : UserQueryMessage.TheSelected0.niceToString(ctx.niceName(a => a.entityType)))} />

            {ctx.value.entityType != null &&
                <div className="d-flex gap-3">
                    <CheckboxLine ctx={ctx.subCtx(e => e.hideQuickLink)} inlineCheckbox />
                    <CheckboxLine ctx={ctx.subCtx(e => e.showTitleAsBreadcrumb)} inlineCheckbox />
                </div>}

            <CheckboxLine ctx={ctx.subCtx(e => e.groupResults)} inlineCheckbox="block"
                onChange={() => forceUpdate()} />

            <div className="my-2">
                <h2 className="h4">{ctx.niceName(a => a.filters)}</h2>
                <div className="ms-3">
                    <AutoLine ctx={ctxxs.subCtx(e => e.includeDefaultFilters)} />
                    <FilterBuilderEmbedded ctx={ctxxs.subCtx(e => e.filters)}
                        avoidFieldSet
                        subTokenOptions={SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | canAggregate | canTimeSeries}
                        queryKey={query.key}
                        showPinnedFilterOptions={true} />
                </div>
            </div>

            <div className="my-2">
                <h2 className="h4">{ctx.niceName(a => a.columns)}</h2>
                <div className="ms-3">
                    <EnumLine ctx={ctxxs.subCtx(e => e.columnsMode)} optionItems={Enum.values(ColumnOptionsModeEnum)} />
                    <EntityTable ctx={ctxxs.subCtx(e => e.columns)} columns={[
                        {
                            property: a => a.token,
                            template: (cctx, row) =>
                                <QueryTokenEmbeddedBuilder
                                    ctx={cctx.subCtx(a => a.token, { formGroupStyle: "SrOnly" })}
                                    queryKey={query.key}
                                    onTokenChanged={() => { cctx.value.summaryToken = null; row.forceUpdate(); }}
                                    subTokenOptions={columnSubTokens} />,
                        },
                        { property: a => a.displayName },
                        {
                            property: a => a.summaryToken,
                            template: cctx => cctx.value.summaryToken == null ? null :
                                <QueryTokenEmbeddedBuilder
                                    ctx={cctx.subCtx(a => a.summaryToken, { formGroupStyle: "SrOnly" })}
                                    queryKey={query.key}
                                    subTokenOptions={SubTokensOptions.CanElement | SubTokensOptions.CanAggregate} />,
                        },
                        { property: a => a.hiddenColumn },
                    ]} />
                </div>
            </div>

            <div className="my-2">
                <h2 className="h4">{ctx.niceName(a => a.orders)}</h2>
                <div className="ms-3">
                    <EntityTable ctx={ctxxs.subCtx(e => e.orders)} columns={[
                        {
                            property: a => a.token,
                            template: octx =>
                                <QueryTokenEmbeddedBuilder
                                    ctx={octx.subCtx(a => a.token, { formGroupStyle: "SrOnly" })}
                                    queryKey={query.key}
                                    subTokenOptions={orderSubTokens} />,
                        },
                        { property: a => a.orderType, template: octx => <EnumLine ctx={octx.subCtx(a => a.orderType)} optionItems={Enum.values(OrderTypeEnum)} /> },
                    ]} />
                </div>
            </div>

            <div className="my-4">
                <h3 className="h5">{UserQueryMessage.Pagination.niceToString()}</h3>
                <div className="ms-3 row">
                    <div className="col-sm-6"><EnumLine ctx={ctxxs.subCtx(e => e.paginationMode)} optionItems={Enum.values(PaginationModeEnum)} /></div>
                    <div className="col-sm-6"><AutoLine ctx={ctxxs.subCtx(e => e.elementsPerPage)} /></div>
                </div>
            </div>

            <EntityDetail ctx={ctx.subCtx(a => a.systemTime)} onChange={() => forceUpdate()}
                getComponent={stc => <SystemTime ctx={stc} />} />
        </div>
    );
}

function SystemTime(p: { ctx: TypeContext<SystemTimeEmbedded> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formSize: "xs", formGroupStyle: "Basic" });
    return (
        <div className="row">
            <div className="col-sm-3"><EnumLine ctx={ctx.subCtx(e => e.mode)} optionItems={Enum.values(SystemTimeModeEnum)} /></div>
            <div className="col-sm-3"><AutoLine ctx={ctx.subCtx(e => e.startDate)} /></div>
            <div className="col-sm-3"><AutoLine ctx={ctx.subCtx(e => e.endDate)} /></div>
            <div className="col-sm-3"><EnumLine ctx={ctx.subCtx(e => e.joinMode)} optionItems={Enum.values(SystemTimeJoinModeEnum)} /></div>
        </div>
    );
}
