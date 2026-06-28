import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression, ObjectExpression, NewExpression,
    CallExpression, PropertyExpression, ParameterExpression, LambdaExpression,
} from "./expressions";
import {
    ColumnExpression, SqlConstantExpression, PrimaryKeyExpression,
    IsNullExpression, IsNotNullExpression, LikeExpression, SqlFunctionExpression,
    AggregateExpression, CaseExpression, ScalarExpression, ExistsExpression, InExpression,
    EntityExpression, EmbeddedEntityExpression, MixinEntityExpression, ProjectionExpression,
} from "./expressions.sql";
import { ExpressionVisitor } from "./visitors/ExpressionVisitor";

// Minimal port of Signum's DbExpressionNominator. Decides which expressions can
// be evaluated on the server: a node is a candidate iff its type is
// server-supported and all its descendants are candidates. The maximal candidate
// subtrees become columns in the SELECT.

class DbExpressionNominator extends ExpressionVisitor {
    private readonly candidates = new Set<Expression>();

    static nominate(expr: Expression): Set<Expression> {
        const n = new DbExpressionNominator();
        n.visit(expr);
        return n.candidates;
    }

    private add<T extends Expression>(expression: T): T {
        this.candidates.add(expression);
        return expression;
    }

    private has(expression: Expression | undefined): boolean {
        return expression != null && this.candidates.has(expression);
    }

    private addIfAll(node: Expression, children: readonly (Expression | undefined)[]): void {
        if (children.every(c => c == null || this.has(c)))
            this.add(node);
    }

    override visit(expr: Expression): Expression;
    override visit(expr: Expression | undefined): Expression | undefined;
    override visit(expr: Expression | undefined): Expression | undefined {
        if (expr == null)
            return undefined;

        if (expr instanceof ColumnExpression) return this.visitColumn(expr);
        if (expr instanceof SqlConstantExpression) return this.visitSqlConstant(expr);
        if (expr instanceof PrimaryKeyExpression) return this.visitPrimaryKey(expr);
        if (expr instanceof IsNullExpression) return this.visitIsNull(expr);
        if (expr instanceof IsNotNullExpression) return this.visitIsNotNull(expr);
        if (expr instanceof LikeExpression) return this.visitLike(expr);
        if (expr instanceof SqlFunctionExpression) return this.visitSqlFunction(expr);
        if (expr instanceof AggregateExpression) return this.visitAggregate(expr);
        if (expr instanceof CaseExpression) return this.visitCase(expr);
        if (expr instanceof ScalarExpression) return this.visitScalar(expr);
        if (expr instanceof ExistsExpression) return this.visitExists(expr);
        if (expr instanceof InExpression) return this.visitIn(expr);
        if (expr instanceof EntityExpression) return this.visitEntity(expr);
        if (expr instanceof EmbeddedEntityExpression) return this.visitEmbeddedEntity(expr);
        if (expr instanceof MixinEntityExpression) return this.visitMixinEntity(expr);
        if (expr instanceof ProjectionExpression) return this.visitProjection(expr);

        return super.visit(expr);
    }

    private visitColumn(column: ColumnExpression): Expression {
        return this.add(column);
    }

    private visitSqlConstant(sqlConstant: SqlConstantExpression): Expression {
        return this.add(sqlConstant);
    }

    override visitConstant(constant: ConstantExpression): Expression {
        return this.add(constant);
    }

    private visitPrimaryKey(pk: PrimaryKeyExpression): Expression {
        this.visit(pk.value);
        return pk;
    }

    override visitUnary(node: UnaryExpression): Expression {
        super.visitUnary(node);
        this.addIfAll(node, [node.expression]);
        return node;
    }

    override visitCast(node: CastExpression): Expression {
        super.visitCast(node);
        this.addIfAll(node, [node.expression]);
        return node;
    }

    private visitIsNull(node: IsNullExpression): Expression {
        this.visit(node.expression);
        this.addIfAll(node, [node.expression]);
        return node;
    }

    private visitIsNotNull(node: IsNotNullExpression): Expression {
        this.visit(node.expression);
        this.addIfAll(node, [node.expression]);
        return node;
    }

    override visitBinary(node: BinaryExpression): Expression {
        super.visitBinary(node);
        this.addIfAll(node, [node.left, node.right]);
        return node;
    }

    override visitConditional(node: ConditionalExpression): Expression {
        super.visitConditional(node);
        this.addIfAll(node, [node.condition, node.whenTrue, node.whenFalse]);
        return node;
    }

    private visitLike(node: LikeExpression): Expression {
        this.visit(node.expression);
        this.visit(node.pattern);
        this.addIfAll(node, [node.expression, node.pattern]);
        return node;
    }

    private visitSqlFunction(node: SqlFunctionExpression): Expression {
        this.visit(node.object);
        node.arguments.forEach(a => this.visit(a));
        this.addIfAll(node, [node.object, ...node.arguments]);
        return node;
    }

    private visitAggregate(node: AggregateExpression): Expression {
        node.arguments.forEach(a => this.visit(a));
        this.addIfAll(node, node.arguments);
        return node;
    }

    private visitCase(node: CaseExpression): Expression {
        node.whens.forEach(w => {
            this.visit(w.condition);
            this.visit(w.value);
        });
        this.visit(node.defaultValue);
        this.addIfAll(node, [...node.whens.flatMap(w => [w.condition, w.value]), node.defaultValue]);
        return node;
    }

    private visitScalar(node: ScalarExpression): Expression {
        return this.add(node);
    }

    private visitExists(node: ExistsExpression): Expression {
        return this.add(node);
    }

    private visitIn(node: InExpression): Expression {
        return this.add(node);
    }

    private visitEntity(node: EntityExpression): Expression {
        this.visit(node.externalId);
        node.bindings?.forEach(b => this.visit(b.binding));
        node.mixins?.forEach(m => this.visit(m));
        return node;
    }

    private visitEmbeddedEntity(node: EmbeddedEntityExpression): Expression {
        this.visit(node.hasValue);
        node.bindings.forEach(b => this.visit(b.binding));
        node.mixins?.forEach(m => this.visit(m));
        return node;
    }

    private visitMixinEntity(node: MixinEntityExpression): MixinEntityExpression {
        node.bindings.forEach(b => this.visit(b.binding));
        return node;
    }

    override visitObject(node: ObjectExpression): Expression {
        Object.values(node.properties).forEach(v => this.visit(v));
        return node;
    }

    override visitNew(node: NewExpression): Expression {
        node.args.forEach(a => this.visit(a));
        return node;
    }

    private visitProjection(node: ProjectionExpression): Expression {
        return node;
    }

    override visitParameter(node: ParameterExpression): Expression {
        return node;
    }

    override visitProperty(node: PropertyExpression): Expression {
        return node;
    }

    override visitCall(node: CallExpression): Expression {
        return node;
    }

    override visitLambda(node: LambdaExpression): Expression {
        return node;
    }
}

export function nominate(expr: Expression): Set<Expression> {
    return DbExpressionNominator.nominate(expr);
}
