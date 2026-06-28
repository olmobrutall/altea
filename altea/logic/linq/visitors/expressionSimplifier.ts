
import { OpBinary, OpUnary } from "quote-transformer/quoted";
import { BinaryExpression, CallExpression, CastExpression, ConditionalExpression, ConstantExpression, Expression, LambdaExpression, NewExpression, ObjectExpression, ParameterExpression, PropertyExpression, UnaryExpression } from "../expressions";
import { ExpressionVisitor } from "./ExpressionVisitor";

export class ExpressionSimplifier extends ExpressionVisitor {
    visit(node: Expression): Expression;
    visit(node: Expression | undefined): Expression | undefined;
    visit(node: Expression | undefined): Expression | undefined {
        if (node == null)
            return undefined;

        const result = super.visit(node);
        if (result instanceof FastUndefined)
            return new ConstantExpression(undefined);

        return result;
    }

    visitBinary(node: BinaryExpression): Expression {
        switch (node.kind) {
            case "&&": {
                const left = this.visit(node.left);
                if (left instanceof ConstantExpression)
                    return left.value ? this.visit(node.right) : left;

                const right = this.visit(node.right);
                return node.updateBinary(left, right);
            }

            case "||": {
                const left = this.visit(node.left);
                if (left instanceof ConstantExpression)
                    return left.value ? left : this.visit(node.right);

                const right = this.visit(node.right);
                return node.updateBinary(left, right);
            }

            default: {
                const left = this.visit(node.left);
                const right = this.visit(node.right);

                if (!(left instanceof ConstantExpression) || !(right instanceof ConstantExpression))
                    return node.updateBinary(left, right);

                const value = evalBinary(left.value, right.value, node.kind);
                return new ConstantExpression(value);
            }
        }
    }

    visitUnary(node: UnaryExpression): Expression {
        const expression = this.visit(node.expression);
        if (!(expression instanceof ConstantExpression))
            return node.updateUnary(expression);

        const value = evalUnary(expression.value, node.kind);
        return new ConstantExpression(value);
    }

    visitConditional(node: ConditionalExpression): Expression {
        const condition = this.visit(node.condition);
        if (condition instanceof ConstantExpression)
            return condition.value ? this.visit(node.whenTrue) : this.visit(node.whenFalse);

        const whenTrue = this.visit(node.whenTrue);
        const whenFalse = this.visit(node.whenFalse);
        return node.updateConditional(condition, whenTrue, whenFalse);
    }

    visitProperty(node: PropertyExpression): Expression {
        const obj = this.visit(node.object);

        if (obj instanceof FastUndefined)
            return obj;

        if (obj instanceof ConstantExpression) {
            if (obj.value == null && node.isOptionalChaining)
                return new FastUndefined();

            return new ConstantExpression((obj.value as any)[node.propertyName]);
        }

        return node.updateProperty(obj);
    }

    visitCall(node: CallExpression): Expression {
        const func = this.visit(node.func);

        if (func instanceof FastUndefined)
            return func;

        if (func instanceof ConstantExpression && func.value == null && node.isOptionalChaining)
            return new FastUndefined();

        const args = this.visitArray(node.args, arg => this.visit(arg));
        return node.updateCall(func, args);
    }

    visitParameter(node: ParameterExpression): Expression {
        return node;
    }

    visitLambda(node: LambdaExpression): Expression {
        const parameters = this.visitArray(node.parameters, parameter => this.visit(parameter) as ParameterExpression) as ParameterExpression[];
        const body = this.visit(node.body);
        return node.updateLambda(parameters, body);
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

        const updated = props ? node.updateObject(props) : node;
        if (Object.values(updated.properties).every(value => value instanceof ConstantExpression)) {
            const values = Object.entries(updated.properties).map(([name, value]) => [name, (value as ConstantExpression).value]);
            return new ConstantExpression(Object.fromEntries(values));
        }

        return updated;
    }

    visitCast(node: CastExpression): Expression {
        const inner = this.visit(node.expression);
        if (inner instanceof ConstantExpression)
            return inner;

        return node.updateCast(inner);
    }

    visitNew(node: NewExpression): Expression {
        const args = this.visitArray(node.args, arg => this.visit(arg));

        if (args.every(arg => arg instanceof ConstantExpression)) {
            const values = args.map(arg => (arg as ConstantExpression).value);
            const value = new (node.constructorFunction as any)(...values);
            return new ConstantExpression(value);
        }

        return node.updateNew(args);
    }
}

class FastUndefined extends ConstantExpression {
    constructor() {
        super(undefined);
    }
}

export function expressionSimplifier() {
    return (e: Expression) => new ExpressionSimplifier().visit(e);
}

function evalUnary(a: unknown, op: OpUnary) {
    switch (op) {
        case "!": return !a;
        case "+u": return +(a as number);
        case "-u": return -(a as number);
        case "~": return ~(a as number);
        default: throw new Error(op);
    }
}

function evalBinary(a: unknown, b: unknown, op: OpBinary) {
    switch (op) {
        case "!=": return a != b;
        case "!==": return a !== b;
        case "%": return (a as number) % (b as number);
        case "&": return (a as number) & (b as number);
        case "&&": return (a as number) && (b as number);
        case "*": return (a as number) * (b as number);
        case "**": return (a as number) ** (b as number);
        case "+": return (a as number) + (b as number);
        case "-": return (a as number) - (b as number);
        case "/": return (a as number) / (b as number);
        case "<": return (a as number) < (b as number);
        case "<<": return (a as number) << (b as number);
        case "<=": return (a as number) <= (b as number);
        case "==": return (a as number) == (b as number);
        case "===": return (a as number) === (b as number);
        case ">": return (a as number) > (b as number);
        case ">=": return (a as number) >= (b as number);
        case ">>": return (a as number) >> (b as number);
        case ">>>": return (a as number) >> (b as number);
        case "??": return a ?? b;
        case "^": return (a as number) ^ (b as number);
        case "instanceof": return a instanceof (b as Function);
        case "|": return (a as number) | (b as number);
        case "||": return (a as number) || (b as number);
        default: throw new Error(op);
    }
}
