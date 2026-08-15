import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { Binding } from "@altea/altea/client/binding";
import { Finder } from "@altea/altea/client/Finder";
import FilterBuilder, { type RenderValueContext } from "@altea/altea/client/SearchControl/FilterBuilder";
import {
    type FilterOptionParsed, type FilterConditionOptionParsed, type FilterGroupOptionParsed,
    type PinnedFilterParsed, isFilterGroup, isList, isPair,
} from "@altea/altea/client/FindOptions";
import { QueryToken, SubTokensOptions } from "@altea/altea/client/QueryToken";
import type { HeaderType } from "@altea/altea/client/Lines/GroupHeader";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { parseFilterValue, stringifyFilterValue } from "@altea/altea-user-assets/client/FilterValueString";
import { UserAssetQueryMessage } from "@altea/altea-user-assets/data/UserAssets";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded } from "@altea/altea-user-assets/data/Queries";
import { QueryFilterEmbedded } from "../../data/UserQuery";

// Port of Signum's Signum.UserAssets/Templates/FilterBuilderEmbedded.tsx — the editor that binds a
// UserQuery's stored filter rows to altea's FilterBuilder. altea divergences:
//  - MList → plain `QueryFilterEmbedded[]`; `X.New({...})` → `new X()` + field assignment.
//  - altea's FilterBuilder takes the ROOT queryToken (no QueryDescription DTO) and renders filter VALUES
//    natively — so Signum's `renderValue` expression-toggle (SwitchToValue/Expression, [CurrentEntity],
//    SmartDateTime) is DEFERRED; the raw string still round-trips.
//  - values are converted to/from their stored string form by filterType (FilterValueString), lists on "|".
interface FilterBuilderEmbeddedProps {
    ctx: TypeContext<QueryFilterEmbedded[]>;
    avoidFieldSet?: boolean | HeaderType;
    queryKey: string;
    subTokenOptions: SubTokensOptions;
    onChanged?: () => void;
    showPinnedFilterOptions?: boolean;
}

export function FilterBuilderEmbedded(p: FilterBuilderEmbeddedProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const rootToken = useAPI(() => Finder.getQueryRoot(p.queryKey), [p.queryKey]);
    const filterOptions = useAPI(
        () => rootToken == null ? Promise.resolve(null) : toFilterOptionParsed(rootToken, p.ctx.value, p.subTokenOptions),
        [rootToken, p.ctx.value, p.subTokenOptions]);

    function handleFiltersChanged(newFilters: FilterOptionParsed[]): void {
        const rows = filterOptionsParsedToEmbedded(newFilters);
        p.ctx.value.length = 0;
        p.ctx.value.push(...rows);
        p.ctx.binding.setValue(p.ctx.value); // force change tracking
        p.onChanged?.();
        forceUpdate();
    }

    // Signum's FilterBuilderEmbedded.handleRenderValue: a single-value condition can hold either a concrete
    // value OR an EXPRESSION string ("[CurrentEntity]", "[CurrentUser]", a relative date). Wrap altea's
    // native value editor with a value↔expression toggle; groups and list/pair conditions keep the native
    // editor (no toggle). The expressions are resolved when the UserQuery runs (UserQueriesClient.Converter).
    function handleRenderValue(rvc: RenderValueContext): React.ReactElement {
        const f = rvc.filter;
        const ctx = new TypeContext<unknown>(undefined,
            { formGroupStyle: "None", readOnly: rvc.readonly, formSize: "xs" },
            (isFilterGroup(f) ? f.token?.type : f.token?.type), new Binding(f, "value"));
        const ffc: Finder.FilterFormatterContext = {
            ctx, queryToken: rootToken!, filterOptions: filterOptions ?? [],
            handleValueChange: () => rvc.handleValueChange(),
        };
        if (isFilterGroup(f) || f.token == null || (f.operation != null && (isList(f.operation) || isPair(f.operation))))
            return Finder.renderFilterValue(f, ffc);
        return <ValueOrExpression rvc={rvc} ffc={ffc} />;
    }

    return (
        <div>
            {rootToken != null && filterOptions != null &&
                <FilterBuilder
                    title={p.ctx.niceName()}
                    avoidFieldSet={p.avoidFieldSet}
                    queryToken={rootToken}
                    filterOptions={filterOptions}
                    subTokensOptions={p.subTokenOptions}
                    readOnly={p.ctx.readOnly}
                    onFiltersChanged={handleFiltersChanged}
                    renderValue={handleRenderValue}
                    showPinnedFiltersOptions={p.showPinnedFilterOptions}
                    showPinnedFiltersOptionsButton={false} />}
        </div>
    );
}

