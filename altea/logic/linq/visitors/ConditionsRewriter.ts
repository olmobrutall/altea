import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression,
} from "../expressions";
import {
    SelectExpression, ProjectionExpression, JoinExpression, ColumnDeclaration,
    OrderExpression, CaseExpression, When, AggregateExpression, SqlFunctionExpression,
    SqlConstantExpression, LikeExpression, InExpression, ExistsExpression,
    IsNullExpression, IsNotNullExpression, SourceExpression,
    DeleteExpression, UpdateExpression, InsertSelectExpression, CommandAggregateExpression,
    ColumnAssignment, SourceWithAliasExpression,
} from "../expressions.sql";
import { LiteralType } from "../../../entities/types";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's ConditionsRewriter
// (Engine/Linq/ExpressionVisitor/ConditionsRewriter.cs).
//
// SQL has no first-class boolean usable in every position the way C#/JS does. A
// boolean must appear either as a CONDITION (a predicate: WHERE, JOIN ON, CASE
// WHEN, operand of AND/OR/NOT) or as a VALUE (a bit, e.g. a SELECT column, an
// ORDER BY key, an operand of `=`/COALESCE). This pass walks the SQL part of the
// tree (inSql) and inserts the conversions:
//   value→condition:  `bit`            ⇒ `bit = 1`
//   condition→value:  `a < b`          ⇒ `CASE WHEN a < b THEN 1 ELSE 0 END`
//
// Postgres has a native boolean type and needs none of this (its rewriter is a
// near no-op), so the pipeline runs THIS pass only for SQL Server. Scoped to
// altea's node set (no SqlCast / TVF / command nodes). Three-valued (nullable)
// boolean handling is simplified — altea has no distinct nullable-bool Type yet.
export class ConditionsRewriter extends DbExpressionVisitor {
    private inSql = false;

    static rewrite(expression: Expression): Expression {
        return new ConditionsRewriter().visit(expression);
    }

    private static readonly trueCondition = new BinaryExpression("==", new SqlConstantExpression(1, LiteralType.number), new SqlConstantExpression(1, LiteralType.number));
    private static readonly falseCondition = new BinaryExpression("==", new SqlConstantExpression(1, LiteralType.number), new SqlConstantExpression(0, LiteralType.number));

    private withInSql<T>(action: () => T): T {
        const old = this.inSql;
        this.inSql = true;
        try { return action(); } finally { this.inSql = old; }
    }

    // ---- the two conversions ---------------------------------------------

    private makeSqlCondition(exp: Expression | undefined): Expression | undefined {
        if (exp == null)
            return undefined;
        if (!this.inSql || !ConditionsRewriter.isBoolean(exp))
            return exp;

        if (exp instanceof ConstantExpression)
            return exp.value === true ? ConditionsRewriter.trueCondition : ConditionsRewriter.falseCondition;

        if (ConditionsRewriter.isSqlCondition(exp))
            return exp;

        // a boolean VALUE in predicate position → `value = 1`
        return new BinaryExpression("==", exp, new SqlConstantExpression(true, LiteralType.boolean));
    }

    private makeSqlValue(exp: Expression | undefined): Expression | undefined {
        if (exp == null)
            return undefined;
        if (!this.inSql || !ConditionsRewriter.isBoolean(exp))
            return exp;

        if (exp instanceof ConstantExpression)
            return new SqlConstantExpression(exp.value == null ? null : exp.value === true ? 1 : 0, LiteralType.boolean);

        if (!ConditionsRewriter.isSqlCondition(exp))
            return exp;

        // a CONDITION in value position → CASE WHEN cond THEN 1 ELSE 0 END
        return new CaseExpression(
            [new When(exp, new SqlConstantExpression(true, LiteralType.boolean))],
            new SqlConstantExpression(false, LiteralType.boolean));
    }

    private static isBoolean(exp: Expression): boolean {
        return exp.type === LiteralType.boolean;
    }

    // Is `exp` already a SQL predicate (vs a boolean value)?
    private static isSqlCondition(exp: Expression): boolean {
        if (exp instanceof BinaryExpression) {
            switch (exp.kind) {
                case "==": case "!=": case "===": case "!==":
                case "<": case "<=": case ">": case ">=":
                case "&&": case "||": case "&": case "|": case "^":
                    return true;
                default: // "??" (coalesce) and arithmetic are values
                    return false;
            }
        }
        if (exp instanceof UnaryExpression)
            return exp.kind === "!";
        if (exp instanceof LikeExpression || exp instanceof InExpression
            || exp instanceof ExistsExpression || exp instanceof IsNullExpression
            || exp instanceof IsNotNullExpression)
            return true;
        // Column / Case / Conditional / SqlConstant / Constant / SqlFunction /
        // Projection / Cast → boolean VALUE, not a condition.
        return false;
    }

