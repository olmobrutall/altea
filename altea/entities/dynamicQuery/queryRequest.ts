// The DynamicQuery WIRE DTOs (Signum's request/response contract from Signum.DynamicQuery/*.cs +
// FindOptions.ts). Plain data shapes a query request/response takes on the wire, shared by the client
// (react/Finder builds them) and the server controller boundary — so they live in entities/ where
// both layers can name the same shapes without react↔logic coupling.
//
// Distinct from logic/dynamicQuery's engine model (Filter/Order/Column classes, the ResultTable
// class, the SystemTime class hierarchy): those are the server's internal OO representation; these
// are the serialized contract. Values use the string-union enum forms (see dynamicQueries.ts).

import type { Lite } from '../lite';
import type { Entity } from '../entity';
import type {
  FilterOperation, FilterGroupOperation, OrderType, PaginationMode,
  SystemTimeMode, SystemTimeJoinMode, TimeSeriesUnit,
} from '../dynamicQueries';

export type FilterRequest = FilterConditionRequest | FilterGroupRequest;

export interface FilterGroupRequest {
  groupOperation: FilterGroupOperation;
  token?: string;
  filters: FilterRequest[];
}

export interface FilterConditionRequest {
  token: string;
  operation: FilterOperation;
  value: any;
}

export interface OrderRequest {
  token: string;
  orderType: OrderType
}

export interface ColumnRequest {
  token: string;
  displayName: string;
}

export interface QueryEntitiesRequest {
  queryKey: string;
  filters: FilterRequest[];
  orders: OrderRequest[];
  count: number | null;
}

export interface QueryRequest {
  queryKey: string;
  groupResults: boolean;
  filters: FilterRequest[];
  orders: OrderRequest[];
  columns: ColumnRequest[];
  pagination: Pagination;
  systemTime?: SystemTime;
}

export type AggregateType = "Count" | "Average" | "Sum" | "Min" | "Max";

export interface QueryValueRequest {
  queryKey: string;
  filters: FilterRequest[];
  multipleValues?: boolean;
  valueToken?: string;
  systemTime?: SystemTime;
}

export interface ResultTable {
  columns: string[];
  uniqueValues: { [token: string]: any[] }
  rows: ResultRow[];
  pagination: Pagination
  totalElements?: number;
}

export interface ResultRow {
  entity: Lite<Entity> | undefined;
  columns: any[];
}

export interface Pagination {
  mode: PaginationMode;
  elementsPerPage?: number;
  currentPage?: number;
}

export interface SystemTime {
  mode: SystemTimeMode;
  joinMode?: SystemTimeJoinMode;
  startDate?: string;
  splitQueries?: boolean;
  endDate?: string;
  timeSeriesUnit?: TimeSeriesUnit;
  timeSeriesStep?: number;
  timeSeriesMaxRowsPerStep?: number;
}
