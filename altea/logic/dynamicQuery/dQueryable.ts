import { ArrayType, ObjectType, RuntimeType, LiteralType } from "../../entities/runtimeTypes";
import {
    Expression, ParameterExpression, LambdaExpression, CallExpression, PropertyExpression, ObjectExpression,
    BinaryExpression, ConstantExpression,
} from "../linq/expressions";
import { ProjectionExpression } from "../linq/expressions.sql";
import { Connector } from "../connection/connector";
import { bindAndOptimize } from "../table";
import { buildTranslateResult } from "../linq/translatorBuilder";
import type { Query } from "../query";
import { QueryToken, BuildExpressionContext, ExpressionBox, buildLite } from "./tokens/queryToken";
import { CollectionElementToken } from "./tokens/collectionElementToken";
import { ColumnToken } from "./tokens/columnToken";
import { AggregateToken } from "./tokens/aggregateToken";
import { ColumnDescription, QueryDescription } from "./queryDescription";
import { Filter, Order, Column, OrderType, Pagination, QueryRequest } from "./requests";
import { DEnumerable, DEnumerableCount } from "./dEnumerable";

// Port of Signum's `DQueryable<T>` (DynamicQuery/DQueryable.cs). A query paired with its
// BuildExpressionContext (the token → expression replacements), threaded through a fluent pipeline —
// selectMany / where / orderBy / select / tryPaginate — exactly as Signum's DQueryable extension
// methods do. This is a USER-FACING authoring API (apps write manual queries with it, cf. Southwind
// CustomersLogic), not just an engine detail; hence the faithful class + method shape.
//
// altea difference: Signum's DQueryable wraps an `IQueryable`; altea wraps the query-AST
// `Expression` (what map/filter/flatMap build), since altea's `Query<T>` carries `.expression`.
export class DQueryable {
    constructor(
        public readonly query: Expression,
        public readonly context: BuildExpressionContext,
    ) { }

    // Signum's `IQueryable.ToDQueryable(QueryDescription)`: seed the context with one ColumnToken per
    // described column, each resolving to the matching member of the query's (projected) element.
    static toDQueryable<T>(query: Query<T>, description: QueryDescription): DQueryable {
        const pe = new ParameterExpression("e", query.elementType);
        const replacements = new Map<string, ExpressionBox>();
        for (const cd of description.columns) {
            const token = new ColumnToken(cd, description.queryName);
            const member = new PropertyExpression(pe, cd.name);
            replacements.set(token.fullKey(), new ExpressionBox(buildLite(member)));
        }
        return new DQueryable(query.expression, new BuildExpressionContext(query.elementType, pe, replacements));
    }

    // Seed directly from a root parameter (the common "Entity" column) — a convenience for callers
    // that navigate tokens off the entity rather than a projected anonymous type.
    static fromEntity(elementType: RuntimeType, sourceExpression: Expression): DQueryable {
        const pe = new ParameterExpression("e", elementType);
        const replacements = new Map<string, ExpressionBox>([[ColumnDescription.entityColumnName, new ExpressionBox(pe)]]);
        return new DQueryable(sourceExpression, new BuildExpressionContext(elementType, pe, replacements));
    }

    // ---- SelectMany (Signum's DQueryable.SelectMany + SelectManyConstructor) ------------------
    // Expands each collection with a flatMap and seeds its element token in the replacements. See
    // the divergence note in queryExpansion history: this uses a plain flatMap → CROSS APPLY
    // (empty-collection owners dropped) rather than Signum's DefaultIfEmpty → OUTER APPLY.
    selectMany(elementTokens: CollectionElementToken[]): DQueryable {
        let dq: DQueryable = this;
        for (const cet of elementTokens)
            dq = dq.selectManyOne(cet);
        return dq;
    }