    private isTrue(exp: Expression): boolean {
        return exp === ConditionsRewriter.trueCondition || (exp instanceof SqlConstantExpression && exp.value === 1);
    }

    private isFalse(exp: Expression): boolean {
        return exp === ConditionsRewriter.falseCondition || (exp instanceof SqlConstantExpression && exp.value === 0);
    }

    // ---- visitor overrides ------------------------------------------------

    override visitBinary(b: BinaryExpression): Expression {
        if (b.kind === "&&")
            return this.smartAnd(this.visit(b.left), this.visit(b.right));
        if (b.kind === "||")
            return this.smartOr(this.visit(b.left), this.visit(b.right));
        if (b.kind === "^")
            return new BinaryExpression("^", this.makeSqlCondition(this.visit(b.left))!, this.makeSqlCondition(this.visit(b.right))!);

        if (b.kind === "==" || b.kind === "!=" || b.kind === "===" || b.kind === "!=="
            || b.kind === "<" || b.kind === "<=" || b.kind === ">" || b.kind === ">="
            || b.kind === "??") {
            const left = this.makeSqlValue(this.visit(b.left))!;
            const right = this.makeSqlValue(this.visit(b.right))!;
            return b.updateBinary(left, right);
        }

        return super.visitBinary(b);
    }

    private smartAnd(left: Expression, right: Expression): Expression {
        if (this.isFalse(left) || this.isFalse(right)) return ConditionsRewriter.falseCondition;
        if (this.isTrue(left)) return right;
        if (this.isTrue(right)) return left;
        return new BinaryExpression("&&", this.makeSqlCondition(left)!, this.makeSqlCondition(right)!);
    }

    private smartOr(left: Expression, right: Expression): Expression {
        if (this.isTrue(left) || this.isTrue(right)) return ConditionsRewriter.trueCondition;
        if (this.isFalse(left)) return right;
        if (this.isFalse(right)) return left;
        return new BinaryExpression("||", this.makeSqlCondition(left)!, this.makeSqlCondition(right)!);
    }

    override visitUnary(u: UnaryExpression): Expression {
        if (u.kind === "!") {
            const op = this.visit(u.expression);
            if (this.isTrue(op)) return ConditionsRewriter.falseCondition;
            if (this.isFalse(op)) return ConditionsRewriter.trueCondition;
            return u.updateUnary(this.makeSqlCondition(op)!);
        }
        return super.visitUnary(u);
    }

    override visitConditional(c: ConditionalExpression): Expression {
        const condition = this.makeSqlCondition(this.visit(c.condition))!;
        const whenTrue = this.makeSqlValue(this.visit(c.whenTrue))!;
        const whenFalse = this.makeSqlValue(this.visit(c.whenFalse))!;
        return c.updateConditional(condition, whenTrue, whenFalse);
    }

    override visitCase(cex: CaseExpression): Expression {
        const whens = this.visitArray(cex.whens, w => this.visitWhen(w));
        const def = this.makeSqlValue(this.visit(cex.defaultValue));
        if (whens !== cex.whens || def !== cex.defaultValue)
            return new CaseExpression(whens, def);
        return cex;
    }

    override visitWhen(w: When): When {
        const condition = this.makeSqlCondition(this.visit(w.condition))!;
        const value = this.makeSqlValue(this.visit(w.value))!;
        if (condition !== w.condition || value !== w.value)
            return new When(condition, value);
        return w;
    }

    override visitAggregate(a: AggregateExpression): Expression {
        const args = this.visitArray(a.arguments, x => this.makeSqlValue(this.visit(x))!);
        const orderBy = a.orderBy == null ? undefined : this.visitArray(a.orderBy, o => this.visitOrderBy(o));
        if (args !== a.arguments || orderBy !== a.orderBy)
            return new AggregateExpression(a.type, a.aggregateFunction, args, orderBy);
        return a;
    }

    override visitSqlFunction(fn: SqlFunctionExpression): Expression {
        const obj = this.makeSqlValue(this.visit(fn.object));
        const args = this.visitArray(fn.arguments, a => this.makeSqlValue(this.visit(a))!);
        if (obj !== fn.object || args !== fn.arguments)
            return new SqlFunctionExpression(fn.type, obj, fn.sqlFunction, args);
        return fn;
    }

    override visitIsNull(isNull: IsNullExpression): Expression {
        const e = this.makeSqlValue(this.visit(isNull.expression))!;
        return e !== isNull.expression ? new IsNullExpression(e) : isNull;
    }

    override visitIsNotNull(isNotNull: IsNotNullExpression): Expression {
        const e = this.makeSqlValue(this.visit(isNotNull.expression))!;
        return e !== isNotNull.expression ? new IsNotNullExpression(e) : isNotNull;
    }

