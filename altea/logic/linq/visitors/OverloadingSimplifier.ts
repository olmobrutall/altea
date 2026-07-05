
import { BinaryExpression, CallExpression, CastExpression, ConstantExpression, Expression, LambdaExpression, ParameterExpression, PropertyExpression } from "../expressions";
import { ExpressionVisitor } from "./ExpressionVisitor";
import { ClassType, LiteralType, Type } from "../../../entities/types";

// Port of Signum's OverloadingSimplifier — the pre-binding lowering pass. It does two things,
// both on the query-operator chain (which the front-end PartialEval in fromQuoted never touches):
//   1. Lowers "sugar" query operators — minBy/maxBy → orderBy+firstOrNull, cast/ofType →
//      map/filter — so the QueryBinder only ever sees the core operators.
//   2. Runs @methodExpander rewrites (e.g. inDB), which rewrite a call into another source
//      expression before binding (Signum's IMethodExpander.Expand).
// Constant folding is NOT done here: a parameter-free subtree is already folded to a constant
// while its lambda is converted (fromQuoted's PartialEval), so everything else just recurses
// through the base ExpressionVisitor.
export class OverloadingSimplifier extends ExpressionVisitor {
    static simplify(expression: Expression): Expression {
        return new OverloadingSimplifier().visit(expression);
    }

    visitCall(node: CallExpression): Expression {
        const func = this.visit(node.func);
        const args = this.visitArray(node.args, arg => this.visit(arg));

        // A @methodExpander method (e.g. inDB) rewrites itself into another source expression
        // here, before binding — Signum's IMethodExpander.Expand. The receiver is the call
        // target's object.
        if (node.methodExpander != null) {
            const instance = func instanceof PropertyExpression ? func.object : undefined;
            return this.visit(node.methodExpander(instance, args));
        }

        // Lower a "sugar" query operator to the core ones, so the QueryBinder only sees
        // map/filter/orderBy/firstOrNull (keeping that already-complex pass free of these).
        if (func instanceof PropertyExpression) {
            const rewritten = this.rewriteSugarOperator(func, args, node.type);
            if (rewritten != null)
                return rewritten;
        }

        return node.updateCall(func, args);
    }

    // Rewrite a "sugar" query operator on `source.op(args)` to a chain of core operators.
    // `source` (func.object) and `args` are already visited. Returns undefined for any other
    // method (left as a normal call).
    private rewriteSugarOperator(func: PropertyExpression, args: readonly Expression[], resultType: Type): Expression | undefined {
        const source = func.object;
        switch (func.propertyName) {
            // minBy/maxBy → orderBy[Descending](key).firstOrNull() — the element with the
            // smallest/largest projected key.
            case "minBy":
            case "maxBy": {
                const orderOp = func.propertyName === "minBy" ? "orderBy" : "orderByDescending";
                const ordered = new CallExpression(new PropertyExpression(source, orderOp), args, source.type);
                return new CallExpression(new PropertyExpression(ordered, "firstOrNull"), [], resultType);
            }
            // cast(T) → map(x => x as T) — narrow every element to T.
            case "cast":
                return new CallExpression(new PropertyExpression(source, "map"), [this.castLambda(source.type.elementType, args[0])], resultType);
            // ofType(T) → filter(x => x instanceof T).map(x => x as T) — keep the Ts, narrow.
            case "ofType": {
                const p = new ParameterExpression("x", source.type.elementType ?? LiteralType.null);
                const filter = new CallExpression(new PropertyExpression(source, "filter"),
                    [new LambdaExpression([p], new BinaryExpression("instanceof", p, args[0]))], source.type);
                return new CallExpression(new PropertyExpression(filter, "map"), [this.castLambda(filter.type.elementType, args[0])], resultType);
            }
        }
        return undefined;
    }

    // A `x => x as T` selector over an element of `elementType` (T from the ctor arg).
    private castLambda(elementType: Type | null, ctorArg: Expression): LambdaExpression {
        const p = new ParameterExpression("x", elementType ?? LiteralType.null);
        return new LambdaExpression([p], new CastExpression(p, new ClassType(this.ctorArg(ctorArg))));
    }

    // The constructor a `cast`/`ofType` type argument denotes (a captured ctor constant).
    private ctorArg(arg: Expression | undefined): Function {
        if (arg instanceof ConstantExpression && typeof arg.value === "function")
            return arg.value as Function;
        throw new Error(`cast/ofType expects a constructor argument, but got ${arg?.toString() ?? "nothing"}`);
    }
}
