import { ArrayType, ObjectType, RuntimeType } from "../../entities/runtimeTypes";
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

    // ---- AllQueryOperations (Signum's DQueryable.AllQueryOperations) --------------------------
    // The full pipeline a QueryRequest drives. (Signum returns a materialised DEnumerableCount;
    // altea returns the built DQueryable — call executeAsync() / bindProjection() to run it.
    // TODO(phase5+): DEnumerable / ResultTable materialisation + total-count.)
    allQueryOperations(request: QueryRequest): DQueryable {
        return this
            .selectMany(request.multiplications())
            .where(request.filters)
            .orderBy(request.orders)
            .select(request.columns.map(c => c.token))
            .tryPaginate(request.pagination);
    }

    // ---- Terminals ----------------------------------------------------------------------------

    // Bind the built query to a fully-optimised ProjectionExpression (for inspection / SQL dump).
    bindProjection(): ProjectionExpression {
        const connector = Connector.current();
        return bindAndOptimize(this.query, connector.schema, connector.isPostgres, /* alreadySimplified */ true);
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

    // The QueryRequest pipeline that materialises a result (Signum's AllQueryOperations →
    // DEnumerableCount). Builds+executes the SQL query, then paginates in memory.
    // TODO(phase5+): push pagination to SQL (TOP/OFFSET) + a separate COUNT for the total, matching
    // Signum's TryPaginate-on-DQueryable; today it materialises then paginates in memory.
    async allQueryOperationsAsync(request: QueryRequest): Promise<DEnumerableCount> {
        const de = await this
            .selectMany(request.multiplications())
            .where(request.filters)
            .orderBy(request.orders)
            .select(request.columns.map(c => c.token))
            .toDEnumerableAsync();
        return de.tryPaginate(request.pagination);
    }
}

