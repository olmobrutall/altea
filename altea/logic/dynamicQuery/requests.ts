import { Expression, BinaryExpression, ConstantExpression, PropertyExpression, CallExpression } from "../linq/expressions";
import { LiteralType } from "../../entities/runtimeTypes";
import type { Implementations } from "../../entities/implementations";
import type { RuntimeType } from "../../entities/runtimeTypes";
import { QueryToken, BuildExpressionContext } from "./tokens/queryToken";
import { CollectionElementToken } from "./tokens/collectionElementToken";
import type { QueryName } from "./queryUtils";

// Port of Signum's DynamicQuery request model (DynamicQuery/Requests/*.cs): the filter / order /
// column / pagination descriptors that drive a query, plus the top-level QueryRequest. These are
// user-facing (an app builds a QueryRequest, or calls DQueryable.where/orderBy/select directly).

// ---- Filter (Requests/Filter.cs) -----------------------------------------------------------

export enum FilterOperation {
    EqualTo = "EqualTo",
    DistinctTo = "DistinctTo",
    GreaterThan = "GreaterThan",
    GreaterThanOrEqual = "GreaterThanOrEqual",
    LessThan = "LessThan",
    LessThanOrEqual = "LessThanOrEqual",
    Contains = "Contains",
    StartsWith = "StartsWith",
    EndsWith = "EndsWith",
    NotContains = "NotContains",
    NotStartsWith = "NotStartsWith",
    NotEndsWith = "NotEndsWith",
    IsIn = "IsIn",
    IsNotIn = "IsNotIn",
}

const BINARY_OP: Partial<Record<FilterOperation, "==" | "!=" | ">" | ">=" | "<" | "<=">> = {
    [FilterOperation.EqualTo]: "==",
    [FilterOperation.DistinctTo]: "!=",
    [FilterOperation.GreaterThan]: ">",
    [FilterOperation.GreaterThanOrEqual]: ">=",
    [FilterOperation.LessThan]: "<",
    [FilterOperation.LessThanOrEqual]: "<=",
};
const STRING_METHOD: Partial<Record<FilterOperation, { method: string; negate: boolean }>> = {
    [FilterOperation.Contains]: { method: "includes", negate: false },
    [FilterOperation.StartsWith]: { method: "startsWith", negate: false },
    [FilterOperation.EndsWith]: { method: "endsWith", negate: false },
    [FilterOperation.NotContains]: { method: "includes", negate: true },
    [FilterOperation.NotStartsWith]: { method: "startsWith", negate: true },
    [FilterOperation.NotEndsWith]: { method: "endsWith", negate: true },
};

// Port of Signum's `Filter` (abstract). Only `FilterCondition` is ported; `FilterGroup` (and full
// text) are TODO.
export abstract class Filter {
    abstract getExpression(context: BuildExpressionContext): Expression;
    abstract getTokens(): QueryToken[];
    // The deepest CollectionNested token, if any (drives nested-query filtering). Not modelled yet.
    getDeepestNestedToken(): QueryToken | undefined { return undefined; }
}

// Port of Signum's `FilterCondition`: a token compared to a value.
export class FilterCondition extends Filter {
    constructor(
        public readonly token: QueryToken,
        public readonly operation: FilterOperation,
        public readonly value: unknown,
    ) { super(); }

    getTokens(): QueryToken[] { return [this.token]; }

    getExpression(context: BuildExpressionContext): Expression {
        const left = this.token.buildExpression(context);

        const binOp = BINARY_OP[this.operation];
        if (binOp != undefined)
            return new BinaryExpression(binOp, left, new ConstantExpression(this.value));

        const sm = STRING_METHOD[this.operation];
        if (sm != undefined) {
            const call = new CallExpression(new PropertyExpression(left, sm.method), [new ConstantExpression(this.value)], LiteralType.boolean);
            return sm.negate ? new BinaryExpression("==", call, new ConstantExpression(false)) : call;
        }

        if (this.operation === FilterOperation.IsIn || this.operation === FilterOperation.IsNotIn) {
            const call = new CallExpression(new PropertyExpression(new ConstantExpression(this.value), "includes"), [left], LiteralType.boolean);
            return this.operation === FilterOperation.IsNotIn ? new BinaryExpression("==", call, new ConstantExpression(false)) : call;
        }

        throw new Error(`FilterOperation ${this.operation} not supported yet`);
    }
}

// ---- Order (Requests/Order.cs) -------------------------------------------------------------

export enum OrderType { Ascending = "Ascending", Descending = "Descending" }

export class Order {
    constructor(public readonly token: QueryToken, public readonly orderType: OrderType = OrderType.Ascending) { }
}

// ---- Column (Requests/Column.cs) -----------------------------------------------------------

export class Column {
    constructor(public readonly token: QueryToken, public displayName?: string) { }

    get name(): string { return this.token.fullKey(); }
    get type(): RuntimeType { return this.token.type; }
    get implementations(): Implementations | undefined { return this.token.getImplementations(); }
    get format(): string | undefined { return this.token.format; }
    get unit(): string | undefined { return this.token.unit; }
}

// ---- Pagination (Requests/QueryRequest.cs) -------------------------------------------------

export enum PaginationMode { All = "All", Firsts = "Firsts", Paginate = "Paginate" }

export abstract class Pagination {
    abstract getMode(): PaginationMode;
    abstract getElementsPerPage(): number | undefined;
}
export namespace Pagination {
    export class All extends Pagination {
        getMode(): PaginationMode { return PaginationMode.All; }
        getElementsPerPage(): number | undefined { return undefined; }
    }
    export class Firsts extends Pagination {
        constructor(public readonly topElements: number) { super(); }
        getMode(): PaginationMode { return PaginationMode.Firsts; }
        getElementsPerPage(): number { return this.topElements; }
    }
    export class Paginate extends Pagination {
        constructor(public readonly elementsPerPage: number, public readonly currentPage: number = 1) { super(); }
        getMode(): PaginationMode { return PaginationMode.Paginate; }
        getElementsPerPage(): number { return this.elementsPerPage; }
        // 0-based OFFSET (Signum's StartElementIndex is 1-based; altea's skip is a 0-based OFFSET).
        skip(): number { return this.elementsPerPage * (this.currentPage - 1); }
    }
}

// ---- QueryRequest (Requests/QueryRequest.cs) -----------------------------------------------

export class QueryRequest {
    constructor(
        public queryName: QueryName,
        public filters: Filter[] = [],
        public orders: Order[] = [],
        public columns: Column[] = [],
        public pagination: Pagination = new Pagination.All(),
    ) { }

    // Signum's QueryRequest.Multiplications: the collection-element tokens reachable from all
    // referenced tokens (drives DQueryable.SelectMany).
    multiplications(): CollectionElementToken[] {
        const all: QueryToken[] = [
            ...this.columns.map(c => c.token),
            ...this.orders.map(o => o.token),
            ...this.filters.flatMap(f => f.getTokens()),
        ];
        const seen = new Map<string, CollectionElementToken>();
        for (const t of all)
            for (let p: QueryToken | undefined = t; p != undefined; p = p.parent)
                if (p instanceof CollectionElementToken)
                    seen.set(p.fullKey(), p);
        return [...seen.values()].sort((a, b) => a.fullKey().length - b.fullKey().length);
    }
}
