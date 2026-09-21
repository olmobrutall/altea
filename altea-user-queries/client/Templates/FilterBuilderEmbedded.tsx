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
import { Enum } from "@altea/altea/data/enum";
import {
    FilterOperation, FilterGroupOperation, DashboardBehaviour, PinnedFilterActive,
} from "@altea/altea/data/dynamicQueries";
import type { HeaderType } from "@altea/altea/client/Lines/GroupHeader";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { Clock } from "@altea/altea/data/utils/clock";
import { parseFilterValue, stringifyFilterValue } from "@altea/altea-user-assets/data/FilterValueString";
import { FilterValueConverter } from "@altea/altea-user-assets/data/FilterValueConverter";
import {
    isSmartDateTimeExpression, smartDateTimeExpression, smartDateTimeFormat,
} from "@altea/altea-user-assets/data/FilterValueConverters/SmartDateTimeFilterValueConverter";
import { UserAssetQueryMessage } from "@altea/altea-user-assets/data/UserAssets";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded, QueryFilterBaseEntity, QueryFilterPinnedBaseEntity } from "@altea/altea-user-assets/data/Queries";
import { UserQueryEntity_Filter } from "../../data/UserQuery";

// Port of Signum's Signum.UserAssets/Templates/FilterBuilderEmbedded.tsx — the editor that binds a
// UserQuery's stored filter rows to altea's FilterBuilder. altea divergences:
//  - MList → plain `UserQueryEntity_Filter[]`; `X.New({...})` → `new X()` + field assignment.
//  - altea's FilterBuilder takes the ROOT queryToken (no QueryDescription DTO) and renders filter VALUES
//    natively, so Signum's `renderValue` expression-toggle is one plain text box rather than a typed
//    editor per type. A SMART DATE is converted (FilterValueConverters/SmartDateTime…); [CurrentEntity] /
//    [CurrentUser] still round-trip as raw strings, resolved by whoever runs the asset.
//  - values are converted to/from their stored string form by filterType (FilterValueString), lists on "|".
//  - the ctx takes the SHARED `QueryFilterBaseEntity[]` rather than one owner's row type: every stored query
//    definition owns its OWN @part filter rows (a part row has exactly one owner in altea), and they all
//    subclass QueryFilterBaseEntity — so this one editor drives a UserQuery's, a UserChart's and an
//    EmailTemplate's filters. When it REBUILDS the rows it must construct the OWNER's concrete row type,
//    which it reads off the bound field's own reflection metadata (`rowConstructorOf`).
interface FilterBuilderEmbeddedProps {
    ctx: TypeContext<QueryFilterBaseEntity[]>;
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
        const rows = filterOptionsParsedToEmbedded(newFilters, rowConstructorOf(p.ctx));
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
    const token = f.token as QueryToken | undefined;
    const forceUpdate = useForceUpdate();
    // Expression mode when the stored value is one of the "[…]" expressions or a SMART DATE — the two
    // things a stored filter can hold that are not the value itself.
    const [expression, setExpression] = React.useState<boolean>(
        () => typeof f.value === "string" && (f.value.startsWith("[") || isSmartDateTimeExpression(f.value)));

    function toggle(): void {
        if (expression) {
            f.value = null; // back to a concrete value → clear
        } else {
            // Switch to expression: seed [CurrentEntity] for a reference token, the current date written
            // RELATIVE to now for a date one (the grammar is hard to guess at from an empty box), else
            // an empty expression.
            const ft = token?.filterType;
            f.value =
                ft === "Lite" || ft === "Embedded" || ft === "Model" ? "[CurrentEntity]" :
                    ft === "DateTime" ? smartDateSeed(f.value) :
                        "";
        }
        setExpression(!expression);
        rvc.handleValueChange();
    }

    // Why the typed expression will not do — a malformed smart date, say. Shown rather than thrown: the
    // same string reaches `parseFilterValue` when the asset runs, which throws there.
    const error = expression && typeof f.value === "string"
        ? FilterValueConverter.validationError(f.value, { filterType: token?.filterType, typeName: token?.type.typeName })
        : null;

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
                    ? <input type="text" className={"form-control form-control-xs" + (error != null ? " is-invalid" : "")}
                        readOnly={rvc.readonly}
                        title={token?.filterType === "DateTime" ? smartDateTimeFormat : undefined}
                        value={(f.value as string | null) ?? ""}
                        onChange={e => { f.value = e.currentTarget.value; forceUpdate(); rvc.handleValueChange(); }} />
                    : Finder.renderFilterValue(f, ffc)}
                {error != null && <div className="invalid-feedback d-block">{error}</div>}
            </div>
            {toggleButton}
        </div>
    );
}

