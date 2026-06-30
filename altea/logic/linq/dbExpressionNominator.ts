import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression, CallExpression, PropertyExpression,
    ParameterExpression, LambdaExpression,
} from "./expressions";
import {
    ColumnExpression, SqlConstantExpression, PrimaryKeyExpression,
    IsNullExpression, IsNotNullExpression, LikeExpression, SqlFunctionExpression,
    AggregateExpression, AggregateRequestsExpression, CaseExpression, ScalarExpression, ExistsExpression, InExpression,
    ProjectionExpression,
} from "./expressions.sql";
import { DbExpressionVisitor } from "./visitors/DbExpressionVisitor";

// Minimal port of Signum's DbExpressionNominator. Decides which expressions can
// be evaluated on the server: a node is a candidate iff its type is
// server-supported and all its descendants are candidates. The maximal candidate
// subtrees become columns in the SELECT.
//
// Like Signum's, this is a DbExpressionVisitor — dispatch is the usual `accept`
// double-dispatch, so every node type routes automatically (no manual instanceof
// table). The default base traversal already recurses into and *doesn't* nominate
// the client-materialised nodes (Entity / Embedded / Mixin / LiteReference /
// object & `new` literals), so those need no override here.
class DbExpressionNominator extends DbExpressionVisitor {
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

    // ---- leaf server values: always candidates ---------------------------

    override visitColumn(column: ColumnExpression): Expression {
        return this.add(column);
    }

    override visitSqlConstant(sqlConstant: SqlConstantExpression): Expression {
        return this.add(sqlConstant);
    }

    override visitConstant(constant: ConstantExpression): Expression {
        return this.add(constant);
    }

    // The id wrapper recurses to its column but is not itself a column candidate.
    override visitPrimaryKey(pk: PrimaryKeyExpression): Expression {
        this.visit(pk.value);
        return pk;
    }

    // ---- composite SQL nodes: candidate iff every operand is -------------

    override visitIsNull(node: IsNullExpression): Expression {
        super.visitIsNull(node);
        this.addIfAll(node, [node.expression]);
        return node;
    }

    override visitIsNotNull(node: IsNotNullExpression): Expression {
        super.visitIsNotNull(node);
        this.addIfAll(node, [node.expression]);
        return node;
    }

    override visitLike(node: LikeExpression): Expression {
        super.visitLike(node);
        this.addIfAll(node, [node.expression, node.pattern]);
        return node;
    }

    override visitSqlFunction(node: SqlFunctionExpression): Expression {
        super.visitSqlFunction(node);
        this.addIfAll(node, [node.object, ...node.arguments]);
        return node;
    }

    override visitAggregate(node: AggregateExpression): Expression {
        super.visitAggregate(node);
        this.addIfAll(node, node.arguments);
        return node;
    }

    // A deferred group aggregate is nominated as a whole (so the column projector
    // emits a column for it); its inner aggregate belongs to the group-by select's
    // scope, so we don't recurse. AggregateRewriter rewrites it into a real column
    // before formatting. Mirrors Signum's `!innerProjection → Add(request)`.
    override visitAggregateRequest(node: AggregateRequestsExpression): Expression {
        return this.add(node);
    }

    override visitCase(node: CaseExpression): Expression {
        super.visitCase(node);
        this.addIfAll(node, [...node.whens.flatMap(w => [w.condition, w.value]), node.defaultValue]);
        return node;
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

    // ---- self-contained subqueries: candidate as a whole, no recursion ---
    // (their inner columns belong to the subquery's own scope, not this one).

    override visitScalar(node: ScalarExpression): Expression {
        return this.add(node);
    }

    override visitExists(node: ExistsExpression): Expression {
        return this.add(node);
    }

    override visitIn(node: InExpression): Expression {
        return this.add(node);
    }

    // ---- non-server nodes: never recursed, never nominated ---------------
    // A child projection has its own scope; parameters/properties/calls/lambdas
    // are residual source nodes the reader handles, not server expressions.

    override visitProjection(node: ProjectionExpression): Expression {
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