// Port of Signum's AutoLineOrExpression / EntityLineOrExpression (FilterBuilderEmbedded.tsx): renders the
// value editor for a single-value condition, with a pen-icon button toggling between the concrete value and
// a free-text EXPRESSION ("[CurrentEntity]" / "[CurrentUser]" / a relative date). altea divergence: instead
// of re-implementing every typed editor, VALUE mode reuses altea's Finder.renderFilterValue; only the
// EXPRESSION mode is a plain text input bound to the filter value.
function ValueOrExpression(props: { rvc: RenderValueContext; ffc: Finder.FilterFormatterContext }): React.JSX.Element {
    const { rvc, ffc } = props;
    const f = rvc.filter as FilterConditionOptionParsed;
    const forceUpdate = useForceUpdate();
    // Expression mode when the stored value is one of the "[…]" expressions (or a string typed by the user).
    const [expression, setExpression] = React.useState<boolean>(() => typeof f.value === "string" && f.value.startsWith("["));

    function toggle(): void {
        if (expression) {
            f.value = null; // back to a concrete value → clear
        } else {
            // Switch to expression: seed [CurrentEntity] for a reference token, else an empty expression.
            const ft = (f.token as QueryToken | undefined)?.filterType;
            f.value = ft === "Lite" || ft === "Embedded" || ft === "Model" ? "[CurrentEntity]" : "";
        }
        setExpression(!expression);
        rvc.handleValueChange();
    }

    const toggleButton = (
        <LinkButton
            className="sf-line-button btn input-group-text"
            title={expression ? UserAssetQueryMessage.SwitchToValue.niceToString() : UserAssetQueryMessage.SwitchToExpression.niceToString()}
            onClick={() => { if (!rvc.readonly) toggle(); }}>
            <FontAwesomeIcon aria-hidden={true} icon="pen-to-square" />
        </LinkButton>
    );

    return (
        <div className="d-flex align-items-center gap-1">
            <div className="flex-grow-1">
                {expression
                    ? <input type="text" className="form-control form-control-xs" readOnly={rvc.readonly}
                        value={(f.value as string | null) ?? ""}
                        onChange={e => { f.value = e.currentTarget.value; forceUpdate(); rvc.handleValueChange(); }} />
                    : Finder.renderFilterValue(f, ffc)}
            </div>
            {toggleButton}
        </div>
    );
}

// Parse the stored flat rows into altea's FilterOptionParsed tree (Signum's toFilterOptionParsed).
async function toFilterOptionParsed(
    rootToken: QueryToken, allFilters: QueryFilterEmbedded[], subTokenOptions: SubTokensOptions,
): Promise<FilterOptionParsed[]> {
    const completer = new Finder.TokenCompleter(rootToken);
    for (const f of allFilters)
        if (f.token?.tokenString)
            completer.request(f.token.tokenString);
    await completer.finished();

    function build(filters: QueryFilterEmbedded[], indent: number): FilterOptionParsed[] {
        return groupWhen(filters, f => (f.indentation as unknown as number) === indent).map(run => {
            const head = run[0];
            const children = run.slice(1);
            if (!head.isGroup) {
                const token = head.token ? completer.get(head.token.tokenString, subTokenOptions) : undefined;
                return {
                    token,
                    operation: head.operation ?? "EqualTo",
                    value: parseFilterValue(head.valueString, token?.filterType),
                    frozen: false,
                    pinned: head.pinned ? toPinnedParsed(head.pinned) : undefined,
                    dashboardBehaviour: head.dashboardBehaviour ?? undefined,
                } as FilterConditionOptionParsed;
            }
            return {
                token: head.token ? completer.get(head.token.tokenString, subTokenOptions) : undefined,
                groupOperation: head.groupOperation!,
                filters: build(children, indent + 1),
                value: head.valueString ?? undefined,
                frozen: false,
                pinned: head.pinned ? toPinnedParsed(head.pinned) : undefined,
                dashboardBehaviour: head.dashboardBehaviour ?? undefined,
            } as FilterGroupOptionParsed;
        });
    }

    return build(allFilters, 0);
}

