import type { QueryTokenString } from './queryTokenString';
import type {
    FilterOperationKeys, FilterGroupOperationKeys, OrderTypeKeys, CombineRowsKeys,
    DashboardBehaviourKeys, PinnedFilterActiveKeys,
} from '../dynamicQueries';

// The UNPARSED half of Signum.React/FindOptions.ts — how a filter, an order and a column are WRITTEN
// (a token plus literal values), before a query description has resolved the token into a QueryToken.
//
// In DATA rather than client, with the parsed halves (`FilterOptionParsed`, `QueryToken`, the
// SearchControl props) staying where they are: these are the shapes a user query is stored as, a server
// executes a stored one from, and a test builds a search with — none of which is UI. They travel with
// {@link QueryTokenString}, whose builder methods produce them.

export type FilterOption = FilterConditionOption | FilterGroupOption;

export interface FilterConditionOption {
    token: string | QueryTokenString<any>;
    frozen?: boolean;
    removeElementWarning?: boolean;
    operation?: FilterOperationKeys;
    value?: any;
    pinned?: PinnedFilter;
    dashboardBehaviour?: DashboardBehaviourKeys;
}

export interface FilterGroupOption {
    token?: string | QueryTokenString<any>;
    groupOperation: FilterGroupOperationKeys;
    filters: (FilterOption | null | undefined)[];
    pinned?: PinnedFilter;
    frozen?: boolean;
    dashboardBehaviour?: DashboardBehaviourKeys;
    value?: any; /*For search in multiple columns*/
}

export interface PinnedFilter {
    label?: (() => string) | string;
    row?: number;
    column?: number;
    colSpan?: number;
    active?: PinnedFilterActiveKeys;
    splitValue?: boolean;
}

export interface OrderOption {
    token: string | QueryTokenString<any>;
    orderType: OrderTypeKeys;
}

export interface ColumnOption {
    token: string | QueryTokenString<any>;
    displayName?: string | (() => string);
    summaryToken?: string | QueryTokenString<any>;
    hiddenColumn?: boolean;
    combineRows?: CombineRowsKeys;
}

/** Extra pinned / frozen state for the {@link QueryTokenString.filter} builder method. */
export interface ExtraFilterConditionOptions {
    frozen?: boolean;
    removeElementWarning?: boolean;
    pinned?: PinnedFilter;
    dashboardBehaviour?: DashboardBehaviourKeys;
}

/** Extra pinned / frozen state for the `filterGroup` builder methods. */
export interface ExtraFilterGroupOptions {
    frozen?: boolean;
    pinned?: PinnedFilter;
    dashboardBehaviour?: DashboardBehaviourKeys;
    value?: any; /*For search in multiple columns*/
}

/** Extra summary / display state for the {@link QueryTokenString.column} builder method. */
export interface ColumnDisplayOptions {
    displayName?: string | (() => string)
    summaryToken?: string | QueryTokenString<any>;
    hiddenColumn?: boolean;
    combineRows?: CombineRowsKeys;
}
