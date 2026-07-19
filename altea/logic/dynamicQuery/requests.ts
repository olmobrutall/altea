import { Expression, ParameterExpression, BinaryExpression, ConstantExpression, PropertyExpression, CallExpression } from "../linq/expressions";
import { LiteralType, ArrayType } from "../../entities/runtimeTypes";
import type { Implementations } from "../../entities/implementations";
import type { RuntimeType } from "../../entities/runtimeTypes";
import { QueryToken, BuildExpressionContext, ExpressionBox, buildLite } from "./tokens/queryToken";
import { CollectionElementToken } from "./tokens/collectionElementToken";
import { CollectionAnyAllToken } from "./tokens/collectionAnyAllToken";
import { AggregateToken } from "./tokens/aggregateToken";
import type { QueryName } from "./queryUtils";

// True if the token is an aggregate (or nested under one) — Signum's IsAggregate.
function tokenIsAggregate(token: QueryToken | undefined): boolean {
    for (let p = token; p != undefined; p = p.parent)
        if (p instanceof AggregateToken)
            return true;
    return false;
}

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
    // Signum's Filter.IsAggregate: whether this filter is a HAVING (applied after GroupBy).
    isAggregate(): boolean { return false; }
}

export enum FilterGroupOperation { And = "And", Or = "Or" }

// Port of Signum's `FilterGroup`: an AND/OR group of filters, optionally scoped to a `token`. When
// that token passes through a CollectionAnyAllToken, the whole group becomes a correlated
// `some`/`every` subquery — so element-level and outer-level conditions combine inside one
// quantifier (`a.friends.some(f => f.name == "john" && a.age == 20)`).
export class FilterGroup extends Filter {
    constructor(
        public readonly groupOperation: FilterGroupOperation,
        public readonly token: QueryToken | undefined,
        public readonly filters: Filter[],
    ) { super(); }

    getTokens(): QueryToken[] {
        return [...(this.token != undefined ? [this.token] : []), ...this.filters.flatMap(f => f.getTokens())];
    }

    override isAggregate(): boolean { return this.filters.some(f => f.isAggregate()); }

    getExpression(context: BuildExpressionContext): Expression {
        const anyAll = this.findAnyAll(context);
        if (anyAll == undefined) {
            const exprs = this.filters.map(f => f.getExpression(context));
            if (exprs.length === 0)
                return new ConstantExpression(this.groupOperation === FilterGroupOperation.And);
            const op = this.groupOperation === FilterGroupOperation.And ? "&&" : "||";
            return exprs.reduce((a, b) => new BinaryExpression(op, a, b));
        }
        return this.getExpressionWithAnyAll(context, anyAll);
    }

    // Signum's `Token?.Follow(Parent).OfType<CollectionAnyAllToken>().TakeWhile(not-bound).LastOrDefault()`
    // — the shallowest not-yet-bound quantifier in the group token's parent chain.
    private findAnyAll(context: BuildExpressionContext): CollectionAnyAllToken | undefined {
        const chain: CollectionAnyAllToken[] = [];
        for (let p: QueryToken | undefined = this.token; p != undefined; p = p.parent) {
            if (p instanceof CollectionAnyAllToken) {
                if (context.replacements.has(p.fullKey()))
                    break;
                chain.push(p);
            }
        }
        return chain.length > 0 ? chain[chain.length - 1] : undefined;
    }

    // Signum's GetExpressionWithAnyAll: bind the element parameter, build the group body (element
    // conditions now resolve to the parameter, outer conditions still to the outer row), then wrap
    // it in the quantifier. Mutates replacements transiently (add → build → remove), as Signum does.
    private getExpressionWithAnyAll(context: BuildExpressionContext, anyAll: CollectionAnyAllToken): Expression {
        const collection = anyAll.parent!.buildExpression(context);
        void (collection.type as ArrayType); // element type carried by the parameter below
        const param = anyAll.createParameter();

        context.replacements.set(anyAll.fullKey(), new ExpressionBox(buildLite(param)));
        const body = this.getExpression(context);
        context.replacements.delete(anyAll.fullKey());

        return anyAll.buildAnyAll(collection, param, body);
    }
}

// Port of Signum's `FilterCondition`: a token compared to a value.
export class FilterCondition extends Filter {
    constructor(
        public readonly token: QueryToken,
        public readonly operation: FilterOperation,
        public readonly value: unknown,
    ) { super(); }

    getTokens(): QueryToken[] { return [this.token]; }

    override isAggregate(): boolean { return tokenIsAggregate(this.token); }

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
        // Signum's QueryRequest.GroupResults: when true the query GROUPs BY the non-aggregate columns
        // and computes the aggregate columns per group.
        public groupResults: boolean = false,
    ) { }

    // Every token referenced by the request (columns + orders + filters).
    allTokens(): QueryToken[] {
        return [...this.columns.map(c => c.token), ...this.orders.map(o => o.token), ...this.filters.flatMap(f => f.getTokens())];
    }

    // The distinct aggregate tokens referenced anywhere (Signum's AllTokens().OfType<AggregateToken>()).
    aggregateTokens(): AggregateToken[] {
        const seen = new Map<string, AggregateToken>();
        for (const t of this.allTokens())
            if (t instanceof AggregateToken)
                seen.set(t.fullKey(), t);
        return [...seen.values()];
    }

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
