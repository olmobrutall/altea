// ExpressionTree half of the DynamicQuery token model, EXTERNALIZED from the token classes.
//
// The token classes themselves live in entities/dynamicQuery/tokens (the shared, client-runnable
// model: metadata + sub-token generation). Their `buildExpression`/`buildExpressionInternal` — the
// only part that depends on logic/linq/expressions — is attached HERE by prototypal augmentation, so
// behavior stays co-located one-body-per-token while the model stays free of the logic layer.
//
// Import this module (directly, or transitively via any consumer that builds token expressions) to
// install the prototypes before calling `token.buildExpression(...)`.

import {
    Expression, ParameterExpression, PropertyExpression, CallExpression, CastExpression,
    BinaryExpression, ConstantExpression, LambdaExpression, UnaryExpression, ObjectExpression,
    ConditionalExpression,
} from "../linq/expressions";
import type { Filter } from "./requests";
import { Entity } from "../../data/entity";
import { TypeEntity } from "../../data/typeEntity";
import { PropertyRouteType } from "../../data/propertyRoute";
import { RuntimeType, ClassType, LiteType, ArrayType, LiteralType, TsVectorType, TsQueryType } from "../runtimeTypes";
import { Connector } from "../connection/connector";
import { PgVectorSearch, SqlVectorSearch } from "../vectorSearch";
import {
    QueryToken, RootToken, EntityPropertyToken, EntityToStringToken, HasValueToken, ObjectPropertyToken,
    AsTypeToken, EntityTypeToken, DateToken, DatePartStartToken, DurationTotalToken, ModuloToken, CountToken,
    StepToken, StepMultiplierToken, StepRoundingToken, RoundingType, FullTextRankToken, StringSnippetToken,
    VectorDistanceToken,
    CollectionElementToken, CollectionAnyAllToken, CollectionAnyAllType, CollectionToArrayToken,
    AggregateToken, AggregateFunction, ExtensionToken,
    ManualContainerToken, ManualToken,
    OperationsContainerToken, OperationToken,
    IndexerContainerToken, ExtensionWithParameterToken,
} from "../../data/dynamicQuery/tokens";
import type { Quoted } from "quote-transformer/quoted";
import { ExpressionVisitor } from "../linq/visitors/ExpressionVisitor";
import { inState } from "../operation";
import type { Type } from "../../data/entity";

// ---- BuildExpressionContext / ExpressionBox (Signum's, in QueryToken.cs) --------------------

// One replacement entry: the raw altea expression a token resolves to. (Signum's MListElementRoute
// / SubQueryContext / AlreadyHidden are not modelled yet — no MList, no auth-hiding.)
export class ExpressionBox {
    constructor(public readonly rawExpression: Expression) { }
    getExpression(): Expression { return this.rawExpression; }
}

// The context threaded through BuildExpression: the row parameter plus the map of already-known
// token expressions (seeded from the query's projected columns). Keyed by `token.fullKey()` — a
// string key gives value equality where JS Map object-identity would not.
export class BuildExpressionContext {
    constructor(
        public readonly elementType: RuntimeType,
        public readonly parameter: ParameterExpression,
        public readonly replacements: Map<string, ExpressionBox>,
        /**
         * The filters the query is running under (Signum's `BuildExpressionContext.Filters`). Almost
         * no token needs them — a token is a column, not a predicate — but a full-text RANK does: the
         * score only exists relative to the search terms, so `MatchRank` reads the full-text filters
         * placed on its own parent token and re-builds their tsquery. Accumulated by `DQueryable.where`
         * and carried through every later stage of the pipeline.
         */
        public readonly filters: readonly Filter[] = [],
    ) { }

    /** The same context with `filters` appended — what `where` hands to the stages after it. */
    andFilters(more: readonly Filter[]): BuildExpressionContext {
        return more.length === 0 ? this
            : new BuildExpressionContext(this.elementType, this.parameter, this.replacements, [...this.filters, ...more]);
    }
}

// ---- Expression helpers — the BuildExpression retarget onto altea's model -------------------
// Ports of Signum's ExtractEntity / BuildLiteNullifyUnwrapPrimaryKey (QueryUtils.cs). They emit
// altea `Expression` nodes the Phase-D binder already understands (`.entity`, `.toLite`).