// Parse the stored flat rows into altea's FilterOptionParsed tree (Signum's toFilterOptionParsed).
//
// EXPORTED because a stored definition's filters are also what its PREVIEW runs: a caller that wants to
// open a SearchControl over "the query as this definition has it" needs exactly this conversion, and
// Signum exports its own (`FilterBuilderEmbedded.toFilterOptionParsed`) for the same reason —
// altea-machine-learning's predictor designer is the first such caller.
export async function toFilterOptionParsed(
    rootToken: QueryToken, allFilters: QueryFilterBaseEntity[], subTokenOptions: SubTokensOptions,
): Promise<FilterOptionParsed[]> {
    const completer = new Finder.TokenCompleter(rootToken);
    for (const f of allFilters)
        if (f.token?.tokenString)
            completer.request(f.token.tokenString);
    await completer.finished();

    /**
     * The PINNED half of a stored row, for an owner that has one. An owner whose filters cannot be pinned
     * (a predictor's training population — see QueryFilterPinnedBaseEntity) carries neither member, and
     * its parsed filter gets neither.
     */
    function pinnedParsed(row: QueryFilterBaseEntity): Pick<FilterConditionOptionParsed, "pinned" | "dashboardBehaviour"> {
        if (!(row instanceof QueryFilterPinnedBaseEntity))
            return {};

        return {
            pinned: row.pinned ? toPinnedParsed(row.pinned) : undefined,
            dashboardBehaviour: row.dashboardBehaviour == null ? undefined
                : Enum.toName(DashboardBehaviour, row.dashboardBehaviour),
        };
    }

    function build(filters: QueryFilterBaseEntity[], indent: number): FilterOptionParsed[] {
        return groupWhen(filters, f => f.indentation === indent).map(run => {
            const head = run[0];
            const children = run.slice(1);
            if (!head.isGroup) {
                const token = head.token ? completer.get(head.token.tokenString, subTokenOptions) : undefined;
                return {
                    token,
                    operation: head.operation == null ? "EqualTo" : Enum.toName(FilterOperation, head.operation),
                    value: parseFilterValue(head.valueString, token?.filterType, token?.type.typeName),
                    frozen: false,
                    ...pinnedParsed(head),
                } as FilterConditionOptionParsed;
            }
            return {
                token: head.token ? completer.get(head.token.tokenString, subTokenOptions) : undefined,
                groupOperation: Enum.toName(FilterGroupOperation, head.groupOperation!),
                filters: build(children, indent + 1),
                value: head.valueString ?? undefined,
                frozen: false,
                ...pinnedParsed(head),
            } as FilterGroupOptionParsed;
        });
    }

    return build(allFilters, 0);
}

// Flatten a parsed filter tree into the stored, indentation-tagged rows (Signum's pushFilter loop). Shared
// by the FilterBuilderEmbedded editor and UserQueryMenu's create/apply-changes.
export function filterOptionsParsedToEmbedded(
    filters: FilterOptionParsed[],
    rowConstructor: new () => QueryFilterBaseEntity = UserQueryEntity_Filter,
): QueryFilterBaseEntity[] {
    const rows: QueryFilterBaseEntity[] = [];
    function push(fo: FilterOptionParsed, indent: number): void {
        const row = new rowConstructor();
        row.indentation = indent as QueryFilterBaseEntity["indentation"];
        // An owner that cannot pin (a predictor's training population) has neither member, and a parsed
        // filter for it never carries either — its editor does not offer them.
        if (row instanceof QueryFilterPinnedBaseEntity) {
            row.pinned = fo.pinned ? toPinnedEmbedded(fo.pinned) : null;
            // FindOptions carries member-name strings; the embedded enum fields are int-FK ordinals.
            row.dashboardBehaviour = fo.dashboardBehaviour == null ? null : Enum.toValue(DashboardBehaviour, fo.dashboardBehaviour);
        }
        if (isFilterGroup(fo)) {
            row.isGroup = true;
            row.groupOperation = fo.groupOperation == null ? null : Enum.toValue(FilterGroupOperation, fo.groupOperation);
            row.token = fo.token ? toTokenEmbedded(fo.token) : null;
            row.valueString = Array.isArray(fo.value) && fo.token
                ? fo.value.map(v => stringifyFilterValue(v, fo.token!.filterType)).join("|")
                : (fo.value != null ? String(fo.value) : null);
            rows.push(row);
            fo.filters.forEach(f => push(f, indent + 1));
        } else {
            row.token = fo.token ? toTokenEmbedded(fo.token) : null;
            row.operation = fo.operation == null ? null : Enum.toValue(FilterOperation, fo.operation);
            row.valueString = Array.isArray(fo.value) && fo.token
                ? fo.value.map(v => stringifyFilterValue(v, fo.token!.filterType)).join("|")
                : stringifyFilterValue(fo.value, fo.token?.filterType);
            rows.push(row);
        }
    }
    filters.forEach(fo => push(fo, 0));
    return rows;
}

/** What the expression box starts with for a DATE token: the value it held, written relative to now.
 *  The box also accepts anything else, so a value it cannot read falls back to today rather than throwing. */
function smartDateSeed(value: unknown): string {
    try {
        return smartDateTimeExpression(typeof value === "string" && value !== "" ? value : Clock.now);
    } catch {
        return smartDateTimeExpression(Clock.now);
    }
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
    e.active = Enum.toValue(PinnedFilterActive, p.active ?? "Always");
    e.splitValue = p.splitValue ?? false;
    return e;
}

function toPinnedParsed(p: PinnedQueryFilterEmbedded): PinnedFilterParsed {
    return {
        label: p.label || undefined,
        column: p.column ?? undefined,
        colSpan: p.colSpan ?? undefined,
        row: p.row ?? undefined,
        active: Enum.toName(PinnedFilterActive, p.active),
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

/** The concrete `@part` row type the bound collection holds (see the header). Read off the field's own
 *  TypeReference; falls back to UserQueryEntity_Filter when the ctx has no property route (a detached ctx). */
function rowConstructorOf(ctx: TypeContext<QueryFilterBaseEntity[]>): new () => QueryFilterBaseEntity {
    const ctor = ctx.propertyRoute?.fieldInfo?.getFunction();
    return (ctor as (new () => QueryFilterBaseEntity) | undefined) ?? UserQueryEntity_Filter;
}

export default FilterBuilderEmbedded;
