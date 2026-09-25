import {
    Expression, CallExpression, ConstantExpression, LambdaExpression, ParameterExpression,
    PropertyExpression, BinaryExpression, CastExpression, ObjectExpression,
} from "@altea/altea/server/linq/expressions";
import { ExpressionVisitor } from "@altea/altea/server/linq/visitors/ExpressionVisitor";
import { replaceParameter } from "@altea/altea/server/linq/expressionReplacer";
import { expressionEquals, runtimeTypeEquals } from "@altea/altea/server/linq/expressionComparer";
import { isQuerySourceCall, querySourceCtor } from "@altea/altea/server/schema/filterQueryArgs";
import type { FilterQueryArgs } from "@altea/altea/server/schema/filterQueryArgs";
import { LiteType, ClassType, type RuntimeType } from "@altea/altea/server/runtimeTypes";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { Type, BaseEntity } from "@altea/altea/data/entity";

// Port of Signum.Authorization's Rules/QueryAuditorVisitor.cs — see port/Auth.md.
//
// READ THE CALLER'S OWN FILTERS. It exists for one kind of type condition,
// `registerWhenAlreadyFilteringBy`, whose rule is "you may read these rows BECAUSE you asked for them in
// a way that already constrains them to something you are allowed to read". Answering that means looking
// at the query the caller wrote, which is what `FilterQueryArgs` carries and what this walks.
//
// The walk folds the operator chain from the base query outwards, tracking three things:
//   • `param`     — a fresh parameter standing for one row of the BASE table;
//   • `projector` — what one row of the CURRENT (possibly projected) sequence is, expressed over `param`;
//   • `filters`   — every conjunct every `filter(...)` has applied so far, also expressed over `param`.
// A `map(...)` rewrites the projector; a `filter(...)` appends its (AND-split) predicate; the ordering /
// paging / distinct operators pass all three through unchanged; anything else DROPS the projector — after
// which no further filter is collected, because a predicate over an unknown shape says nothing about the
// base row. Reaching a node that is not part of the chain at all yields a fully opaque result.
//
// The fold is a plain recursive function returning a record, not a fake Expression node flowing through
// visitor dispatch. The operators are METHODS on `Query<T>`, so the switch is on the member name, and the
// pass-through set includes altea's own projector-preserving ones (`reverse`, `toArray`, `expandLite`,
// `expandEntity`).
//
// The equality recogniser matches `<receiver>.is(<arg>)` with the constant on EITHER side. (Signum's own
// version tests `mce.Arguments[0] is ConstantExpression` twice, so its second branch is unreachable —
// this is what the code plainly means.)

/** The state the fold carries. */
export interface FilterAuditorProjector {
    /** One row of the BASE table, or undefined when the shape is opaque. */
    readonly param: ParameterExpression | undefined;
    /** One row of the CURRENT sequence over `param`, or undefined once an operator loses track of it. */
    readonly projector: Expression | undefined;
    /** The conjuncts applied so far, over `param`. */
    readonly filters: readonly Expression[];
}

const OPAQUE: FilterAuditorProjector = { param: undefined, projector: undefined, filters: [] };

// Operators that change neither the row shape nor the filters (Distinct / Skip / Take / Order* /
// DisableQueryFilter / OrderAlsoByKeys, plus altea's own projector-preserving ones).
const PASS_THROUGH = new Set([
    "distinct", "skip", "top", "orderBy", "orderByDescending", "reverse", "orderAlsoByKeys",
    "toArray", "expandLite", "expandEntity", "disableQueryFilter",
]);

/**
 * Fold `args.fullQuery` down to what
 * is known about one row of `args.baseQuery`.
 */
export function filterAuditor(args: FilterQueryArgs): FilterAuditorProjector {
    return audit(args.fullQuery, args.baseQuery);
}

function audit(node: Expression, baseQuery: Expression): FilterAuditorProjector {
    // The seed: this IS the table the filter is being spliced onto.
    if (node === baseQuery) {
        const elementType = elementTypeOf(node);
        const param = new ParameterExpression(paramNameFor(elementType), elementType);
        return { param, projector: param, filters: [] };
    }

    // Anything but a query-operator call is outside the chain.
    if (!(node instanceof CallExpression) || !(node.func instanceof PropertyExpression))
        return OPAQUE;

    const property = node.func;
    const inner = audit(property.object, baseQuery);

    // Two early exits, IN THIS ORDER: an opaque source stays opaque, and a source whose PROJECTOR
    // is gone keeps its filters but collects no more (the ordering is load-bearing — a `filter` after the
    // projector was lost must not be read as a filter on the base row).
    if (inner.param == null)
        return OPAQUE;
    if (inner.projector == null)
        return { param: inner.param, projector: undefined, filters: inner.filters };

    const op = property.propertyName;

    if (op === "map") {
        const selector = node.args[0];
        if (!(selector instanceof LambdaExpression))
            return { param: inner.param, projector: undefined, filters: inner.filters };
        const replaced = replaceParameter(selector.body, selector.parameters[0], inner.projector);
        return { param: inner.param, projector: bindMembers(replaced), filters: inner.filters };
    }

    if (op === "filter") {
        const predicate = node.args[0];
        if (!(predicate instanceof LambdaExpression))
            return { param: inner.param, projector: undefined, filters: inner.filters };
        const replaced = replaceParameter(predicate.body, predicate.parameters[0], inner.projector);
        return {
            param: inner.param,
            projector: inner.projector,
            filters: [...inner.filters, ...splitAnds(bindMembers(replaced))],
        };
    }

    if (PASS_THROUGH.has(op))
        return inner;

    // Every other operator (an aggregate, `single()`, `groupBy`, …) keeps the filters and loses the shape.
    return { param: inner.param, projector: undefined, filters: inner.filters };
}

