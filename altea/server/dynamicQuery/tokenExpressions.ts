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
} from "../linq/expressions";
import { Entity } from "../../data/entity";
import { RuntimeType, ClassType, LiteType, ArrayType, LiteralType } from "../runtimeTypes";
import {
    QueryToken, RootToken, EntityPropertyToken, EntityToStringToken, HasValueToken, ObjectPropertyToken,
    AsTypeToken, DateToken, ModuloToken, CountToken,
    CollectionElementToken, CollectionAnyAllToken, CollectionAnyAllType, CollectionToArrayToken,
    AggregateToken, AggregateFunction, ExtensionToken,
    ManualContainerToken, ManualToken,
} from "../../data/dynamicQuery/tokens";

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
    ) { }
}

// ---- Expression helpers — the BuildExpression retarget onto altea's model -------------------
// Ports of Signum's ExtractEntity / BuildLiteNullifyUnwrapPrimaryKey (QueryUtils.cs). They emit
// altea `Expression` nodes the Phase-D binder already understands (`.entity`, `.toLite`).

function isEntityCtor(ctor: Function): boolean {
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

    // TODO(phase3): mixin route step → wrap `entity.mixin(M)`; ToString property.
    const entity = extractEntity(base, false);
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

DateToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return new PropertyExpression(this.parent!.buildExpression(context), "date");
};

ModuloToken.prototype.buildExpressionInternal = function (context: BuildExpressionContext): Expression {
    return new BinaryExpression("%", this.parent!.buildExpression(context), new ConstantExpression(this.divisor));
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