    override visitColumnDeclaration(c: ColumnDeclaration): ColumnDeclaration {
        const e = this.makeSqlValue(this.visit(c.expression))!;
        return e !== c.expression ? new ColumnDeclaration(c.name, e) : c;
    }

    override visitOrderBy(o: OrderExpression): OrderExpression {
        const e = this.makeSqlValue(this.visit(o.expression))!;
        return e !== o.expression ? new OrderExpression(o.orderType, e) : o;
    }

    override visitJoin(join: JoinExpression): Expression {
        const left = this.visitSource(join.left);
        const right = this.visitSource(join.right);
        const condition = this.makeSqlCondition(this.visit(join.condition));
        if (left !== join.left || right !== join.right || condition !== join.condition)
            return new JoinExpression(join.joinType, left, right, condition);
        return join;
    }

    override visitSelect(select: SelectExpression): Expression {
        const top = this.visit(select.top);
        const from = select.from == null ? undefined : this.visitSource(select.from);
        const where = this.makeSqlCondition(this.visit(select.where));
        const columns = this.visitArray(select.columns, c => this.visitColumnDeclaration(c));
        const orderBy = this.visitArray(select.orderBy, o => this.visitOrderBy(o));
        const groupBy = this.visitArray(select.groupBy, g => this.makeSqlValue(this.visit(g))!);
        const offset = this.visit(select.offset);

        if (top !== select.top || from !== select.from || where !== select.where
            || columns !== select.columns || orderBy !== select.orderBy || groupBy !== select.groupBy
            || offset !== select.offset)
            return new SelectExpression(select.alias, select.isDistinct, top, columns, from as SourceExpression | undefined, where, orderBy, groupBy, select.selectOptions, offset);
        return select;
    }

    override visitProjection(proj: ProjectionExpression): Expression {
        const source = this.withInSql(() => this.visit(proj.select) as SelectExpression);
        const projector = this.visit(proj.projector);
        if (source !== proj.select || projector !== proj.projector)
            return new ProjectionExpression(source, projector, proj.uniqueFunction, proj.type);
        return proj;
    }

    // A command runs entirely in SQL. Signum sets this once in VisitCommandAggregate
    // (InSql()) for the whole aggregate; altea's command pipeline rewrites each sub-command
    // on its own, so every command entry (delete/update/insert) also establishes the in-SQL
    // scope. Without it a command's source SELECT is visited with inSql=false and a bare
    // boolean column in its WHERE (`WHERE A1.Dead`) is left unconverted — SQL Server error
    // 4145 (non-boolean type where a condition is expected); wrapping yields `WHERE (A1.Dead = 1)`.
    override visitCommandAggregate(cea: CommandAggregateExpression): Expression {
        return this.withInSql(() => super.visitCommandAggregate(cea));
    }

    // Signum has no VisitDelete — its VisitCommandAggregate InSql() + the base visitor
    // suffice. Here the per-command entry sets inSql so the source SELECT's WHERE gets
    // condition-normalised (the DELETE's own where is already a correlation comparison).
    override visitDelete(del: DeleteExpression): Expression {
        return this.withInSql(() => super.visitDelete(del));
    }

    // Signum's VisitUpdate: the SET values are SQL VALUES (a boolean condition assigned to a
    // bit column becomes `CASE … END`, a bare bool stays a bit). Wrapped in inSql for altea's
    // per-command pipeline; the WHERE is the target↔source correlation (already a condition).
    override visitUpdate(update: UpdateExpression): Expression {
        return this.withInSql(() => {
            const source = this.visitSource(update.source) as SourceWithAliasExpression;
            const where = this.visit(update.where);
            const assignments = this.visitArray(update.assignments, a => this.visitAssignmentValue(a));
            if (source !== update.source || where !== update.where || assignments !== update.assignments)
                return new UpdateExpression(update.table, source, where, assignments, update.returnRowCount);
            return update;
        });
    }

    // Signum's VisitInsertSelect: like VisitUpdate, sans WHERE.
    override visitInsertSelect(insert: InsertSelectExpression): Expression {
        return this.withInSql(() => {
            const source = this.visitSource(insert.source) as SourceWithAliasExpression;
            const assignments = this.visitArray(insert.assignments, a => this.visitAssignmentValue(a));
            if (source !== insert.source || assignments !== insert.assignments)
                return new InsertSelectExpression(insert.table, source, assignments, insert.returnRowCount);
            return insert;
        });
    }

    // A column-assignment value is a SQL value (Signum inlines MakeSqlValue in VisitUpdate/
    // VisitInsertSelect). No-op for a non-boolean value; a bit/condition is normalised.
    private visitAssignmentValue(c: ColumnAssignment): ColumnAssignment {
        const exp = this.makeSqlValue(this.visit(c.expression))!;
        return exp !== c.expression ? new ColumnAssignment(c.column, exp) : c;
    }
}