// The clean type name's capitals, lowercased — OperationLogEntity → "ol".
function paramNameFor(elementType: RuntimeType): string {
    const ctor = elementType instanceof ClassType ? elementType.constructorFunction : undefined;
    const name = ctor != null ? cleanTypeName(ctor as Type<BaseEntity>) : "e";
    const capitals = [...name].filter(c => c >= "A" && c <= "Z").join("").toLowerCase();
    return capitals.length > 0 ? capitals : "e";
}

function elementTypeOf(node: Expression): RuntimeType {
    if (isQuerySourceCall(node))
        return new ClassType(querySourceCtor(node));
    return node.type.elementType ?? node.type;
}

/**
 * A conjunction flattened into its conjuncts, so each can be
 * matched against the property independently.
 */
export function splitAnds(expression: Expression): Expression[] {
    const result: Expression[] = [];
    const walk = (e: Expression): void => {
        if (e instanceof BinaryExpression && (e.kind === "&&" || e.kind === "&")) {
            walk(e.left);
            walk(e.right);
        } else {
            result.push(e);
        }
    };
    walk(expression);
    return result;
}

/**
 * Resolve `<object literal>.member` to the member's own expression, so a
 * filter written over a PROJECTED shape is understood in terms of the base row:
 * `table(P).map(p => ({ c: p.country })).filter(x => x.c.name == "Germany")` has to read as a filter on
 * `p.country.name`. Signum also binds through anonymous types, tuples and groupings; here all of
 * those are the same ObjectExpression (a grouping projector is `{ key, elements }`), so one case covers it.
 */
export function bindMembers(body: Expression): Expression {
    return new MemberBinder().visit(body);
}

class MemberBinder extends ExpressionVisitor {
    override visitProperty(node: PropertyExpression): Expression {
        const object = this.visit(node.object);
        if (object instanceof ObjectExpression) {
            const member = object.properties[node.propertyName];
            if (member != null)
                return member;
        }
        return node.updateProperty(object);
    }
}

/**
 * Does this conjunct pin `replaced` to a
 * constant? Both `x == c` (either way round) and `x.is(c)` count.
 */
export function isEqualsConstant(replaced: Expression, condition: Expression): ConstantExpression | undefined {
    if (condition instanceof BinaryExpression && (condition.kind === "==" || condition.kind === "===")) {
        if (condition.left instanceof ConstantExpression && cleanEquals(condition.right, replaced))
            return condition.left;
        if (condition.right instanceof ConstantExpression && cleanEquals(condition.left, replaced))
            return condition.right;
    }

    // `<receiver>.is(<arg>)` — altea's entity/lite identity check.
    if (condition instanceof CallExpression
        && condition.func instanceof PropertyExpression
        && condition.func.propertyName === "is"
        && condition.args.length === 1) {
        const receiver = condition.func.object;
        const arg = condition.args[0];
        if (receiver instanceof ConstantExpression && cleanEquals(arg, replaced))
            return receiver;
        if (arg instanceof ConstantExpression && cleanEquals(receiver, replaced))
            return arg;
    }

    return undefined;
}

/**
 * Equal outright when the two are the same TYPE, otherwise equal once the
 * lite/entity wrapping is stripped off both, so `ol.target` and `ol.target.entity` are recognised as the
 * same thing.
 */
export function cleanEquals(a: Expression, b: Expression): boolean {
    if (runtimeTypeEquals(a.type, b.type))
        return expressionEquals(a, b);
    return expressionEquals(clean(a), clean(b));
}

// Peel a Lite's `.entity` / `.entityOrNull`, a `toLite()` / `toLiteFat()` call, and a cast.
function clean(e: Expression): Expression {
    if (e instanceof PropertyExpression
        && (e.propertyName === "entity" || e.propertyName === "entityOrNull")
        && e.object.type instanceof LiteType)
        return clean(e.object);

    if (e instanceof CallExpression
        && e.func instanceof PropertyExpression
        && (e.func.propertyName === "toLite" || e.func.propertyName === "toLiteFat"))
        return clean(e.func.object);

    if (e instanceof CastExpression)
        return clean(e.expression);

    return e;
}
