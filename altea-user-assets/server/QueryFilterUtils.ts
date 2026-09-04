import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    FilterCondition, FilterGroup, FilterOperationKeys, FilterGroupOperationKeys, type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { Enum } from "@altea/altea/data/enum";
import { deserializeFilterValue } from "@altea/altea/server/queryServer";
import { FilterOperation, FilterGroupOperation, DashboardBehaviour, PinnedFilterActive } from "@altea/altea/data/dynamicQueries";
import { Entity } from "@altea/altea/data/entity";
import type { QueryFilterBaseEntity } from "../data/Queries";
import { parseFilterValue } from "../data/FilterValueString";

// Port of Signum's UserAssets `QueryFilterUtils.ToFilterList` (Signum.UserAssets/Queries/QueryFilterUtils.cs)
// — turn the FLAT, indentation-encoded rows of a stored filter tree into the engine's nested Filter list.
//
// altea divergences, documented inline:
//  - The rows are the shared `QueryFilterBaseEntity` (see @altea/altea-user-assets), so this works for ANY
//    owner's filter rows — a template's, a user query's, a chart's.
//  - A stored enum field is an ORDINAL in memory and a member NAME on the wire; the engine's FilterOperation
//    / FilterGroupOperation are string enums, so each is converted through `Enum.toName`.
//  - `valueString` → a typed value with the client-side `parseFilterValue` (the same converter the
//    SearchControl uses), keyed off the token's FilterType.
//  - Lives in altea-user-assets, matching Signum (Signum.UserAssets/Queries/QueryFilterUtils.cs). It was
//    parked in altea-email while that was the only server consumer; @altea/altea-office-template is the
//    second, so it moved here — every owner of QueryFilterBaseEntity rows shares one converter.

export namespace QueryFilterUtils {

    /** Signum's ToFilterList — the stored rows, nested by `indentation`. */
    export function toFilterList(queryName: QueryName, rows: readonly QueryFilterBaseEntity[]): Filter[] {
        const ordered = [...rows].sort((a, b) => (a.order as number) - (b.order as number));
        const [filters] = build(queryName, ordered, 0, 0);
        return filters;
    }

    /** Consume every row at `indentation` (and its deeper children) starting at `index`. */
    function build(queryName: QueryName, rows: readonly QueryFilterBaseEntity[], index: number, indentation: number): [Filter[], number] {
        const result: Filter[] = [];

        let i = index;
        while (i < rows.length && (rows[i].indentation as number) >= indentation) {
            const row = rows[i];

            // A row nested DEEPER than expected without a group header above it is malformed; treat it as
            // belonging to this level rather than losing it.
            if (row.isGroup) {
                // The children are consumed either way — a skipped group takes its whole subtree with it.
                const [children, next] = build(queryName, rows, i + 1, (row.indentation as number) + 1);
                if (!skipAsFilter(row, undefined))
                    result.push(new FilterGroup(
                        groupOperation(row.groupOperation),
                        row.token == null ? undefined : token(queryName, row.token.tokenString),
                        children));
                i = next;
                continue;
            }

            if (row.token != null && row.operation != null) {
                const t = token(queryName, row.token.tokenString);
                const op = operation(row.operation);
                // Parsed BEFORE the skip test, because one rule asks whether there is a value at all.
                const v = value(t, op, row.valueString);
                if (!skipAsFilter(row, v))
                    result.push(new FilterCondition(t, op, v));
            }
            i++;
        }

        return [result, i];
    }

    /**
     * Signum's `ToFilterList` skip rules — which stored rows do NOT become filters.
     *
     * A stored filter row is not always a filter. A PINNED one is a control the user operates, so it filters
     * only in the states where the UI would have sent it, and a row marked for a DASHBOARD behaviour is
     * consumed by the dashboard (as an initial selection, or as a fallback when nothing else filters) rather
     * than applied here. Everything below is Signum's list, in its order.
     *
     * Without these a headless execution filters by things the UI never would — most visibly `EqualTo null`
     * for an unset pinned filter, which reads as "IS NULL" and answers with the wrong rows (usually none).
     * That is why this is not only a cached-query concern: it applies to every server-side run of a stored
     * asset (a scheduled report, an emailed user query, a snapshot).
     */
    function skipAsFilter(row: QueryFilterBaseEntity, parsedValue: unknown): boolean {
        const behaviour = row.dashboardBehaviour == null ? null : Enum.toName(DashboardBehaviour, row.dashboardBehaviour);
        // Signum's TODO is kept as written: "works for CachedQueries but maybe not in other cases".
        if (behaviour === "UseAsInitialSelection" || behaviour === "UseWhenNoFilters")
            return true;

        if (row.pinned == null)
            return false;

        const active = Enum.toName(PinnedFilterActive, row.pinned.active);

        // A checkbox in its "off" state filters by nothing.
        if (active === "Checkbox_Unchecked" || active === "NotCheckbox_Checked")
            return true;

        // A split value has nothing to split.
        if (row.pinned.splitValue && (row.valueString == null || row.valueString === ""))
            return true;

        // "Only when it has a value" — and it has none. For a GROUP the value is never parsed, so the group
        // itself is dropped (Signum's second TODO: "works for empty groups").
        if (active === "WhenHasValue" && (row.isGroup || parsedValue == null))
            return true;

        return false;
    }

    function token(queryName: QueryName, tokenString: string): QueryToken {
        return QueryLogic.getToken(queryName, tokenString, SubTokensOptionsAll);
    }

    function operation(ordinal: FilterOperation): FilterOperationKeys {
        return Enum.toName(FilterOperation, ordinal) as FilterOperationKeys;
    }

    function groupOperation(ordinal: FilterGroupOperation | null): FilterGroupOperationKeys {
        return (ordinal == null ? "And" : Enum.toName(FilterGroupOperation, ordinal)) as FilterGroupOperationKeys;
    }

    /** The stored `valueString` as the token's own type. A list operation splits on `|` (Signum's convention). */
    function value(t: QueryToken, op: FilterOperationKeys, valueString: string | null): unknown {
        if (valueString == null || valueString === "")
            return null;

        if (op === FilterOperationKeys.IsIn || op === FilterOperationKeys.IsNotIn)
            return valueString.split("|").map(v => parseFilterValue(v.trim(), t.filterType));

        // …then coerced to what the COLUMN holds. `parseFilterValue` is isomorphic and answers what the
        // CLIENT works with — for an enum that is the member NAME, because the wire value is the name — but
        // a query compares against the stored ORDINAL. `deserializeFilterValue` is the same coercion the
        // live query route applies to a filter the client posts, reused here rather than restated: without
        // it a stored asset with an enum filter fails at query time with "invalid input syntax for type
        // integer", and every SERVER-side consumer of that asset is affected (a dashboard snapshot, an
        // e-mail or Office template's query, the SMS one) while the UI path works, since there the client
        // builds the request and the route coerces it.
        return deserializeFilterValue(t, op, parseFilterValue(valueString, t.filterType));
    }

    /** The "this row's entity" filter every single-entity render starts from (Signum's
     *  `new FilterCondition(QueryUtils.Parse("Entity", qd, 0), EqualTo, entity.ToLite())`). */
    export function entityFilter(queryName: QueryName, entity: Entity): Filter {
        return new FilterCondition(token(queryName, ""), FilterOperationKeys.EqualTo, entity.toLite());
    }
}
