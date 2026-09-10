import {
    Filter, FilterCondition, FilterGroup, FilterGroupOperationKeys, FilterOperationKeys,
    Order, OrderTypeKeys, Column, Pagination,
} from "@altea/altea/server/dynamicQuery/requests";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { Temporal } from "@altea/altea/data/basics";
import { Lite } from "@altea/altea/data/lite";
import { AzureADMessage } from "../data/AzureAD";

// Turning a query request into Graph's OData parameters. Port of Signum.Authorization.AzureAD's
// MicrosftGraphQuery.cs (the typo is Signum's) — turn a
// SearchControl request into Microsoft Graph OData query parameters.
//
// The interesting part is the split between `$filter` and `$search`: Graph cannot express "contains"
// in `$filter`, so a Contains condition becomes a `$search` term instead, and the two are combined
// SEPARATELY (`getFilters` drops the Contains conditions, `getSearch` keeps only those). Inside an OR that
// is impossible — a group would have to be half filter and half search — so mixing them there is an error,
// which is what makes both usable at once.
//
// altea divergences, documented inline:
//  - `token.Follow(a => a.Parent).Reverse().ToString(a => a.Key.FirstLower(), "/")` loses the FirstLower:
//    altea's token keys are ALREADY camelCase (see CLAUDE.md), so lowering the first letter again would
//    turn `onPremisesExtensionAttributes` into itself but `Id` — which altea never produces — into `id`.
//    Walking parents and joining with "/" is the whole translation.
//  - the root token's key is "" in altea (rootless convention), so it is skipped rather than emitted.
//  - `ToStringValue` handles Temporal (altea's date/time types) and a Lite (a filter on `inGroup` /
//    `hasUser` carries one) instead of .NET's DateTime / Guid.

export enum GraphFieldUsage {
    Filter,
    Search,
    Select,
    Order,
}

export class MicrosoftGraphQueryConverter {

    /** The `$orderby` parameter. */
    getOrderBy(orders: Order[]): string[] | null {
        if (orders.length === 0)
            return null;
        return orders.map(o => this.toGraphField(o.token, GraphFieldUsage.Order)
            + " " + (o.orderType === OrderTypeKeys.Ascending ? "asc" : "desc"));
    }

    /**
     * Row-model member → Graph field, where the two names differ. Only one entry, and it is not cosmetic:
     * the row models cannot call the field `id`, because a member of that name is excluded from a query's
     * token tree (see ActiveDirectoryQueries.ts) — so `objectId` is the token and `id` is what Graph wants.
     */
    static readonly fieldAliases: Record<string, string> = { objectId: "id" };

    /** A query token as the Graph field it names. */
    toGraphField(token: QueryToken, usage: GraphFieldUsage): string {
        const parts: string[] = [];
        for (let t: QueryToken | undefined = token; t != undefined; t = t.parent)
            if (t.key !== "")
                parts.unshift(MicrosoftGraphQueryConverter.fieldAliases[t.key] ?? t.key);

        const field = parts.join("/");

        // Graph only lets you $select the whole complex property, never one of its members.
        if (usage === GraphFieldUsage.Select && field.startsWith("onPremisesExtensionAttributes/"))
            return "onPremisesExtensionAttributes";

        return field;
    }