    private selectManyOne(cet: CollectionElementToken): DQueryable {
        const outerParam = this.context.parameter;
        const collection = cet.parent!.buildExpression(this.context);
        const elemType = (collection.type as ArrayType).elementType as RuntimeType;
        const elemParam = new ParameterExpression("_elem", elemType);

        const keys = [...this.context.replacements.keys()];
        const props: Record<string, Expression> = {};
        keys.forEach((k, i) => { props["c" + i] = this.context.replacements.get(k)!.rawExpression; });
        const elemSlot = "c" + keys.length;
        props[elemSlot] = buildLite(elemParam);
        const tuple = new ObjectExpression(props);

        const innerMap = new CallExpression(new PropertyExpression(collection, "map"),
            [new LambdaExpression([elemParam], tuple)], new ArrayType(tuple.type));
        const flatMap = new CallExpression(new PropertyExpression(this.query, "flatMap"),
            [new LambdaExpression([outerParam], innerMap)], new ArrayType(tuple.type));

        const tupleParam = new ParameterExpression("_t", tuple.type as ObjectType);
        const newReplacements = new Map<string, ExpressionBox>();
        keys.forEach((k, i) => newReplacements.set(k, new ExpressionBox(new PropertyExpression(tupleParam, "c" + i))));
        newReplacements.set(cet.fullKey(), new ExpressionBox(new PropertyExpression(tupleParam, elemSlot)));

        return new DQueryable(flatMap, new BuildExpressionContext(tuple.type, tupleParam, newReplacements));
    }

    // ---- Where (Signum's DQueryable.Where + GetPredicateExpression) ---------------------------
    where(filters: Filter[]): DQueryable {
        if (filters.length === 0)
            return this;
        const body = filters.map(f => f.getExpression(this.context)).reduce((a, b) => new BinaryExpression("&&", a, b));
        const predicate = new LambdaExpression([this.context.parameter], body);
        const filtered = new CallExpression(new PropertyExpression(this.query, "filter"), [predicate], this.query.type);
        return new DQueryable(filtered, this.context);
    }

    // ---- OrderBy (Signum's DQueryable.OrderBy + CreateOrderLambda) ----------------------------
    orderBy(orders: Order[]): DQueryable {
        let q = this.query;
        orders.forEach((o, i) => {
            const keyLambda = new LambdaExpression([this.context.parameter], o.token.buildExpression(this.context));
            const method = i === 0
                ? (o.orderType === OrderType.Descending ? "orderByDescending" : "orderBy")
                : (o.orderType === OrderType.Descending ? "thenByDescending" : "thenBy");
            q = new CallExpression(new PropertyExpression(q, method), [keyLambda], this.query.type);
        });
        return new DQueryable(q, this.context);
    }

    // ---- Select (Signum's DQueryable.Select + SelectTupleConstructor) -------------------------
    // Projects the given column tokens into a `{ c0, c1, … }` tuple and returns a context whose
    // replacements resolve each token to its tuple slot.
    select(columns: (QueryToken | Column)[]): DQueryable {
        const tokens = columns.map(c => c instanceof Column ? c.token : c);
        const props: Record<string, Expression> = {};
        tokens.forEach((t, i) => { props["c" + i] = t.buildExpression(this.context); });
        const tuple = new ObjectExpression(props);

        const selector = new LambdaExpression([this.context.parameter], tuple);
        const mapped = new CallExpression(new PropertyExpression(this.query, "map"), [selector], new ArrayType(tuple.type));

        const tupleParam = new ParameterExpression("_s", tuple.type as ObjectType);
        const newReplacements = new Map<string, ExpressionBox>();
        tokens.forEach((t, i) => newReplacements.set(t.fullKey(), new ExpressionBox(new PropertyExpression(tupleParam, "c" + i))));

        return new DQueryable(mapped, new BuildExpressionContext(tuple.type, tupleParam, newReplacements));
    }