function isEntityCtor(ctor: Function): ctor is Type<Entity> {
    return ctor === Entity || ctor.prototype instanceof Entity;
}

function isToLiteCall(expr: Expression): expr is CallExpression & { func: PropertyExpression } {
    return expr instanceof CallExpression && expr.func instanceof PropertyExpression && expr.func.propertyName === "toLite";
}

// Signum's `ExtractEntity`: yield the entity behind a reference expression. A `toLite(x)` call is
// unwrapped straight back to `x`; a plain Lite value dereferences via `.entity`; a full entity is
// returned as-is. `late` (id / toString) is a no-op — the binder late-binds over lite or entity.
export function extractEntity(expr: Expression, late = false): Expression {
    if (isToLiteCall(expr))
        return expr.func.object;
    if (!late && expr.type instanceof LiteType)
        return new PropertyExpression(expr, "entity");
    return expr;
}

// Signum's `BuildLiteNullifyUnwrapPrimaryKey`: a full-entity reference projects as a `Lite<T>`. A
// value / already-lite / embedded expression is returned unchanged.
export function buildLite(expr: Expression): Expression {
    const t = expr.type;
    if (t instanceof ClassType && isEntityCtor(t.constructorFunction))
        return new CallExpression(new PropertyExpression(expr, "toLite"), [], new LiteType(t));
    return expr;
}

// FilterOperation (string) → comparison operator, for `Count where <token> <op> <value>`.
const COMPARE_OP: Record<string, "==" | "!=" | ">" | ">=" | "<" | "<="> = {
    EqualTo: "==", DistinctTo: "!=", GreaterThan: ">", GreaterThanOrEqual: ">=", LessThan: "<", LessThanOrEqual: "<=",
};

// ExtensionToken build hook (Signum's ExtensionToken.BuildExtension). Set by expressionContainer.ts:
// given the token's opaque `serverInfo` ({ lambda, meta, sourceType }) and the parent expression, it
// inlines the registered lambda's body. Kept as a seam so the entities ExtensionToken stays free of
// the quoted lambda / linq layer.
let buildExtensionExpr: ((serverInfo: unknown, parentExpression: Expression) => Expression) | undefined;
export function setBuildExtensionExpr(fn: (serverInfo: unknown, parentExpression: Expression) => Expression): void {
    buildExtensionExpr = fn;
}

// The same for an expression with a parameter: the registration, the key value, the parent.
let buildExtensionWithParameterExpr: ((serverInfo: unknown, key: unknown, parentExpression: Expression) => Expression) | undefined;
export function setBuildExtensionWithParameterExpr(fn: (serverInfo: unknown, key: unknown, parentExpression: Expression) => Expression): void {
    buildExtensionWithParameterExpr = fn;
}

// ---- Prototype augmentation: declare the expression surface, then install the bodies --------

declare module "../../data/dynamicQuery/tokens/queryToken" {
    interface QueryToken {
        // Signum's QueryToken.BuildExpression: resolve from the seeded replacements (a projected
        // column), else recurse into buildExpressionInternal.
        buildExpression(context: BuildExpressionContext): Expression;
        buildExpressionInternal(context: BuildExpressionContext): Expression;
    }
}
declare module "../../data/dynamicQuery/tokens/collectionAnyAllToken" {
    interface CollectionAnyAllToken {
        createParameter(elementType: RuntimeType): ParameterExpression;
        buildAnyAll(collection: Expression, param: ParameterExpression, body: Expression): Expression;
    }
}
declare module "../../data/dynamicQuery/tokens/aggregateToken" {
    interface AggregateToken {
        buildAggregate(elements: Expression, groupContext: BuildExpressionContext): Expression;
    }
}

QueryToken.prototype.buildExpression = function (context: BuildExpressionContext): Expression {
    const box = context.replacements.get(this.fullKey());
    if (box != undefined)
        return box.getExpression();
    return this.buildExpressionInternal(context);
};

RootToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return context.parameter; // the row itself (also seeded as replacements[""] by the pipeline)
};

EntityPropertyToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const base = this.parent!.buildExpression(context);

    if (this.isId)
        // Late-bound `.id` over a lite or an entity (Signum's ExtractEntity(true) + Id).
        return new PropertyExpression(extractEntity(base, true), "id");

    // A mixin field reads through `entity.mixin(M)` (Signum's BindMixin), which the route records.
    let entity = extractEntity(base, false);
    const parentRoute = this.route?.parent;
    if (parentRoute?.propertyRouteType === PropertyRouteType.Mixin) {
        const mixin = parentRoute.type.getFunction()!;
        entity = new CallExpression(new PropertyExpression(entity, "mixin"), [new ConstantExpression(mixin)], new ClassType(mixin));
    }
    const prop = new PropertyExpression(entity, this.fieldInfo.name);
    return buildLite(prop);
};

EntityToStringToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const base = this.parent!.buildExpression(context);
    // A lite/entity toString late-binds; a lite is dereferenced by extractEntity(true) = identity.
    return new CallExpression(new PropertyExpression(extractEntity(base, true), "toString"), [], LiteralType.string);
};

HasValueToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const base = this.parent!.buildExpression(context);

    // Source the collection/string test off the BUILT expression's RuntimeType (base.type), not the
    // token's TypeReference — the token no longer carries a RuntimeType.
    if (base.type instanceof ArrayType)
        return new CallExpression(new PropertyExpression(base, "some"), [], LiteralType.boolean);

    const notNull = new BinaryExpression("!=", base, new ConstantExpression(null));
    if (base.type === LiteralType.string)
        return new BinaryExpression("&&", notNull, new BinaryExpression("!=", base, new ConstantExpression("")));
    return notNull;
};

ObjectPropertyToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const base = this.parent!.buildExpression(context);
    const member = new PropertyExpression(base, this.memberName);
    // The only method-form ObjectPropertyToken is a date part (quarter()) → number; the property forms
    // (length, year, …) self-type via the PropertyExpression. (Token .type is now a TypeReference.)
    return this.isMethod ? new CallExpression(member, [], LiteralType.number) : member;
};

AsTypeToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const base = this.parent!.buildExpression(context);
    // (base.entity as EntityType), then project as a Lite.
    const cast = new CastExpression(extractEntity(base, false), new ClassType(this.entityCtor));
    return buildLite(cast);
};

// `lite.entityType.toTypeEntity()`, projected as a Lite — Signum's
// `TypeLogic.ToTypeEntity(base.EntityType).BuildLite()`.
//
// Both halves already exist in the binder and neither is specific to this token: `.entityType` on a
// lite yields a Type expression (`getEntityType` — the @implementedByAll discriminator column, or a
// CASE over which @implementedBy column is filled), and `.toTypeEntity()` turns a Type expression
// into an ordinary EntityExpression on the TypeEntity table keyed by that id. So the token is pure
// navigation: it adds no SQL and it completes and materialises like any other reference.
EntityTypeToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const base = this.parent!.buildExpression(context);
    const entityType = new PropertyExpression(base, "entityType");
    const typeEntity = new CallExpression(new PropertyExpression(entityType, "toTypeEntity"), [], new ClassType(TypeEntity));
    return buildLite(typeEntity);
};

DateToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return new PropertyExpression(this.parent!.buildExpression(context), "date");
};

// `x.monthStart()` / `x.truncHours()` … — the Temporal extensions the nominator already lowers to
// date_trunc (Postgres) / DATETRUNC (SQL Server), and which evaluate in memory too. The result keeps the
// receiver's temporal kind, which is what the token's own `type` says. A STEPPED token passes it as the
// call's one argument (`truncHours(6)`).
DatePartStartToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const base = this.parent!.buildExpression(context);
    const args = this.step == undefined ? [] : [new ConstantExpression(this.step, LiteralType.number)];
    return new CallExpression(new PropertyExpression(base, this.member), args, base.type);
};

// `duration.total("minutes")` — the only spelling Temporal has for Signum's `TimeSpan.TotalMinutes`, and
// the shape the nominator's translateDurationMethod consumes (over a since()/until() difference or a
// stored `time` column alike).
DurationTotalToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const base = this.parent!.buildExpression(context);
    return new CallExpression(new PropertyExpression(base, "total"), [new ConstantExpression(this.totalUnit, LiteralType.string)], LiteralType.number);
};

ModuloToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return new BinaryExpression("%", this.parent!.buildExpression(context), new ConstantExpression(this.divisor));
};

