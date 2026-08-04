// Ported from Signum.React/FindOptions.ts — copy-paste + fix. altea-required fixes only:
//   - imports retargeted (Reflection / entities / dynamicQueries / QueryToken); Signum.* modules gone.
//   - real altea enums → string-literal comparisons/returns/records swept to enum MEMBERS.
//   - ModifiableEntity → BaseEntity (altea has no ModifiableEntity).
//   - QueryToken is altea's class: no `queryTokenType`/`propertyRoute` string fields — getFilterOperations
//     reads getPropertyRoute() (full-text prepend dropped; altea FieldInfo has no full-text flag yet).
//   - unused Signum imports (getLambdaMembers / TypeInfo / message enums / Lines) dropped.

import * as React from "react";
import { QueryKey, type PseudoType } from './Reflection';
import { TypeReference } from '../data/reflection';
import { Entity, EmbeddedEntity, type Type } from '../data/entity';
import { QueryTokenString } from './QueryTokenString';
import type { Lite } from '../data/lite';
import type { BaseEntity } from '../data/entity';
import type {
  PaginationMode, OrderType, FilterOperation, ColumnOptionsMode, UniqueType,
  FilterGroupOperation, PinnedFilterActive, DashboardBehaviour, CombineRows, FilterType,
} from '../data/dynamicQueries';
import type { BsSize } from './Components';
import { QueryToken } from './QueryToken';
import { EntityPropertyToken } from '../data/dynamicQuery/tokens';
// The DynamicQuery wire DTOs live in entities/dynamicQuery/queryRequest.ts (shared client/server);
// consumers import them from there directly. FindOptions uses a few (FilterRequest, Pagination, …) in
// its own signatures below.
import type {
  FilterRequest, FilterGroupRequest, FilterConditionRequest, Pagination, SystemTime,
} from '../data/dynamicQuery/queryRequest';
import type { SearchControlProps } from "./SearchControl/SearchControl";
import type SearchControlLoaded from "./SearchControl/SearchControlLoaded";

export type { PaginationMode, OrderType, FilterOperation, FilterType, ColumnOptionsMode, UniqueType };

export interface ValueFindOptions {
  queryName: PseudoType | QueryKey;
  filterOptions?: FilterOption[];
}

export interface ValueFindOptionsParsed {
  queryKey: string;
  filterOptions: FilterOptionParsed;
}

export interface ModalFindOptionsMany extends ModalFindOptions {
  allowNoSelection?: boolean;
}

export interface ModalFindOptions {
  title?: React.ReactNode;
  message?: React.ReactNode;
  forProperty?: string;
  useDefaultBehaviour?: boolean;
  autoSelectIfOne?: boolean;
  autoSkipIfZero?: boolean;
  autoCheckSingleRowResult?: boolean;
  modalSize?: BsSize;
  searchControlProps?: Partial<SearchControlProps>;
  onOKClicked?: (sc: SearchControlLoaded) => Promise<boolean>;
}

export type OptionalQueryName<T extends { queryName: unknown }> =
  Omit<T, "queryName"> & Partial<Pick<T, "queryName">>;

export interface FindOptions<T extends BaseEntity /*Entity*/ = any> {
  queryName: Type<T> | QueryKey | PseudoType;
  groupResults?: boolean;

  includeDefaultFilters?: boolean;
  filterOptions?: (FilterOption | null | undefined)[];
  orderOptions?: (OrderOption | null | undefined)[];
  columnOptionsMode?: ColumnOptionsMode;
  columnOptions?: (ColumnOption | QueryTokenString<any> | null | undefined)[];
  pagination?: Pagination;
  systemTime?: SystemTime;
}

export interface FetchOptions<T extends BaseEntity /*Entity*/> {
  queryName: Type<T> | QueryKey | PseudoType;
  filterOptions?: (FilterOption | null | undefined)[];
  orderOptions?: (OrderOption | null | undefined)[];
  count?: number | null;
}

/** Column tokens for a typed result, keyed by the field name each produces in the returned row. */
export interface ResultObject {
  [name: string]: QueryTokenString<any> | string | ResultObject | undefined;
}

/** Like {@link FindOptions} but the columns come from `resultObject` (no columnOptions); built by `Type.typedResultsOptions`. */
export interface TypedResultsOptions<RO extends ResultObject = ResultObject> {
  queryName: PseudoType | QueryKey;
  groupResults?: boolean;
  includeDefaultFilters?: boolean;
  filterOptions?: (FilterOption | null | undefined)[];
  orderOptions?: (OrderOption | null | undefined)[];
  pagination?: Pagination;
  systemTime?: SystemTime;
  resultObject: RO;
}