    // ---- GroupBy (Signum's DQueryable.GroupBy) ------------------------------------------------
    // Groups by the key tokens and computes the aggregate tokens over each group. Builds
    //   source.groupBy(row => { k0, k1, … }).map(g => { k0: g.key.k0, …, a0: <agg over g.elements>, … })
    // (altea has no result-selector groupBy overload — it's `groupBy(key).map(g => …)`). The new
    // context resolves each key token to `gr.kI` and each aggregate token to `gr.aI`.
    groupBy(keyTokens: QueryToken[], aggregateTokens: AggregateToken[]): DQueryable {
        // Signum's GetRootKeyTokens: a key dominated by another key is functionally determined by it
        // (`Customer.Name` given `Customer`), so it's dropped from the GROUP BY and recovered as a
        // constant read off the group's key. Only the root keys become real GROUP BY columns.
        const rootKeys = getRootKeyTokens(keyTokens);
        const redundantKeys = keyTokens.filter(t => !rootKeys.includes(t));

        // Key selector over ROOT keys only: row => { k0: root0, k1: root1, … }
        const keyProps: Record<string, Expression> = {};
        rootKeys.forEach((t, i) => { keyProps["k" + i] = t.buildExpression(this.context); });
        const keyTuple = new ObjectExpression(keyProps);
        const keyLambda = new LambdaExpression([this.context.parameter], keyTuple);

        const groupingType = new ObjectType({ key: keyTuple.type, elements: new ArrayType(this.context.elementType) });
        const groupBy = new CallExpression(new PropertyExpression(this.query, "groupBy"), [keyLambda], new ArrayType(groupingType));

        const gParam = new ParameterExpression("g", groupingType);
        const gKey = new PropertyExpression(gParam, "key");
        const gElements = new PropertyExpression(gParam, "elements");

        // A temp context resolving each root key to its key-tuple slot, so a redundant key navigates
        // off the group's key (`g.key.k0.name`) — the constant-per-group value.
        const tempReplacements = new Map<string, ExpressionBox>();
        rootKeys.forEach((t, i) => tempReplacements.set(t.fullKey(), new ExpressionBox(new PropertyExpression(gKey, "k" + i))));
        // (Param is unused — a redundant key's chain hits a root-key replacement before the param.)
        const tempContext = new BuildExpressionContext(keyTuple.type, gParam, tempReplacements);

        // Result selector: one slot per root key, redundant key, and aggregate (all named cN so the
        // grouped context resolves any requested column token by fullKey).
        const entries: { token: QueryToken; expr: Expression }[] = [
            ...rootKeys.map((t, i) => ({ token: t, expr: new PropertyExpression(gKey, "k" + i) as Expression })),
            ...redundantKeys.map(t => ({ token: t, expr: t.buildExpression(tempContext) })),
            ...aggregateTokens.map(at => ({ token: at as QueryToken, expr: at.buildAggregate(gElements, this.context) })),
        ];
        const resultProps: Record<string, Expression> = {};
        entries.forEach((e, i) => { resultProps["c" + i] = e.expr; });
        const resultTuple = new ObjectExpression(resultProps);
        const resultLambda = new LambdaExpression([gParam], resultTuple);
        const mapped = new CallExpression(new PropertyExpression(groupBy, "map"), [resultLambda], new ArrayType(resultTuple.type));

        const grParam = new ParameterExpression("gr", resultTuple.type as ObjectType);
        const replacements = new Map<string, ExpressionBox>();
        entries.forEach((e, i) => replacements.set(e.token.fullKey(), new ExpressionBox(new PropertyExpression(grParam, "c" + i))));
        return new DQueryable(mapped, new BuildExpressionContext(resultTuple.type, grParam, replacements));
    }

    // ---- TryPaginate (Signum's DQueryable.TryPaginate) ----------------------------------------
    tryPaginate(pagination: Pagination): DQueryable {
        if (pagination instanceof Pagination.Firsts)
            return this.top(pagination.topElements);
        if (pagination instanceof Pagination.Paginate)
            return this.skip(pagination.skip()).top(pagination.elementsPerPage);
        return this; // All
    }

    private top(n: number): DQueryable {
        return new DQueryable(new CallExpression(new PropertyExpression(this.query, "top"), [new ConstantExpression(n)], this.query.type), this.context);
    }
    private skip(n: number): DQueryable {
        return new DQueryable(new CallExpression(new PropertyExpression(this.query, "skip"), [new ConstantExpression(n)], this.query.type), this.context);
    }

    // ---- Terminals ----------------------------------------------------------------------------

    // Bind the built query to a fully-optimised ProjectionExpression (for inspection / SQL dump).
    bindProjection(): ProjectionExpression {
        const connector = Connector.current();
        return bindAndOptimize(this.query, connector.schema, connector.isPostgres, /* alreadySimplified */ true);
    }