/**
 * Port of Signum's `RoundingExpressionGenerator.RoundExpression`: snap a number onto a grid of
 * `step`-wide buckets. Signum's exact sequence, and the order matters —
 *
 *     RoundMiddle only:  v -= step/2        (shift the grid half a bucket, so the label is its MIDDLE)
 *     step != 1:         v /= step
 *                        ceil / floor / round
 *     step != 1:         v *= step
 *     RoundMiddle only:  v += step/2
 *
 * Two altea-specific points:
 *  - the leading `Number(v)` is Signum's `Expression.Convert(result, typeof(double))`, and it is NOT
 *    cosmetic: BOTH providers do INTEGER division for `int / int`, so without the cast to float
 *    `ceil(orderId / 1000) * 1000` would silently answer the FLOOR bucket on an integer column.
 *  - a `Decimal` (decimal.js) token takes the decimal.js method chain instead, which lowers to the
 *    same SQL through `decimalCall` but stays EXACT — `ceil(x / 0.1)` in binary floating point does
 *    not. A `Number` token whose subTypeName is `decimal` (altea's branded alias) is a plain JS
 *    number at runtime and takes the float path, so its sub-unit buckets carry the usual float noise.
 *
 * `Math.ceil/floor/round` lower to CEILING/FLOOR/ROUND on both providers (dbExpressionNominator
 * .translateMath). One divergence is inherent and shared with Signum: JS `Math.round` and SQL `ROUND`
 * round a half AWAY from zero, .NET's `Math.Round` rounds it to EVEN — so `Round` on -2.5 answers -3
 * here and -2 in Signum's in-memory path.
 */
function roundToStep(value: Expression, step: number, rounding: RoundingType): Expression {
    const half = step / 2;
    const ceilFloorRound = rounding === RoundingType.Ceil ? "ceil" : rounding === RoundingType.Floor ? "floor" : "round";

    if (value.type === LiteralType.decimal) {
        const call = (target: Expression, method: string, arg?: number): Expression =>
            new CallExpression(new PropertyExpression(target, method),
                arg == undefined ? [] : [new ConstantExpression(arg, LiteralType.number)], LiteralType.decimal);
        let r = value;
        if (rounding === RoundingType.RoundMiddle) r = call(r, "minus", half);
        if (step !== 1) r = call(r, "dividedBy", step);
        r = call(r, ceilFloorRound);
        if (step !== 1) r = call(r, "times", step);
        if (rounding === RoundingType.RoundMiddle) r = call(r, "plus", half);
        return r;
    }

    let r: Expression = new CallExpression(new ConstantExpression(Number), [value], LiteralType.number);
    if (rounding === RoundingType.RoundMiddle) r = new BinaryExpression("-", r, new ConstantExpression(half));
    if (step !== 1) r = new BinaryExpression("/", r, new ConstantExpression(step));
    r = new CallExpression(new PropertyExpression(new ConstantExpression(Math), ceilFloorRound), [r], LiteralType.number);
    if (step !== 1) r = new BinaryExpression("*", r, new ConstantExpression(step));
    if (rounding === RoundingType.RoundMiddle) r = new BinaryExpression("+", r, new ConstantExpression(half));
    return r;
}

// All three levels of the Step chain build from the ORIGINAL numeric token, never from the level
// above — Signum's `Parent!.Parent!.Parent!.BuildExpression`. The levels differ only in the bucket
// size they have accumulated and (at the last one) the rounding.
StepToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return roundToStep(this.parent!.buildExpression(context), this.stepSize, RoundingType.Ceil);
};
StepMultiplierToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return roundToStep(this.parent!.parent!.buildExpression(context), this.stepSizeValue(), RoundingType.Ceil);
};
StepRoundingToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return roundToStep(this.parent!.parent!.parent!.buildExpression(context), this.stepSizeValue(), this.rounding);
};

