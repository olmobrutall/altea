import type { Expression, ParameterExpression } from "./expressions";
import { ExpressionVisitor } from "./visitors/ExpressionVisitor";

// Port of Signum's `ExpressionReplacer.Replace(body, Dictionary<ParameterExpression, Expression>)` —
// substitute lambda parameters with arbitrary expressions. altea has no `Invoke` node, so splicing a
// lambda's body in place of a call to it means re-basing its parameters, and that is what this does.
//
// Three near-copies of it grew up independently (QueryBinder's ParamRebind, TypeConditionAlgebra's
// ParamReplacer / ExprReplacer, expressionContainer's ParameterReplacer). This is the shared one; the
// others stay where a module cannot import core, or where the local class carries extra behaviour.

export function replaceParameters(body: Expression, replacements: ReadonlyMap<ParameterExpression, Expression>): Expression {
    if (replacements.size === 0)
        return body;
    return new ParameterSubstituter(replacements).visit(body);
}

/** The single-parameter form — `replaceParameter(lambda.body, lambda.parameters[0], target)`. */
export function replaceParameter(body: Expression, from: ParameterExpression, to: Expression): Expression {
    return new ParameterSubstituter(new Map([[from, to]])).visit(body);
}

class ParameterSubstituter extends ExpressionVisitor {
    constructor(private readonly replacements: ReadonlyMap<ParameterExpression, Expression>) { super(); }

    override visitParameter(node: ParameterExpression): Expression {
        return this.replacements.get(node) ?? node;
    }
}
