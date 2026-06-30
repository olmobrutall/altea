import { Expression } from "../expressions";
import {
    SelectExpression, SourceExpression, ScalarExpression, JoinExpression,
    ColumnExpression, ColumnDeclaration, AggregateExpression,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's ScalarSubqueryRewriter
// (Engine/Linq/ExpressionVisitor/ScalarSubqueryRewriter.cs).
//
// SQL Server forbids a scalar subquery as the argument of an aggregate
// (`MIN((SELECT …))` → "Cannot perform an aggregate function on an expression
// containing an aggregate or a subquery"). When that happens, lift the subquery to
// an OUTER APPLY on the enclosing select's FROM and reference its column instead.
// Postgres allows scalar subqueries inside aggregates, so this is a no-op there
// (Signum's `SupportsScalarSubqueryInAggregates`). Both dialects support scalar
// subqueries in SELECT/WHERE, so only the in-aggregate case is rewritten.
export class ScalarSubqueryRewriter extends DbExpressionVisitor {
    private inAggregate = false;
    private currentFrom: SourceExpression | undefined;

    constructor(private readonly isPostgres: boolean) { super(); }

    static rewrite(expression: Expression, isPostgres: boolean): Expression {
        return new ScalarSubqueryRewriter(isPostgres).visit(expression);
    }

    override visitAggregate(aggregate: AggregateExpression): Expression {
        const save = this.inAggregate;
        this.inAggregate = true;
        try {
            return super.visitAggregate(aggregate);
        } finally {
            this.inAggregate = save;
        }
    }

    override visitSelect(select: SelectExpression): Expression {
        const saveFrom = this.currentFrom;
        const saveInAggregate = this.inAggregate;
        this.inAggregate = false;

        let from = select.from == null ? undefined : this.visitSource(select.from);
        this.currentFrom = from;

        const top = this.visit(select.top);
        const where = this.visit(select.where);
        const columns = this.visitArray(select.columns, c => this.visitColumnDeclaration(c));
        const orderBy = this.visitArray(select.orderBy, o => this.visitOrderBy(o));
        const groupBy = this.visitArray(select.groupBy, g => this.visit(g));

        // VisitScalar may have spliced OUTER APPLYs onto currentFrom while visiting
        // the columns/where, so take the (possibly updated) source.
        from = this.currentFrom;

        this.inAggregate = saveInAggregate;
        this.currentFrom = saveFrom;

        if (top !== select.top || from !== select.from || where !== select.where ||
            columns !== select.columns || orderBy !== select.orderBy || groupBy !== select.groupBy)
            return new SelectExpression(select.alias, select.isDistinct, top, columns, from, where, orderBy, groupBy, select.selectOptions);
        return select;
    }

    override visitScalar(scalar: ScalarExpression): Expression {
        if (!this.inAggregate || this.isPostgres)
            return super.visitScalar(scalar);

        let select = scalar.select!;
        if (!select.columns[0].name) {
            select = new SelectExpression(select.alias, select.isDistinct, select.top,
                [new ColumnDeclaration("scalar", select.columns[0].expression)],
                select.from, select.where, select.orderBy, select.groupBy, select.selectOptions);
        }
        this.currentFrom = new JoinExpression("OuterApply", this.currentFrom!, select, undefined);
        return new ColumnExpression(scalar.type, select.alias, select.columns[0].name);
    }
}