/**
 * `MatchRank` → `ts_rank(<the entity's tsvector column>, <the tsquery the filters asked for>)`.
 *
 * Signum's `PgTsRankToken`: the rank is not a property of the row, it is a property of the row AGAINST
 * THIS SEARCH, so the expression is rebuilt from the query's own full-text filters on the same token —
 * which is why `BuildExpressionContext` carries them. With no such filter Signum answers a constant 0
 * (the column is selectable and simply scores nothing), and so does this.
 *
 * SQL SERVER IS REFUSED, deliberately. There is no scalar rank function there: `CONTAINS` / `FREETEXT`
 * are predicates only, and the score lives in the `RANK` column of a `CONTAINSTABLE` / `FREETEXTTABLE`
 * table-valued function the query has to JOIN against — which altea's full-text filters (inline
 * predicates, no join) do not build. Answering 0, or the Postgres shape, would be a silently wrong
 * ranking, so the token throws instead. See port/TranslationGaps.md C2.
 */
FullTextRankToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    if (!Connector.current().isPostgres)
        throw new Error(
            `The '${this.fullKey()}' (Match Rank) token is only supported on PostgreSQL. SQL Server exposes a ` +
            `full-text rank only through a CONTAINSTABLE / FREETEXTTABLE join, which altea's dynamic query ` +
            `does not build (it lowers a full-text filter to an inline CONTAINS / FREETEXT predicate).`);

    const parent = this.parent!;
    const queries = context.filters.map(f => f.tsQueryFor(parent)).notNull();
    if (queries.length === 0)
        return new ConstantExpression(0, LiteralType.number);
    // Several top-level filters are ANDed by `where`, so their tsqueries are ANDed too (`tsquery && tsquery`).
    const combined = queries.reduce((a, b) => new CallExpression(new PropertyExpression(a, "and"), [b], new TsQueryType()));

    // The tsvector column covers ALL of the entity's full-text columns, so it is read off the ROW, as the
    // TsQuery filter reads it — `parent` is the indexed string property, its own parent the entity.
    const entity = parent.parent!.buildExpression(context);
    const tsVector = new CallExpression(new PropertyExpression(entity, "getTsVectorColumn"), [], new TsVectorType());
    return new CallExpression(new PropertyExpression(tsVector, "rank"), [combined], LiteralType.number);
};

/**
 * `Distance` → the dialect's vector-distance function between the row's embedding column and the vector
 * the search asked for: `cosine_distance(col, v)` / `l2_distance` / … on Postgres (pgvector),
 * `VECTOR_DISTANCE('cosine', col, v)` on SQL Server. Port of Signum's `VectorDistanceToken`.
 *
 * Like `MatchRank` above, this is not a property of the row but a property of the row AGAINST THIS
 * SEARCH, so the query vector is rebuilt from the request's own filters on the same token — the
 * `SmartSearch` condition's prose, already resolved to a Vector by `SmartSearchLogic.resolveEmbeddings`,
 * or a Vector handed straight in by server-side code. With no such filter Signum answers a typed null
 * (the column is selectable and simply has nothing to measure against), and so does this.
 *
 * BOTH PROVIDERS ARE IMPLEMENTED, which Signum's SmartSearch filter is not (it gates its rewrite on
 * `Connector.Current is SqlServerConnector`); altea's vector substrate — `server/vectorSearch`, the
 * QueryBinder's bind*Vector* pair, the `VECTOR(n)` / `vector` casts — already covers both, so gating
 * would refuse a query the engine can run. The METRIC comes from the column's own `@vectorIndex`,
 * defaulting to Cosine on either dialect exactly as the SchemaBuilder defaults the real index.
 */
VectorDistanceToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const parent = this.parent!;
    const vector = context.filters.map(f => f.vectorFor(parent)).notNull()[0];
    if (vector == undefined)
        return new ConstantExpression(null, LiteralType.number);

    const column = parent.buildExpression(context);
    const options = parent.getPropertyRoute()?.fieldInfo?.vectorIndex;

    if (Connector.current().isPostgres) {
        const metric = options?.postgres?.metric ?? "Cosine";
        // `Hamming` / `Jaccard` index BIT vectors, and pgvector's distance functions for them
        // (hamming_distance / jaccard_distance) take a `bit`, not a `vector` — a different column type
        // altogether, which altea does not model. Refusing names the gap; silently measuring cosine
        // instead would rank by a metric the index was not built for.
        if (metric === "Hamming" || metric === "Jaccard")
            throw new Error(
                `The '${this.fullKey()}' (Distance) token cannot use the '${metric}' metric: pgvector measures it over a ` +
                `'bit' column (hamming_distance / jaccard_distance), and altea models a vector column as 'vector(N)' only.`);
        return new CallExpression(new PropertyExpression(new ConstantExpression(PgVectorSearch), "distance"),
            [new ConstantExpression(metric), column, new ConstantExpression(vector)], LiteralType.number);
    }

    const metric = options?.sqlServer?.metric ?? "Cosine";
    return new CallExpression(new PropertyExpression(new ConstantExpression(SqlVectorSearch), "vectorDistance"),
        [new ConstantExpression(metric), column, new ConstantExpression(vector)], LiteralType.number);
};