/** Normalizes a bare {@link QueryTokenString} (accepted in `columnOptions`) into a {@link ColumnOption}. */
export function toColumnOption(co: ColumnOption | QueryTokenString<any>): ColumnOption {
  return co instanceof QueryTokenString ? { token: co } : co;
}

export interface FindOptionsParsed {
  queryKey: string;
  groupResults: boolean;
  filterOptions: FilterOptionParsed[];
  orderOptions: OrderOptionParsed[];
  columnOptions: ColumnOptionParsed[];
  pagination: Pagination;
  systemTime?: SystemTime;
}


export type FilterOption = FilterConditionOption | FilterGroupOption;

export function isFilterGroup(fo: FilterOptionParsed): fo is FilterGroupOptionParsed
export function isFilterGroup(fo: FilterOption): fo is FilterGroupOption
export function isFilterGroup(fr: FilterRequest): fr is FilterGroupRequest
export function isFilterGroup(fo: FilterOption | FilterOptionParsed | FilterRequest): boolean {
  return (fo as FilterGroupOptionParsed | FilterGroupOption | FilterGroupRequest).groupOperation != undefined;
}

export function isFilterCondition(fo: FilterOptionParsed): fo is FilterConditionOptionParsed
export function isFilterCondition(fo: FilterOption): fo is FilterConditionOption
export function isFilterCondition(fr: FilterRequest): fr is FilterConditionRequest
export function isFilterCondition(fo: FilterOptionParsed | FilterOption | FilterRequest): boolean {
  return (fo as FilterGroupOptionParsed | FilterGroupOption | FilterGroupRequest).groupOperation == undefined;
}


export interface FilterConditionOption {
  token: string | QueryTokenString<any>;
  frozen?: boolean;
  removeElementWarning?: boolean;
  operation?: FilterOperation;
  value?: any;
  pinned?: PinnedFilter;
  dashboardBehaviour?: DashboardBehaviour;
}

export interface FilterGroupOption {
  token?: string | QueryTokenString<any>;
  groupOperation: FilterGroupOperation;
  filters: (FilterOption | null | undefined)[];
  pinned?: PinnedFilter;
  frozen?: boolean;
  dashboardBehaviour?: DashboardBehaviour;
  value?: any; /*For search in multiple columns*/
}

export interface PinnedFilter {
  label?: (() => string) | string;
  row?: number;
  column?: number;
  colSpan?: number;
  active?: PinnedFilterActive;
  splitValue?: boolean;
}

export type FilterOptionParsed = FilterConditionOptionParsed | FilterGroupOptionParsed;



export function isActive(fo: FilterOptionParsed | FilterOption): boolean {
  return !(fo.dashboardBehaviour == "UseAsInitialSelection" ||
    fo.pinned &&
    (fo.pinned.active == "Checkbox_Unchecked" ||
      fo.pinned.active == "NotCheckbox_Unchecked" ||
      fo.pinned.active == "WhenHasValue" && fo.value == null ||
      fo.pinned.splitValue && (fo.value == null || fo.value === "" || Array.isArray(fo.value) && fo.value.length == 0)));
}

export function isCheckBox(active: PinnedFilterActive | undefined): boolean {
  return active == "Checkbox_Checked" ||
    active == "Checkbox_Unchecked" ||
    active == "NotCheckbox_Checked" ||
    active == "NotCheckbox_Unchecked";
}

export interface FilterConditionOptionParsed {
  token?: QueryToken;
  frozen: boolean;
  removeElementWarning?: boolean;
  operation?: FilterOperation;
  value: any;
  pinned?: PinnedFilterParsed;
  dashboardBehaviour?: DashboardBehaviour;
}

export interface PinnedFilterParsed {
  label?: string;
  row?: number;
  column?: number;
  colSpan?: number;
  active?: PinnedFilterActive;
  splitValue?: boolean;
}

export function toPinnedFilterParsed(pf: PinnedFilter): PinnedFilterParsed {
  return {
    label: typeof pf.label == "function" ? pf.label() : pf.label,
    column: pf.column,
    colSpan: pf.colSpan,
    row: pf.row,
    active: pf.active,
    splitValue: pf.splitValue
  };
}

export interface FilterGroupOptionParsed {
  groupOperation: FilterGroupOperation;
  frozen: boolean;
  token?: QueryToken;
  filters: FilterOptionParsed[];
  pinned?: PinnedFilterParsed;
  dashboardBehaviour?: DashboardBehaviour;
  value?: any; /*For search in multiple columns*/
}

export interface OrderOption {
  token: string | QueryTokenString<any>;
  orderType: OrderType;
}

export interface OrderOptionParsed {
  token: QueryToken;
  orderType: OrderType;
}

