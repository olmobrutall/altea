import { Expression, ParameterExpression, BinaryExpression, ConstantExpression, PropertyExpression, CallExpression } from "../linq/expressions";
import { LiteralType, ArrayType, TsVectorType, TsQueryType } from "../runtimeTypes";
import { SqlFullTextSearch } from "../fullTextSearch";
import type { Implementations } from "../../data/implementations";
import type { RuntimeType } from "../runtimeTypes";
import { BuildExpressionContext, ExpressionBox, buildLite } from "./tokenExpressions";
import { QueryToken, CollectionElementToken, CollectionAnyAllToken, AggregateToken } from "../../data/dynamicQuery/tokens";
import type { QueryName } from "../../data/dynamicQuery/queryUtils";
import { Connector } from "../connection/connector";

// Port of Signum's `FilterCondition.ToLowerString` (wired in QueryLogic.Start, QueryLogic.cs). On a
// case-SENSITIVE backend (Postgres) a dynamic-query string comparison must lower BOTH sides — the column
// (SQL LOWER) and the value — so Contains / EqualTo / DistinctTo / StartsWith / EndsWith / IsIn (and
// autocomplete, which is a ToString-Contains query) match case-INSENSITIVELY. That mirrors SQL Server's
// default case-insensitive collation, where no lowering is needed. Signum lets a column opt out when it
// carries an explicit case-insensitive collation (DbTypeAttribute.CollationPostgres_AvoidToLower); altea
// does not resolve a token's column collation here yet, so it keys purely off the dialect — no eastwind
// column defines a custom collation. Dialect is read from the active connector (altea's dialect is
// per-connection, unlike Signum's process-wide Schema.Settings.IsPostgres).
function toLowerStringFilter(_token: QueryToken): boolean {
    return Connector.current().isPostgres;
}

// LOWER(expr): a `.toLowerCase()` call the QueryBinder/DbExpressionNominator lowers to SQL LOWER (and which
// also evaluates correctly in the in-memory DEnumerable path, since JS strings have `.toLowerCase()`).
function toLowerExpr(expr: Expression): Expression {
    return new CallExpression(new PropertyExpression(expr, "toLowerCase"), [], LiteralType.string);
}

function toLowerValue(value: unknown): unknown {
    return typeof value === "string" ? value.toLowerCase() : value;
}

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
    // Full-text operations (Signum's Filter.cs). SQL Server: FreeText → FREETEXT, ComplexCondition
    // → CONTAINS. Postgres: TsQuery* → the matching `tsvector @@ *_tsquery(value)`. The string
    // values match the client FilterOperationEnum (data/dynamicQueries.ts).
    FreeText = "FreeText",
    ComplexCondition = "ComplexCondition",
    TsQuery = "TsQuery",
    TsQuery_Plain = "TsQuery_Plain",
    TsQuery_Phrase = "TsQuery_Phrase",
    TsQuery_WebSearch = "TsQuery_WebSearch",
}

