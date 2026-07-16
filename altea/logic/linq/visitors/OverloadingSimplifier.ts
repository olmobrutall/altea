
import { BinaryExpression, CallExpression, CastExpression, ConditionalExpression, ConstantExpression, Expression, LambdaExpression, ParameterExpression, PropertyExpression } from "../expressions";
import { ExpressionVisitor } from "./ExpressionVisitor";
import { ClassType, LiteralType, RuntimeType } from "../../../entities/runtimeTypes";

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

    // Signum's OverloadingSimplifier.VisitBinary: a mixed-type string concatenation
    // (`a + ""` where one side is a string and the other is not) becomes a real
    // string concat of both sides run through CallToString. Without this the non-string
    // operand (e.g. a whole entity) stays raw and the binder never lowers it to its
    // ToString, so the formatter flattens all its columns into a garbage identifier.
    visitBinary(node: BinaryExpression): Expression {
        const b = super.visitBinary(node) as BinaryExpression;
        if (b instanceof BinaryExpression && b.kind === "+"
            && isStringType(b.left.type) !== isStringType(b.right.type))
            return new BinaryExpression("+", this.callToString(b.left), this.callToString(b.right));
        return b;
    }

    // Signum's CallToString: coerce an operand to string for concatenation. A string
    // is already fine; a constant folds to its string value; anything else (an entity,
    // lite or value) becomes `expr == null ? null : expr.toString()` — the null-guarded
    // ToString the binder then lowers (an entity → its ToStr column, a value → a CAST).
    private callToString(expr: Expression): Expression {
        if (isStringType(expr.type))
            return expr;
        if (expr instanceof ConstantExpression)
            return new ConstantExpression(expr.value == null ? null : String(expr.value), LiteralType.string);
        const toStr = new CallExpression(new PropertyExpression(expr, "toString"), [], LiteralType.string);
        return new ConditionalExpression(
            new BinaryExpression("==", expr, new ConstantExpression(null)),
            new ConstantExpression(null, LiteralType.string),
            toStr);
    }

    // Rewrite a "sugar" query operator on `source.op(args)` to a chain of core operators.
    // `source` (func.object) and `args` are already visited. Returns undefined for any other
    // method (left as a normal call).
    private rewriteSugarOperator(func: PropertyExpression, args: readonly Expression[], resultType: RuntimeType): Expression | undefined {
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
    private castLambda(elementType: RuntimeType | null, ctorArg: Expression): LambdaExpression {
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

// Signum's `type == typeof(string)` test for the mixed-concat rule.
function isStringType(type: RuntimeType): boolean {
    return type === LiteralType.string;
}