// `MatchSnippet` SELECTS THE TEXT ITSELF; the excerpt is computed from it afterwards, over the
// materialised rows (server/dynamicQuery/snippet.ts). Signum does the same thing one stage earlier, in
// the LINQ projector — `Highlighter.FindSnippet` is a CLR call it never translates to SQL either.
StringSnippetToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return this.parent!.buildExpression(context);
};

CountToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const collection = this.parent!.buildExpression(context);
    return new CallExpression(new PropertyExpression(collection, "count"), [], LiteralType.number);
};

// Collection element/quantifier/toArray + aggregate tokens are NOT self-contained: the expansion /
// select / group-by layers seed their expression in the replacements before navigation. Their own
// buildExpressionInternal therefore throws (matching Signum), guarding a mis-ordered pipeline.
CollectionElementToken.prototype.buildExpressionInternal = function (_context: BuildExpressionContext): Expression {
    throw new Error("CollectionElementToken should have a replacement at this stage (expand collections first — see queryExpansion.ts)");
};
CollectionAnyAllToken.prototype.buildExpressionInternal = function (_context: BuildExpressionContext): Expression {
    throw new Error("CollectionAnyAllToken should have a replacement at this stage (used inside a FilterGroup)");
};
CollectionToArrayToken.prototype.buildExpressionInternal = function (_context: BuildExpressionContext): Expression {
    throw new Error("CollectionToArrayToken is collected by the DQueryable select layer (map(...).join())");
};
AggregateToken.prototype.buildExpressionInternal = function (_context: BuildExpressionContext): Expression {
    throw new Error("AggregateToken should have a replacement at this stage (built by GroupBy)");
};

// The element parameter (so a FilterGroup can create the quantifier parameter).
CollectionAnyAllToken.prototype.createParameter = function (elementType: RuntimeType): ParameterExpression {
    // The element RuntimeType is passed in from the built collection expression (collection.type
    // .elementType) — the token's own `elementType` is a TypeReference, not a RuntimeType.
    const name = "_" + (elementType instanceof ClassType ? elementType.constructorFunction.name[0].toLowerCase() : "e");
    return new ParameterExpression(name, elementType);
};

// Port of Signum's BuildAnyAll: wrap the group's `body` in the quantifier over `collection`.
CollectionAnyAllToken.prototype.buildAnyAll = function (collection: Expression, param: ParameterExpression, body: Expression): Expression {
    let b = body;
    if (this.anyAllType === CollectionAnyAllType.NotAll)
        b = new UnaryExpression("!", b);

    const lambda = new LambdaExpression([param], b);
    const method = this.anyAllType === CollectionAnyAllType.All ? "every" : "some";
    let result: Expression = new CallExpression(new PropertyExpression(collection, method), [lambda], LiteralType.boolean);

    if (this.anyAllType === CollectionAnyAllType.NotAny)
        result = new UnaryExpression("!", result);

    return result;
};