    // The `<query>.count()` aggregate over the built query (Signum's Untyped.Count).
    private countCall(): Expression {
        return new CallExpression(new PropertyExpression(this.query, "count"), [], LiteralType.number);
    }
    bindCountProjection(): ProjectionExpression {
        const connector = Connector.current();
        return bindAndOptimize(this.countCall(), connector.schema, connector.isPostgres, true);
    }
    async countAsync(): Promise<number> {
        const connector = Connector.current();
        return await buildTranslateResult(this.bindCountProjection(), connector.isPostgres).execute() as number;
    }

    // Execute the built query and return the raw projected rows.
    async executeAsync(): Promise<unknown[]> {
        const connector = Connector.current();
        return await buildTranslateResult(this.bindProjection(), connector.isPostgres).execute() as unknown[];
    }

    // Materialise into the in-memory arm (Signum's DQueryable.ToDEnumerable): execute the query and
    // wrap the rows + context so they can be combined (Concat) / re-ordered / paginated in memory.
    async toDEnumerableAsync(): Promise<DEnumerable> {
        return new DEnumerable(await this.executeAsync(), this.context);
    }

    // SQL-side pagination (Signum's TryPaginate on DQueryable): apply TOP / OFFSET-FETCH to the query,
    // execute the single page, and get the total via a separate COUNT — skipping the COUNT when the
    // returned page is short (we've reached the end). Returns a materialised DEnumerableCount.
    // Note: no OrderAlsoByKeys yet (stable tie-break for pagination) — see TODO.md.
    async tryPaginateAsync(pagination: Pagination): Promise<DEnumerableCount> {
        if (pagination instanceof Pagination.Firsts) {
            const rows = await this.top(pagination.topElements).executeAsync();
            return new DEnumerableCount(rows, this.context, undefined);
        }
        if (pagination instanceof Pagination.Paginate) {
            const size = pagination.elementsPerPage;
            const offset = pagination.skip();
            let dq: DQueryable = this;
            if (pagination.currentPage !== 1)
                dq = dq.skip(offset);
            const rows = await dq.top(size).executeAsync();
            // A short page means the end was reached, so total = offset + page; else run the COUNT.
            const total = rows.length < size ? offset + rows.length : await this.countAsync();
            return new DEnumerableCount(rows, this.context, total);
        }
        // All: execute everything; total is the row count.
        const all = await this.executeAsync();
        return new DEnumerableCount(all, this.context, all.length);
    }

    // The QueryRequest pipeline up to (but not including) pagination (Signum's AllQueryOperations
    // body). Branches on GroupResults: the group path splits filters into WHERE (simple) vs HAVING
    // (aggregate) and GROUPs BY the non-aggregate columns; the plain path filters/orders/selects.
    private buildQueryOperations(request: QueryRequest): DQueryable {
        if (request.groupResults) {
            const keys = request.columns.map(c => c.token).filter(t => !(t instanceof AggregateToken));
            const aggregates = request.aggregateTokens();
            const simpleFilters = request.filters.filter(f => !f.isAggregate());
            const aggregateFilters = request.filters.filter(f => f.isAggregate());
            return this
                .selectMany(request.multiplications())
                .where(simpleFilters)
                .groupBy(keys, aggregates)
                .where(aggregateFilters)   // HAVING
                .orderBy(request.orders);
            // No trailing select — groupBy already projected the key + aggregate columns; the
            // ResultTable reads request.columns straight off the grouped context.
        }
        return this
            .selectMany(request.multiplications())
            .where(request.filters)
            .orderBy(request.orders)
            .select(request.columns.map(c => c.token));
    }

    // Build the full QueryRequest pipeline (SQL side), including pagination as a query builder.
    allQueryOperations(request: QueryRequest): DQueryable {
        return this.buildQueryOperations(request).tryPaginate(request.pagination);
    }

    // Materialise a result (Signum's AllQueryOperations → DEnumerableCount): the pipeline above then
    // SQL-side pagination.
    async allQueryOperationsAsync(request: QueryRequest): Promise<DEnumerableCount> {
        return await this.buildQueryOperations(request).tryPaginateAsync(request.pagination);
    }
}

// Signum's GetRootKeyTokens: the group keys not dominated by another key (their descendants are
// redundant — functionally determined — and are recovered per-group instead of grouped on).
function getRootKeyTokens(keyTokens: QueryToken[]): QueryToken[] {
    return keyTokens.filter(t => !keyTokens.some(t2 => t2 !== t && t2.dominates(t)));
}