// Flatten a parsed filter tree into the stored, indentation-tagged rows (Signum's pushFilter loop). Shared
// by the FilterBuilderEmbedded editor and UserQueryMenu's create/apply-changes.
export function filterOptionsParsedToEmbedded(filters: FilterOptionParsed[]): QueryFilterEmbedded[] {
    const rows: QueryFilterEmbedded[] = [];
    function push(fo: FilterOptionParsed, indent: number): void {
        const row = new QueryFilterEmbedded();
        row.indentation = indent as QueryFilterEmbedded["indentation"];
        row.pinned = fo.pinned ? toPinnedEmbedded(fo.pinned) : null;
        row.dashboardBehaviour = fo.dashboardBehaviour ?? null;
        if (isFilterGroup(fo)) {
            row.isGroup = true;
            row.groupOperation = fo.groupOperation;
            row.token = fo.token ? toTokenEmbedded(fo.token) : null;
            row.valueString = Array.isArray(fo.value) && fo.token
                ? fo.value.map(v => stringifyFilterValue(v, fo.token!.filterType)).join("|")
                : (fo.value != null ? String(fo.value) : null);
            rows.push(row);
            fo.filters.forEach(f => push(f, indent + 1));
        } else {
            row.token = fo.token ? toTokenEmbedded(fo.token) : null;
            row.operation = fo.operation ?? null;
            row.valueString = Array.isArray(fo.value) && fo.token
                ? fo.value.map(v => stringifyFilterValue(v, fo.token!.filterType)).join("|")
                : stringifyFilterValue(fo.value, fo.token?.filterType);
            rows.push(row);
        }
    }
    filters.forEach(fo => push(fo, 0));
    return rows;
}

function toTokenEmbedded(token: QueryToken): QueryTokenEmbedded {
    const t = new QueryTokenEmbedded();
    t.tokenString = token.fullKey();
    t.token = token;
    return t;
}

function toPinnedEmbedded(p: PinnedFilterParsed): PinnedQueryFilterEmbedded {
    const e = new PinnedQueryFilterEmbedded();
    e.label = p.label ?? null;
    e.column = (p.column ?? null) as PinnedQueryFilterEmbedded["column"];
    e.colSpan = (p.colSpan ?? null) as PinnedQueryFilterEmbedded["colSpan"];
    e.row = (p.row ?? null) as PinnedQueryFilterEmbedded["row"];
    e.active = p.active ?? "Always";
    e.splitValue = p.splitValue ?? false;
    return e;
}

function toPinnedParsed(p: PinnedQueryFilterEmbedded): PinnedFilterParsed {
    return {
        label: p.label || undefined,
        column: p.column ?? undefined,
        colSpan: p.colSpan ?? undefined,
        row: p.row ?? undefined,
        active: p.active || undefined,
        splitValue: p.splitValue || undefined,
    };
}

function groupWhen<T>(list: T[], isGroupStart: (t: T) => boolean): T[][] {
    const result: T[][] = [];
    let current: T[] | null = null;
    for (const item of list) {
        if (isGroupStart(item)) {
            current = [item];
            result.push(current);
        } else if (current != null) {
            current.push(item);
        }
    }
    return result;
}

export default FilterBuilderEmbedded;
