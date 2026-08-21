import type { BaseEntity } from "@altea/altea/data/entity";
import type {
    FindOptions, FilterOption, OrderOption, ColumnOption,
} from "@altea/altea/client/FindOptions";
import type { Pagination } from "@altea/altea/data/dynamicQuery/queryRequest";
import {
    ColumnOptionsModeEnum, FilterOperationEnum, OrderTypeEnum, PaginationModeEnum,
    type ColumnOptionsMode, type FilterOperation, type OrderType, type PaginationMode,
} from "@altea/altea/data/dynamicQueries";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { QueryToken } from "@altea/altea/client/QueryToken";
import type { ExpressionOrValue } from "./NodeUtils";
import * as NodeUtils from "./NodeUtils";

// Port of Signum.Dynamic's View/FindOptionsExpression.tsx — verbatim: the stored, EXPRESSION-capable twin of
// a `FindOptions`, and the function that resolves it against a live context so a SearchControl node can be
// pointed at a query whose filters depend on the entity being shown.
//
// altea divergence: Signum's enums are `EnumType` objects with a `.values()` method; altea's are numeric
// enum objects whose runtime value is the member NAME (see CLAUDE.md), so the validators go through
// `NodeUtils.isEnumOrNull(value, SomeEnum)` which reads `Enum.values(...)`.
export interface FindOptionsExpr {
    queryName?: string;
    parentToken?: string;

    filterOptions?: FilterOptionExpr[];
    includeDefaultFilters?: boolean;
    orderOptions?: OrderOptionExpr[];
    columnOptionsMode?: ExpressionOrValue<ColumnOptionsMode>;
    columnOptions?: ColumnOptionExpr[];
    paginationMode?: PaginationMode;
    elementsPerPage?: ExpressionOrValue<number>;
    currentPage?: ExpressionOrValue<number>;
}

export interface FilterOptionExpr {
    token?: string;
    parsedToken?: QueryToken;
    operation?: ExpressionOrValue<FilterOperation>;
    value: ExpressionOrValue<unknown>;
    frozen?: ExpressionOrValue<boolean>;
    applicable: ExpressionOrValue<boolean>;
}

export interface OrderOptionExpr {
    token?: string;
    parsedToken?: QueryToken;
    orderType: ExpressionOrValue<OrderType>;
    applicable: ExpressionOrValue<boolean>;
}

export interface ColumnOptionExpr {
    token?: string;
    parsedToken?: QueryToken;
    displayName?: ExpressionOrValue<string>;
    applicable: ExpressionOrValue<boolean>;
}

export function toFindOptions(dn: unknown, ctx: TypeContext<BaseEntity>, foe: FindOptionsExpr): FindOptions {

    const paginationMode = NodeUtils.evaluateAndValidate(dn, ctx, foe, f => f.paginationMode,
        v => NodeUtils.isEnumOrNull(v, PaginationModeEnum));

    return {
        queryName: foe.queryName!,

        filterOptions: (foe.filterOptions ?? [])
            .filter(fo => NodeUtils.evaluateAndValidate(dn, ctx, fo, f => f.applicable, NodeUtils.isBooleanOrNull) !== false)
            .map(fo => ({
                token: fo.token,
                frozen: NodeUtils.evaluateAndValidate(dn, ctx, fo, f => f.frozen, NodeUtils.isBooleanOrNull),
                operation: NodeUtils.evaluateAndValidate(dn, ctx, fo, f => f.operation,
                    v => NodeUtils.isEnumOrNull(v, FilterOperationEnum)),
                value: NodeUtils.evaluate(dn, ctx, fo, f => f.value),
            } as FilterOption)),

        includeDefaultFilters: foe.includeDefaultFilters,

        orderOptions: foe.orderOptions
            ? foe.orderOptions
                .filter(oo => NodeUtils.evaluateAndValidate(dn, ctx, oo, o => o.applicable, NodeUtils.isBooleanOrNull) !== false)
                .map(oo => ({
                    token: oo.token,
                    orderType: NodeUtils.evaluateAndValidate(dn, ctx, oo, o => o.orderType,
                        v => NodeUtils.isEnumOrNull(v, OrderTypeEnum)),
                } as OrderOption))
            : undefined,

        columnOptionsMode: NodeUtils.evaluateAndValidate(dn, ctx, foe, f => f.columnOptionsMode,
            v => NodeUtils.isEnumOrNull(v, ColumnOptionsModeEnum)),

        columnOptions: foe.columnOptions
            ? foe.columnOptions
                .filter(co => NodeUtils.evaluateAndValidate(dn, ctx, co, c => c.applicable, NodeUtils.isBooleanOrNull) !== false)
                .map(co => ({
                    token: co.token,
                    displayName: NodeUtils.evaluateAndValidate(dn, ctx, co, c => c.displayName, NodeUtils.isStringOrNull),
                } as ColumnOption))
            : undefined,

        pagination: paginationMode
            ? {
                mode: paginationMode,
                currentPage: NodeUtils.evaluateAndValidate(dn, ctx, foe, f => f.currentPage, NodeUtils.isNumberOrNull),
                elementsPerPage: NodeUtils.evaluateAndValidate(dn, ctx, foe, f => f.elementsPerPage, NodeUtils.isNumberOrNull),
            } as Pagination
            : undefined,
    } as FindOptions;
}