// Build the aggregate over a group's `elements` (Signum's BuildAggregateExpressionEnumerable/
// Queryable). Reuses the original row parameter for the value/predicate lambdas.
AggregateToken.prototype.buildAggregate = function (elements: Expression, groupContext: BuildExpressionContext): Expression {
    const rowParam = groupContext.parameter;

    if (this.aggregateFunction === AggregateFunction.Count) {
        if (this.parent == undefined)
            return new PropertyExpression(elements, "length"); // COUNT(*) of the group

        const body = this.parent.buildExpression(groupContext);

        if (this.options.distinct) {
            // COUNT(DISTINCT body): map → distinct → count of non-null.
            const mapped = new CallExpression(new PropertyExpression(elements, "map"),
                [new LambdaExpression([rowParam], body)], new ArrayType(body.type));
            const distinct = new CallExpression(new PropertyExpression(mapped, "distinct"), [], mapped.type);
            const v = new ParameterExpression("_v", body.type);
            const notNull = new LambdaExpression([v], new BinaryExpression("!=", v, new ConstantExpression(null)));
            return new CallExpression(new PropertyExpression(distinct, "count"), [notNull], LiteralType.number);
        }

        // COUNT where <body> <op> <value>  (or non-null when no operation given).
        const predicate = this.options.filterOperation != undefined
            ? new BinaryExpression(COMPARE_OP[this.options.filterOperation], body, new ConstantExpression(this.options.value))
            : new BinaryExpression("!=", body, new ConstantExpression(null));
        return new CallExpression(new PropertyExpression(elements, "count"),
            [new LambdaExpression([rowParam], predicate)], LiteralType.number);
    }

    // Sum / Min / Max / Average → elements.<fn>(row => body).
    const body = this.parent!.buildExpression(groupContext);
    const method =
        this.aggregateFunction === AggregateFunction.Sum ? "sum" :
            this.aggregateFunction === AggregateFunction.Min ? "min" :
                this.aggregateFunction === AggregateFunction.Max ? "max" : "avg"; // the Array/queryable method is `avg`, not `average`
    // Result RuntimeType from the aggregate semantics + the built body expression (not token .type,
    // now a TypeReference): Average → number; Sum/Min/Max keep the aggregated value's type.
    const resultType = this.aggregateFunction === AggregateFunction.Average ? LiteralType.number : body.type;
    return new CallExpression(new PropertyExpression(elements, method),
        [new LambdaExpression([rowParam], body)], resultType);
};

ExtensionToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    if (buildExtensionExpr == undefined)
        throw new Error("ExtensionToken build hook not set (import logic/dynamicQuery/expressionContainer)");
    return buildExtensionExpr(this.info.serverInfo, this.parent!.buildExpression(context));
};

// An expression-with-parameter container (Signum's IndexerContainerToken.BuildExpressionInternal): its
// parent's expression — the child below applies the registered lambda to it with its key.
IndexerContainerToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return this.parent!.buildExpression(context);
};

ExtensionWithParameterToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    if (buildExtensionWithParameterExpr == undefined)
        throw new Error("ExtensionWithParameterToken build hook not set (import server/dynamicQuery/queryLogic)");
    return buildExtensionWithParameterExpr(this.parent.info.serverInfo, this.parameter.value, this.parent.buildExpression(context));
};

// Manual container (Signum's ManualContainerToken.BuildExpressionInternal): just its parent's entity
// expression — the leaf below wraps it into the ManualCellDto projection.
ManualContainerToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return this.parent!.buildExpression(context);
};

// Manual leaf (Signum's ManualToken.BuildExpressionInternal): `new ManualCellDTO(entity.ToLite(),
// containerKey, tokenKey)`. altea has no ManualCellDTO class registered, so it projects a plain object
// literal with the same shape (ObjectExpression) — the client's CellQuickLink formatter reads it.
ManualToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    const parentExpression = this.parent!.buildExpression(context);
    const entity = extractEntity(parentExpression, false);
    return new ObjectExpression({
        lite: buildLite(entity),
        manualContainerTokenKey: new ConstantExpression(this.parent!.key, LiteralType.string),
        manualTokenKey: new ConstantExpression(this.key, LiteralType.string),
    });
};

// ---- Operation tokens (Signum's OperationsContainerToken / OperationToken) -------------------

/**
 * What the `[Operations]` leaf needs from the registered operation to build its per-row expression —
 * Signum's `OperationToken.BuildExtension` seam, reduced to data so the whole expression assembly stays
 * here and `OperationLogic` needs no reference to the linq layer.
 */
export interface OperationTokenExpressionInfo {
    /** The QUOTED can-execute guard, if the operation declares one. */
    canExecuteExpression?: Quoted<(entity: any) => string | null>;
    /** The QUOTED state selector, if the operation participates in a state machine. */
    getState?: Quoted<(entity: any) => unknown>;
    /** The states the operation may run from (in the runtime form the entity's field holds). */
    fromStates?: readonly unknown[];
    /** EVERY member of the state enum, in that same form — the domain the state CASE enumerates. */
    allStates?: readonly unknown[];
    /** The enum object the states belong to, for their nice names in the refusal message. */
    stateEnum?: object;
}

