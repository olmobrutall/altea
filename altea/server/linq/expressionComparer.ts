import {
    Expression, ConstantExpression, UnaryExpression, BinaryExpression, ConditionalExpression,
    PropertyExpression, IndexExpression, CallExpression, ParameterExpression, LambdaExpression,
    ObjectExpression, NewExpression, CastExpression,
} from "./expressions";
import {
    RuntimeType, ArrayType, FunctionType, LiteralType, ClassType, LiteType, TemporalType,
    TsVectorType, TsQueryType, VectorType, ObjectType, IntervalType, EnumType,
} from "../runtimeTypes";
import { Lite } from "../../data/lite";

// Port of Signum's `ExpressionComparer` (Signum/Utilities/ExpressionTrees) — STRUCTURAL equality of two
// expression trees, as opposed to reference equality.
//
// Scope: the FRONT-END tree (the shapes `Expression.fromQuotedLambda` and the query builders produce),
// which is what the callers need — comparing two post-binder DbExpression trees is a different job with a
// different notion of equality (aliases), and the binder has its own signature-based dedupe for that.
//
// Two lambda parameters are equal when they occupy the SAME POSITION in enclosing lambdas being compared
// together (Signum's `parameterScope`), so `a => a.name` equals `b => b.name`. A parameter reached from
// OUTSIDE both trees — the usual case for a captured/shared parameter, and the one the query auditor
// relies on — is compared by IDENTITY, since nothing else can tell two free variables apart.

export function expressionEquals(a: Expression | undefined, b: Expression | undefined): boolean {
    return new ExpressionComparer().compare(a, b);
}

/** Structural equality of two RUNTIME TYPES (Signum compares `Type` by reference; altea's RuntimeType is
 *  a value object minted per use, so it needs a comparison). */
export function runtimeTypeEquals(a: RuntimeType | undefined, b: RuntimeType | undefined): boolean {
    if (a === b)
        return true;
    if (a == null || b == null)
        return false;
    if (a.constructor !== b.constructor)
        return false;
    if (a instanceof LiteralType && b instanceof LiteralType)
        return a.typeName === b.typeName;
    if (a instanceof ClassType && b instanceof ClassType)
        return a.constructorFunction === b.constructorFunction;
    if (a instanceof LiteType && b instanceof LiteType)
        return runtimeTypeEquals(a.entityType, b.entityType);
    if (a instanceof ArrayType && b instanceof ArrayType)
        return runtimeTypeEquals(a.elementType, b.elementType);
    if (a instanceof TemporalType && b instanceof TemporalType)
        return a.kind === b.kind;
    if (a instanceof EnumType && b instanceof EnumType)
        return a.enumObject === b.enumObject;
    if (a instanceof IntervalType && b instanceof IntervalType)
        return runtimeTypeEquals(a.boundType, b.boundType);
    if (a instanceof FunctionType && b instanceof FunctionType)
        return a.func === b.func && runtimeTypeEquals(a.returnType, b.returnType);
    if (a instanceof ObjectType && b instanceof ObjectType) {
        const ak = Object.keys(a.bindings), bk = Object.keys(b.bindings);
        return ak.length === bk.length
            && ak.every(k => k in b.bindings && runtimeTypeEquals(a.bindings[k], b.bindings[k]));
    }
    // TsVectorType / TsQueryType / VectorType carry no state, so same-class is same-type.
    if (a instanceof TsVectorType || a instanceof TsQueryType || a instanceof VectorType)
        return true;
    return false;
}

class ExpressionComparer {
    // a-parameter → the b-parameter it is bound to, filled as matching lambdas are entered.
    private readonly parameterScope = new Map<ParameterExpression, ParameterExpression>();

    compare(a: Expression | undefined, b: Expression | undefined): boolean {
        if (a === b)
            return true;
        if (a == null || b == null)
            return false;
        if (a.kind !== b.kind)
            return false;

        if (a instanceof ConstantExpression && b instanceof ConstantExpression)
            return constantEquals(a.value, b.value);

        if (a instanceof ParameterExpression && b instanceof ParameterExpression) {
            const bound = this.parameterScope.get(a);
            // Bound by an enclosing lambda pair → positional equality; free → identity (a === b, already
            // ruled out above), so a free parameter never equals a different instance.
            return bound != null ? bound === b : false;
        }

        if (a instanceof UnaryExpression && b instanceof UnaryExpression)
            return a.kind === b.kind && this.compare(a.expression, b.expression);

        if (a instanceof BinaryExpression && b instanceof BinaryExpression)
            return a.kind === b.kind && this.compare(a.left, b.left) && this.compare(a.right, b.right);

        if (a instanceof ConditionalExpression && b instanceof ConditionalExpression)
            return this.compare(a.condition, b.condition)
                && this.compare(a.whenTrue, b.whenTrue)
                && this.compare(a.whenFalse, b.whenFalse);

        if (a instanceof PropertyExpression && b instanceof PropertyExpression)
            return a.propertyName === b.propertyName
                && a.isOptionalChaining === b.isOptionalChaining
                && this.compare(a.object, b.object);

        if (a instanceof IndexExpression && b instanceof IndexExpression)
            return this.compare(a.object, b.object) && this.compare(a.index, b.index);

        if (a instanceof CallExpression && b instanceof CallExpression)
            return a.isOptionalChaining === b.isOptionalChaining
                && this.compare(a.func, b.func)
                && this.compareList(a.args, b.args);

        if (a instanceof LambdaExpression && b instanceof LambdaExpression) {
            if (a.parameters.length !== b.parameters.length)
                return false;
            for (let i = 0; i < a.parameters.length; i++)
                this.parameterScope.set(a.parameters[i], b.parameters[i]);
            try {
                return this.compare(a.body, b.body);
            } finally {
                for (const p of a.parameters)
                    this.parameterScope.delete(p);
            }
        }

        if (a instanceof ObjectExpression && b instanceof ObjectExpression) {
            if (a.ctor !== b.ctor)
                return false;
            const ak = Object.keys(a.properties), bk = Object.keys(b.properties);
            return ak.length === bk.length
                && ak.every(k => k in b.properties && this.compare(a.properties[k], b.properties[k]));
        }

        if (a instanceof NewExpression && b instanceof NewExpression)
            return a.constructorFunction === b.constructorFunction && this.compareList(a.args, b.args);

        if (a instanceof CastExpression && b instanceof CastExpression)
            return runtimeTypeEquals(a.type, b.type) && this.compare(a.expression, b.expression);

        // A node kind this comparer does not model (a post-binder DbExpression, say) is only ever equal to
        // itself, which the reference check above already answered.
        return false;
    }

    private compareList(a: readonly Expression[], b: readonly Expression[]): boolean {
        return a.length === b.length && a.every((x, i) => this.compare(x, b[i]));
    }
}

// Two CAPTURED values are the same constant when they are the same object, or the same primitive, or two
// Lites of the same row. The Lite case is the one that matters here: a caller's `e.is(lite)` and a
// separately-built `e.is(lite2)` should agree when both lites point at the same entity, which is what
// `Lite.is` itself means.
function constantEquals(a: unknown, b: unknown): boolean {
    if (a === b)
        return true;
    if (a instanceof Lite && b instanceof Lite)
        return a.is(b);
    return false;
}