// The Postgres tsquery builder method (on String) for each TsQuery filter operation.
const TS_QUERY_METHOD: Partial<Record<FilterOperation, string>> = {
    [FilterOperation.TsQuery]: "toTsQuery",
    [FilterOperation.TsQuery_Plain]: "toTsQuery_Plain",
    [FilterOperation.TsQuery_Phrase]: "toTsQuery_Phrase",
    [FilterOperation.TsQuery_WebSearch]: "toTsQuery_WebSearch",
};

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

    // Signum's `Token?.Follow(Parent).OfType<CollectionAnyAllToken>().TakeWhile(not-bound).LastOrDefault()`
    // — the shallowest not-yet-bound quantifier in a token's parent chain. Lives on the base Filter
    // because BOTH FilterCondition and FilterGroup need it (Signum's Filter.GetExpressionWithAnyAll is
    // likewise on the base): a filter whose token passes through an `.Any`/`.All` becomes a correlated
    // quantifier, whether it's a lone condition or a group.
    protected findAnyAll(context: BuildExpressionContext, token: QueryToken | undefined): CollectionAnyAllToken | undefined {
        const chain: CollectionAnyAllToken[] = [];
        for (let p: QueryToken | undefined = token; p != undefined; p = p.parent) {
            if (p instanceof CollectionAnyAllToken) {
                if (context.replacements.has(p.fullKey()))
                    break;
                chain.push(p);
            }
        }
        return chain.length > 0 ? chain[chain.length - 1] : undefined;
    }

    // Signum's Filter.GetExpressionWithAnyAll: bind the element parameter, rebuild THIS filter's body
    // (element conditions now resolve to the parameter, outer conditions still to the outer row), then
    // wrap it in the quantifier. Mutates replacements transiently (add → build → remove), as Signum does.
    protected getExpressionWithAnyAll(context: BuildExpressionContext, anyAll: CollectionAnyAllToken): Expression {
        const collection = anyAll.parent!.buildExpression(context);
        const param = anyAll.createParameter((collection.type as ArrayType).elementType!);

        context.replacements.set(anyAll.fullKey(), new ExpressionBox(buildLite(param)));
        const body = this.getExpression(context);
        context.replacements.delete(anyAll.fullKey());

        return anyAll.buildAnyAll(collection, param, body);
    }
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
        const anyAll = this.findAnyAll(context, this.token);
        if (anyAll == undefined) {
            const exprs = this.filters.map(f => f.getExpression(context));
            if (exprs.length === 0)
                return new ConstantExpression(this.groupOperation === FilterGroupOperation.And);
            const op = this.groupOperation === FilterGroupOperation.And ? "&&" : "||";
            return exprs.reduce((a, b) => new BinaryExpression(op, a, b));
        }
        return this.getExpressionWithAnyAll(context, anyAll);
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
        // Signum's FilterCondition.GetExpression: a lone condition whose token passes through an unbound
        // `.Any`/`.All` quantifier (e.g. `Details.Any.Product = Chai`) must ALSO become a correlated
        // subquery — not just filters inside a FilterGroup. Without this the token's own buildExpression
        // hits CollectionAnyAllToken.buildExpression, which throws ("should have a replacement"). Once the
        // quantifier is bound (in getExpressionWithAnyAll's transient replacement) findAnyAll returns
        // undefined and we fall through to the basic comparison below.
        const anyAll = this.findAnyAll(context, this.token);
        if (anyAll != undefined)
            return this.getExpressionWithAnyAll(context, anyAll);

        return this.getConditionExpressionBasic(context);
    }

    // Signum's FilterCondition.GetConditionExpressionBasic: the actual value comparison, once any
    // enclosing quantifier has been bound.
    private getConditionExpressionBasic(context: BuildExpressionContext): Expression {
        const left = this.token.buildExpression(context);

        // Case-insensitive string comparison (Signum's FilterCondition.ToLowerString): on a case-sensitive
        // backend lower the column AND the value(s) so string filters match regardless of case. Only for a
        // string token — a non-string comparison (numbers/dates/enums) is untouched. NOTE: applies only to
        // the value-comparison branches below; the full-text / TsQuery branches must keep the raw column.
        const ci = this.token.type.typeName === "String" && toLowerStringFilter(this.token);
        const cmpLeft = ci ? toLowerExpr(left) : left;

        const binOp = BINARY_OP[this.operation];
        if (binOp != undefined)
            return new BinaryExpression(binOp, cmpLeft, new ConstantExpression(ci ? toLowerValue(this.value) : this.value));

        const sm = STRING_METHOD[this.operation];
        if (sm != undefined) {
            const call = new CallExpression(new PropertyExpression(cmpLeft, sm.method), [new ConstantExpression(ci ? toLowerValue(this.value) : this.value)], LiteralType.boolean);
            return sm.negate ? new BinaryExpression("==", call, new ConstantExpression(false)) : call;
        }

        if (this.operation === FilterOperation.IsIn || this.operation === FilterOperation.IsNotIn) {
            // `.includes` is altea's SQL-mappable array membership (→ IN (…), like retrieveByIds).
            const values = ci && Array.isArray(this.value) ? this.value.map(toLowerValue) : this.value;
            const call = new CallExpression(new PropertyExpression(new ConstantExpression(values), "includes"), [cmpLeft], LiteralType.boolean);
            return this.operation === FilterOperation.IsNotIn ? new BinaryExpression("==", call, new ConstantExpression(false)) : call;
        }

        // ---- Full-text (Signum's FilterFullText) ------------------------------------------------
        // SQL Server: FREETEXT / CONTAINS over the token's column (`left`). The QueryBinder recognises
        // the SqlFullTextSearch.freeText/contains call and lowers it to the predicate.
        if (this.operation === FilterOperation.FreeText || this.operation === FilterOperation.ComplexCondition) {
            const method = this.operation === FilterOperation.FreeText ? "freeText" : "contains";
            return new CallExpression(
                new PropertyExpression(new ConstantExpression(SqlFullTextSearch), method),
                [left, new ConstantExpression(this.value)], LiteralType.boolean);
        }
        // Postgres: `entity.getTsVectorColumn() @@ <value>.toTsQuery*()`. The tsvector column covers
        // ALL the entity's full-text columns, so the search is off the row entity (the token's
        // parent), not the single token column.
        const tsMethod = TS_QUERY_METHOD[this.operation];
        if (tsMethod != undefined) {
            const entity = this.token.parent!.buildExpression(context);
            const tsVector = new CallExpression(new PropertyExpression(entity, "getTsVectorColumn"), [], new TsVectorType());
            const tsQuery = new CallExpression(new PropertyExpression(new ConstantExpression(this.value), tsMethod), [], new TsQueryType());
            return new CallExpression(new PropertyExpression(tsVector, "matches"), [tsQuery], LiteralType.boolean);
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
