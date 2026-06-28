import {
    Expression, ConstantExpression, ParameterExpression, UnaryExpression,
    BinaryExpression, ConditionalExpression, PropertyExpression, CallExpression,
    LambdaExpression, ObjectExpression, NewExpression, CastExpression,
} from "../expressions";

// Port of .NET's System.Linq.Expressions.ExpressionVisitor. Identity-preserving:
// each Visit returns the same node reference when nothing changed (so passes can
// cheaply detect no-op subtrees), reconstructing via the node's `update*` method
// otherwise. Dispatch is double-dispatch: `visit(node)` calls `node.accept(this)`,
// which calls back the matching `visitXxx`. DbExpressionVisitor extends this and
// adds the DbExpression node methods (see dbExpressionVisitor.ts).
export class ExpressionVisitor {
    visit(node: Expression): Expression;
    visit(node: Expression | undefined): Expression | undefined;
    visit(node: Expression | undefined): Expression | undefined {
        return node == null ? undefined : node.accept(this);
    }

    // Visits an array, returning the SAME array reference when no element changed.
    visitArray<T>(nodes: readonly T[], visit: (node: T) => T): readonly T[] {
        let result: T[] | undefined;
        for (let i = 0; i < nodes.length; i++) {
            const visited = visit(nodes[i]);
            if (result == null && visited !== nodes[i])
                result = nodes.slice(0, i);
            if (result != null)
                result.push(visited);
        }
        return result ?? nodes;
    }


    visitConstant(node: ConstantExpression): Expression {
        return node;
    }

    visitParameter(node: ParameterExpression): Expression {
        return node;
    }

    visitUnary(node: UnaryExpression): Expression {
        return node.updateUnary(this.visit(node.expression));
    }

    visitBinary(node: BinaryExpression): Expression {
        return node.updateBinary(this.visit(node.left), this.visit(node.right));
    }

    visitConditional(node: ConditionalExpression): Expression {
        return node.updateConditional(this.visit(node.condition), this.visit(node.whenTrue), this.visit(node.whenFalse));
    }

    visitProperty(node: PropertyExpression): Expression {
        return node.updateProperty(this.visit(node.object));
    }

    visitCall(node: CallExpression): Expression {
        return node.updateCall(this.visit(node.func), this.visitArray(node.args, a => this.visit(a)));
    }

    visitLambda(node: LambdaExpression): Expression {
        const params = this.visitArray(node.parameters, p => this.visit(p) as ParameterExpression) as ParameterExpression[];
        return node.updateLambda(params, this.visit(node.body));
    }

    visitObject(node: ObjectExpression): Expression {
        let props: Record<string, Expression> | undefined;
        for (const [name, value] of Object.entries(node.properties)) {
            const visited = this.visit(value);
            if (visited !== value) {
                props ??= { ...node.properties };
                props[name] = visited;
            }
        }
        return props ? node.updateObject(props) : node;
    }

    visitNew(node: NewExpression): Expression {
        return node.updateNew(this.visitArray(node.args, a => this.visit(a)));
    }

    visitCast(node: CastExpression): Expression {
        return node.updateCast(this.visit(node.expression));
    }
}