    /** An OData literal. */
    toStringValue(value: unknown): string {
        if (value == null)
            return "null";
        if (typeof value === "string")
            return `'${value.replace(/'/g, "''")}'`;
        if (typeof value === "boolean")
            return value ? "true" : "false";
        if (value instanceof Lite)
            return `'${String(value.id)}'`;
        if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime)
            return value.toString();
        return String(value);
    }

    /** The `$filter` half (Contains conditions are dropped; see the header). */
    getFilters(filters: Filter[]): string | null {
        return combined(filters.map(f => this.toFilter(f)), FilterGroupOperationKeys.And);
    }

    /** One filter as an OData `$filter` clause. */
    toFilter(f: Filter): string | null {
        if (f instanceof FilterCondition) {
            if (f.operation === FilterOperationKeys.Contains)
                return null; // handled by $search

            const field = this.toGraphField(f.token, GraphFieldUsage.Filter);

            switch (f.operation) {
                case FilterOperationKeys.IsIn:
                    return "(" + (f.value as unknown[]).map(a => `${field} eq ${this.toStringValue(a)}`).join(" OR ") + ")";
                case FilterOperationKeys.IsNotIn:
                    return "not (" + (f.value as unknown[]).map(a => `${field} eq ${this.toStringValue(a)}`).join(" OR ") + ")";
                // There is no Like operation to reject, but there is the
                // full-text ones, which Graph cannot express either — so they are what gets rejected.
                case FilterOperationKeys.FreeText:
                case FilterOperationKeys.ComplexCondition:
                case FilterOperationKeys.TsQuery:
                case FilterOperationKeys.TsQuery_Plain:
                case FilterOperationKeys.TsQuery_Phrase:
                case FilterOperationKeys.TsQuery_WebSearch:
                    throw new Error(AzureADMessage._0IsNotImplementedInMicrosoftGraph.niceToString(f.operation));
                default:
                    break;
            }

            return this.buildCondition(field, f.operation, this.toStringValue(f.value));
        }

        if (f instanceof FilterGroup)
            return combined(f.filters.map(f2 => this.toFilter(f2)), f.groupOperation);

        throw new Error(`Unexpected filter ${String(f)}`);
    }

    /** One field / operation / value triple as OData. */
    buildCondition(field: string, operation: FilterOperationKeys, value: string): string | null {
        switch (operation) {
            case FilterOperationKeys.EqualTo: return `${field} eq ${value}`;
            case FilterOperationKeys.DistinctTo: return `${field} ne ${value}`;
            case FilterOperationKeys.GreaterThan: return `${field} gt ${value}`;
            case FilterOperationKeys.GreaterThanOrEqual: return `${field} ge ${value}`;
            case FilterOperationKeys.LessThan: return `${field} lt ${value}`;
            case FilterOperationKeys.LessThanOrEqual: return `${field} le ${value}`;
            case FilterOperationKeys.Contains: return null;
            case FilterOperationKeys.NotContains: return `NOT (${field}:${value})`;
            case FilterOperationKeys.StartsWith: return `startswith(${field},${value})`;
            case FilterOperationKeys.EndsWith: return `endswith(${field},${value})`;
            case FilterOperationKeys.NotStartsWith: return `not startswith(${field},${value})`;
            case FilterOperationKeys.NotEndsWith: return `not endswith(${field},${value})`;
            default: throw new Error(`Unexpected operation ${String(operation)}`);
        }
    }

    /** The `$search` half (only Contains conditions). */
    getSearch(filters: Filter[]): string | null {
        return combined(filters.map(f => this.toSearch(f)), FilterGroupOperationKeys.And);
    }

    /** One filter as a `$search` term. */
    toSearch(f: Filter): string | null {
        if (f instanceof FilterCondition) {
            return f.operation === FilterOperationKeys.Contains
                ? `"${this.toGraphField(f.token, GraphFieldUsage.Search)}:${String(f.value ?? "").replace(/"/g, '\\"')}"`
                : null;
        }

        if (f instanceof FilterGroup)
            return combined(f.filters.map(f2 => this.toSearch(f2)), f.groupOperation);

        throw new Error(`Unexpected filter ${String(f)}`);
    }

    /** The `$select` parameter — only the fields the request's columns need. */
    getSelect(columns: Column[]): string[] | null {
        const fields = columns
            .map(c => this.toGraphField(c.token, GraphFieldUsage.Select))
            .filter(f => f !== "");
        return fields.length === 0 ? null : [...new Set(fields)];
    }

    /**
     * The `$top` parameter. Note it asks for `elementsPerPage * currentPage` rows and then SKIPs locally
     * (Graph's paging is cursor-based, so there is no `$skip` for directory objects).
     */
    getTop(pagination: Pagination): number | null {
        if (pagination instanceof Pagination.All)
            return null;
        if (pagination instanceof Pagination.Firsts)
            return pagination.topElements;
        if (pagination instanceof Pagination.Paginate)
            return pagination.elementsPerPage * pagination.currentPage;
        throw new Error(`Unexpected pagination ${String(pagination)}`);
    }
}

/**
 * Combine two OData clauses. AND simply drops the nulls (a Contains condition
 * lives in `$search` instead); OR cannot, because half a group in `$filter` and half in `$search` is not
 * expressible — so a null inside an OR is an error.
 */
function combined(values: (string | null)[], groupOperation: FilterGroupOperationKeys): string | null {
    const clean = values.filter((v): v is string => v != null);

    if (clean.length === 0)
        return null;

    if (groupOperation === FilterGroupOperationKeys.And)
        return clean.join(" AND ");

    if (clean.length !== values.length)
        throw new Error(AzureADMessage.UnableToMixFilterAndSearchInAnOr.niceToString());

    return clean.length === 1 ? clean[0]! : "(" + clean.join(" OR ") + ")";
}
