import * as React from "react";
import { Button } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EnumCheckboxList } from "@altea/altea/client/Lines/EnumCheckboxList";
import CollapsableCard from "@altea/altea/client/Components/CollapsableCard";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { ISimpleFilterBuilder } from "@altea/altea/client/SearchControl/SearchControl";
import {
    isActive, isFilterCondition, type FilterOperation, type FilterOption, type FilterOptionParsed,
} from "@altea/altea/client/FindOptions";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { InboxRowModel } from "../../data/CaseActivity";
import {
    CaseNotificationEntity, CaseNotificationState, DateFilterRange, InboxFilterModel, InboxMessage,
} from "../../data/CaseNotification";

// Port of Signum.Workflow's Case/InboxFilter.tsx — the Inbox's simple filter builder: which notification
// states to show, and over which date range.
//
// altea divergences: the states are a plain array of ordinals, and luxon's `DateTime.local().plus(…)` becomes
// `Clock.now.add(…)` over Temporal.PlainDateTime (which is what the CaseActivity.startDate column is).

export default class InboxFilter extends React.Component<{ ctx: TypeContext<InboxFilterModel> }>
    implements ISimpleFilterBuilder {

    handleOnClearFiltersClick = (): void => {
        InboxFilter.resetModel(this.props.ctx.value);
        this.forceUpdate();
    };

    static resetModel(model: InboxFilterModel): void {
        model.range = DateFilterRange.All;
        model.states = [CaseNotificationState.New, CaseNotificationState.Opened, CaseNotificationState.InProgress];
        model.fromDate = null;
        model.toDate = null;
    }

    override render(): React.JSX.Element {
        const ctx = this.props.ctx;
        const ctx4 = ctx.subCtx({ labelColumns: 4 });

        return (
            <div style={{ marginBottom: "5px" }}>
                <CollapsableCard
                    header={InboxMessage.Filters.niceToString()}
                    cardStyle={{ background: "success" }}
                    headerStyle={{ text: "light" }}
                    bodyStyle={{ background: "light" }}>
                    <div className="sf-main-control">
                        <div className="row">
                            <div className="col-sm-3">
                                <EnumCheckboxList ctx={ctx.subCtx(o => o.states)} columnCount={2}
                                    formGroupHtmlAttributes={{ style: { marginTop: -15, marginBottom: -15 } }} />
                            </div>
                            <div className="col-sm-3">
                                <AutoLine ctx={ctx4.subCtx(o => o.range)} />
                                <AutoLine ctx={ctx4.subCtx(o => o.fromDate)} />
                                <AutoLine ctx={ctx4.subCtx(o => o.toDate)} />
                            </div>
                            <div className="col-sm-1">
                                <Button variant="warning" className="btn" onClick={this.handleOnClearFiltersClick}>
                                    {InboxMessage.Clear.niceToString()}
                                </Button>
                            </div>
                        </div>
                    </div>
                </CollapsableCard>
            </div>
        );
    }

    getFilters(): FilterOption[] {
        const result: FilterOption[] = [];
        const val = this.props.ctx.value;

        let fromDate: Temporal.PlainDateTime | undefined;

        switch (val.range) {
            case DateFilterRange.All:
                break;
            case DateFilterRange.LastWeek:
                fromDate = Clock.now.add({ days: -7 });
                break;
            case DateFilterRange.LastMonth:
                fromDate = Clock.now.add({ days: -30 });
                break;
            case DateFilterRange.CurrentYear:
                fromDate = Clock.now.with({ month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 });
                break;
        }

        if (fromDate != null)
            result.push({
                token: "startDate",
                operation: "GreaterThanOrEqual", value: fromDate,
            });

        if (val.states?.length)
            result.push({
                token: "state",
                operation: "IsIn", value: val.states,
            });

        if (val.fromDate)
            result.push({
                token: "startDate",
                value: val.fromDate, operation: "GreaterThanOrEqual",
            });

        if (val.toDate)
            result.push({
                token: "startDate",
                value: val.toDate, operation: "LessThanOrEqual",
            });

        return result;
    }

    static extract(fos: FilterOptionParsed[]): InboxFilterModel | null {
        const filters = [...fos];
        // Camel-case literals, as in WorkflowClient's Inbox settings — see the note there.
        const startDateToken = "startDate";
        const stateToken = "state";

        const states = extractFilterValue(filters, stateToken, "IsIn") as CaseNotificationState[] | undefined;
        const fromDate = extractFilterValue(filters, startDateToken, "GreaterThanOrEqual") as Temporal.PlainDateTime | null;
        const toDate = extractFilterValue(filters, startDateToken, "LessThanOrEqual") as Temporal.PlainDateTime | null;

        const result = InboxFilterModel.create({
            // Signum reads a "Range" column back out of the filters; altea's Inbox has no such column (the
            // range is only ever WRITTEN, as a startDate bound), so a round-tripped filter set always shows
            // "All" plus the explicit dates it actually carries.
            range: DateFilterRange.All,
            states: states ?? [],
            fromDate,
            toDate,
        });

        if (filters.length)
            return null;

        return result;
    }
}

/**
 * Signum's `extractFilterValue` (Signum/React/Search.tsx): take the first ACTIVE condition on `token` with
 * `operation` OUT of the list and answer its value — so what is left over tells the caller whether the whole
 * filter set was expressible by this simple builder.
 *
 * altea's Finder does not export it (nor Signum's `similarToken`, which normalises an "Entity."-rooted token
 * against a bare one), so this is the two-line local version: the Inbox's tokens are all rooted at the row
 * model, so plain fullKey equality is the right comparison here.
 */
function extractFilterValue(filters: FilterOptionParsed[], token: string, operation: FilterOperation): unknown {
    const f = filters.firstOrNull(f => isFilterCondition(f) && isActive(f)
        && f.token?.fullKey() === token && f.operation === operation);

    if (f == null)
        return undefined;

    filters.remove(f);
    return (f as { value?: unknown }).value;
}