export interface ColumnOption {
  token: string | QueryTokenString<any>;
  displayName?: string | (() => string);
  summaryToken?: string | QueryTokenString<any>;
  hiddenColumn?: boolean;
  combineRows?: CombineRows;
}

/** Extra pinned / frozen state for the {@link QueryTokenString.filter} builder method. */
export interface ExtraFilterConditionOptions {
  frozen?: boolean;
  removeElementWarning?: boolean;
  pinned?: PinnedFilter;
  dashboardBehaviour?: DashboardBehaviour;
}

/** Extra pinned / frozen state for the `filterGroup` builder methods. */
export interface ExtraFilterGroupOptions {
  frozen?: boolean;
  pinned?: PinnedFilter;
  dashboardBehaviour?: DashboardBehaviour;
  value?: any; /*For search in multiple columns*/
}

/** Extra summary / display state for the {@link QueryTokenString.column} builder method. */
export interface ColumnDisplayOptions {
  displayName?: string | (() => string)
  summaryToken?: string | QueryTokenString<any>;
  hiddenColumn?: boolean;
  combineRows?: CombineRows;
}

export interface ColumnOptionParsed {
  token?: QueryToken;
  displayName?: string;
  summaryToken?: QueryToken;
  hiddenColumn?: boolean;
  combineRows?: CombineRows;
}

export const DefaultPagination: Pagination = {
  mode: "Paginate",
  elementsPerPage: 20,
  currentPage: 1
};


export type FindMode = "Find" | "Explore";


// ALTEA: Signum's QueryTokenWithoutParent / QueryDescriptionDTO (a serialized token TREE sent from
// the server) are dropped — altea's QueryToken is a class whose `subTokens` is a METHOD (generated
// locally on the client), incompatible with a property-map DTO, and the client no longer receives the
// whole tree (it builds the root locally and fetches only server-only tokens via QueryClient).

export function withoutAggregate(fop: FilterOptionParsed): FilterOptionParsed | undefined {

  if (fop.token?.hasAggregate())
    return undefined;

  if (isFilterGroup(fop)) {
    var newFilters = fop.filters.map(f => withoutAggregate(f)).filter(Boolean);
    if (newFilters.length == 0)
      return undefined;
    return ({
      ...fop,
      filters: newFilters,
    }) as FilterOptionParsed;
  };

  return {
    ...fop,
  };
}

export function withoutPinned(fop: FilterOptionParsed): FilterOptionParsed | undefined {

  if (!isActive(fop)) {
    return undefined;
  }

  if (fop.value != null && (fop.pinned && fop.pinned.splitValue || isFilterGroup(fop)))
    return fop; //otherwise change meaning

  if (isFilterGroup(fop)) {
    var newFilters = fop.filters.map(f => withoutPinned(f)).filter(Boolean);
    if (newFilters.length == 0)
      return undefined;

    return ({
      ...fop,
      filters: newFilters,
      pinned: undefined,
    }) as FilterOptionParsed;
  };

  return {
    ...fop,
    pinned: undefined
  };
}

export function canSplitValue(fo: FilterOptionParsed): boolean | undefined {
  if (isFilterGroup(fo))
    return fo.pinned != null;

  else {
    return fo.operation && isList(fo.operation) && fo.token?.hasAny() ||
      fo.token && fo.token.filterType == "String";
  }
}

export function mapFilterTokens(fo: FilterOption, mapToken: (token: string) => string): FilterOption {

  if (isFilterGroup(fo)) {
    return {
      ...fo,
      groupOperation: fo.groupOperation,
      filters: fo.filters.map(f => f && mapFilterTokens(f, mapToken)),
      token: fo.token && mapToken(fo.token.toString())
    };
  }
  else {
    return {
      ...fo,
      token: fo.token && mapToken(fo.token.toString()),
    }
  }
}


// FilterRequest / FilterGroupRequest / FilterConditionRequest / OrderRequest / ColumnRequest /
// QueryEntitiesRequest / QueryRequest / AggregateType / QueryValueRequest / ResultTable / ResultRow /
// Pagination / SystemTime moved to entities/dynamicQuery/queryRequest.ts (re-exported above).

export namespace PaginateMath {
  export function startElementIndex(p: Pagination): number {
    return (p.elementsPerPage! * (p.currentPage! - 1)) + 1;
  }

  export function endElementIndex(p: Pagination, rows: number): number {
    return startElementIndex(p) + rows - 1;
  }

  export function totalPages(p: Pagination, totalElements: number): number {
    return Math.max(1, Math.ceil(totalElements / p.elementsPerPage!)); //Round up
  }

  export function maxElementIndex(p: Pagination): number {
    return (p.elementsPerPage! * (p.currentPage! + 1)) - 1;
  }
}