// Set by OperationLogic.start. It THROWS for an operation that cannot be a column (Signum's
// "requires CanExecuteExpression to be used as query token"), so a stored column naming an operation
// that has since grown an in-memory-only guard fails loudly instead of rendering an always-enabled button.
let operationTokenInfo: ((operationKey: string, entityCtor: Type<Entity>) => OperationTokenExpressionInfo) | undefined;
export function setOperationTokenInfoProvider(fn: (operationKey: string, entityCtor: Type<Entity>) => OperationTokenExpressionInfo): void {
    operationTokenInfo = fn;
}

// Inline a quoted lambda's body over `target` (the same move ExpressionContainer.buildExtension makes
// for a registered expression): bind the tree, then substitute its single parameter.
function inlineQuotedLambda(lambda: Quoted<Function>, target: Expression): Expression {
    const bound = Expression.fromQuotedLambda(lambda as never, [target.type]);
    return new ParameterReplacer(bound.parameters[0]!, target).visit(bound.body);
}

class ParameterReplacer extends ExpressionVisitor {
    constructor(private readonly param: ParameterExpression, private readonly replacement: Expression) { super(); }
    override visitParameter(node: ParameterExpression): Expression {
        return node === this.param ? this.replacement : node;
    }
}

// Operations container (Signum's OperationsContainerToken.BuildExpressionInternal): its parent's
// expression verbatim — the leaf below is what turns it into a value.
OperationsContainerToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return this.parent!.buildExpression(context);
};

/**
 * Operation leaf (Signum's OperationToken.BuildExpressionInternal → OperationLogic.OperationToken_
 * BuildExpression): `new CellOperationDTO(entity.ToLite(), operationKey, canExecute)`. altea has no
 * registered CellOperationDTO class, so it projects an object literal of the same shape — the client's
 * "CellOperation" format rule reads `{ lite, operationKey, canExecute }`.
 *
 * `canExecute` is the interesting half, and it is the reason the column exists: it is computed IN SQL,
 * per row, so a page of buttons gets its disabled reasons without retrieving a single entity.
 *
 * altea divergence in the STATE refusal. Signum emits `state.NiceToString()` into the tree and lets its
 * provider translate the enum to its label; altea's provider has no such translation, so the whole
 * refusal is a CASE over CONSTANTS — one precomputed sentence per state the operation cannot run from,
 * selected by comparing the state column. Same output, no database-side localization, and the allowed
 * states simply fall through to the can-execute guard (or to null).
 */
OperationToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    if (operationTokenInfo == undefined)
        throw new Error("OperationToken build hook not set (OperationLogic.start has not run)");

    const info = operationTokenInfo(this.operation.operationKey, this.entityCtor);
    const parentExpression = this.parent!.buildExpression(context);
    const entity = extractEntity(parentExpression, false);

    let canExecute: Expression = info.canExecuteExpression != undefined
        ? inlineQuotedLambda(info.canExecuteExpression, entity)
        : new ConstantExpression(null, LiteralType.string);

    if (info.getState != undefined && info.fromStates != undefined && info.fromStates.length > 0) {
        if (info.allStates == undefined)
            throw new Error(`Operation '${this.operation.operationKey}' has states whose enum cannot be resolved, so it cannot be used as a query token`);
        const state = inlineQuotedLambda(info.getState, entity);
        for (const s of info.allStates) {
            // `inState` IS the sentence the in-memory guard produces, so a refusal reads identically
            // whether it came from the button or from the column. null ⇒ allowed, nothing to emit.
            const message = inState(s, info.stateEnum, ...info.fromStates);
            if (message == null)
                continue;
            canExecute = new ConditionalExpression(
                new BinaryExpression("==", state, new ConstantExpression(s)),
                new ConstantExpression(message, LiteralType.string),
                canExecute);
        }
    }

    return new ObjectExpression({
        lite: buildLite(entity),
        operationKey: new ConstantExpression(this.operation.operationKey, LiteralType.string),
        canExecute,
    });
};