export function isList(fo: FilterOperation): boolean {
  return fo == "IsIn" ||
    fo == "IsNotIn";
}

export function isPair(fo: FilterOperation): boolean {
  return fo == "Between" || fo == "BetweenNoEnd";
}

export function isGroupList(fo: Pick<FilterGroupOption | FilterGroupOptionParsed, 'filters'>): boolean {
  return fo.filters.some(f => f != null && isFilterCondition(f as FilterOptionParsed) &&
    (f as FilterConditionOptionParsed).operation != null &&
    isList((f as FilterConditionOptionParsed).operation!));
}



// The full-text filter operations offered on a full-text-indexed column (Signum's FindOptions
// full-text set): SQL Server FreeText / ComplexCondition (CONTAINS) and Postgres TsQuery*. All are
// offered; the server applies the ones valid for its dialect.
const fullTextOperations: FilterOperation[] = [
  "ComplexCondition", "FreeText", "TsQuery", "TsQuery_Plain", "TsQuery_Phrase", "TsQuery_WebSearch",
];

export function getFilterOperations(qt: QueryToken): FilterOperation[] {

  if (qt.filterType == null)
    return [];

  // A full-text-indexed column also offers the full-text operations (Signum gated this on
  // pr.member.hasFullTextIndex). The flag is set isomorphically by the @fullTextIndex decorator.
  if (qt instanceof EntityPropertyToken && qt.fieldInfo?.hasFullTextIndex)
    return [...fullTextOperations, ...filterOperations[qt.filterType]];

  return filterOperations[qt.filterType];
}

// ALTEA: a query column's type is a TypeReference. Number/String/Boolean/Guid unify to the "String"
// group; a plain-value TypeReference has a `typeName`, references resolve via is()/lite/getEnum.
export function getFilterGroupUnifiedFilterType(tr: TypeReference): FilterType | null {
  if (tr.getEnum() != undefined)
    return "Enum";

  if (tr.lite || tr.is(Entity))
    return "Lite";

  if (tr.is(EmbeddedEntity))
    return "Embedded";

  switch (tr.typeName) {
    case "Number": case "Decimal": case "String": case "Boolean": case "Guid":
      return "String";
    case "PlainDate": case "PlainDateTime":
      return "DateTime";
  }

  return null;
}

export const filterOperations: Record<FilterType, FilterOperation[]> = {
  ["String"]: [
    "Contains",
    "EqualTo",
    "StartsWith",
    "EndsWith",
    "Like",
    "NotContains",
    "DistinctTo",
    "NotStartsWith",
    "NotEndsWith",
    "NotLike",
    "IsIn",
    "IsNotIn"
  ],

  ["DateTime"]: [
    "EqualTo",
    "DistinctTo",
    "GreaterThan",
    "GreaterThanOrEqual",
    "LessThan",
    "LessThanOrEqual",
    "Between",
    "BetweenNoEnd",
    "IsIn",
    "IsNotIn"
  ],

  ["Time"]: [
    "EqualTo",
    "DistinctTo",
    "GreaterThan",
    "GreaterThanOrEqual",
    "LessThan",
    "LessThanOrEqual",
    "IsIn",
    "IsNotIn"
  ],

  ["Integer"]: [
    "EqualTo",
    "DistinctTo",
    "GreaterThan",
    "GreaterThanOrEqual",
    "LessThan",
    "LessThanOrEqual",
    "IsIn",
    "IsNotIn"
  ],

  ["Decimal"]: [
    "EqualTo",
    "DistinctTo",
    "GreaterThan",
    "GreaterThanOrEqual",
    "LessThan",
    "LessThanOrEqual",
    "IsIn",
    "IsNotIn"
  ],

  ["Enum"]: [
    "EqualTo",
    "DistinctTo",
    "GreaterThan",
    "GreaterThanOrEqual",
    "LessThan",
    "LessThanOrEqual",
    "IsIn",
    "IsNotIn",
  ],

  ["Guid"]: [
    "EqualTo",
    "DistinctTo",
    "IsIn",
    "IsNotIn"
  ],

  ["Lite"]: [
    "EqualTo",
    "DistinctTo",
    "IsIn",
    "IsNotIn"
  ],

  ["Embedded"]: [
    "EqualTo",
    "DistinctTo",
  ],

  ["Model"]: [
    "EqualTo",
    "DistinctTo",
  ],

  ["Boolean"]: [
    "EqualTo",
    "DistinctTo",
  ],
  ["TsVector"]: [
    "TsQuery",
    "TsQuery_Plain",
    "TsQuery_Phrase",
    "TsQuery_WebSearch",
  ],

  ["Vector"]: [
    "SmartSearch",
  ]
};
