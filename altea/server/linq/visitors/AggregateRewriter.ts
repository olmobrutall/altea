import { Expression } from "../expressions";
import {
    SelectExpression, ColumnDeclaration, ColumnExpression, AggregateRequestsExpression,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's AggregateRewriter
// (Engine/Linq/ExpressionVisitor/AggregateRewriter.cs).
//
// An aggregate written over a grouping's elements (`g.elements.sum()`) is bound to
// an AggregateRequestsExpression that names the GROUP BY select it belongs to. This
// pass moves each such aggregate into that select as an extra `aggN` column, and
// replaces the request with a reference to that column. After it runs, the tree
// contains only ordinary aggregates-in-group-selects and plain column references.
//
// Ordering relies on the visitor visiting a select's `from` before its `columns`
// (DbExpressionVisitor.visitSelect): the inner GROUP BY select is rewritten — and
// the request→column map filled — before the outer select's columns (which hold
// the requests) are visited.
export class AggregateRewriter extends DbExpressionVisitor {
    // GROUP BY alias (as a string) → the requests deferred to it.
    private readonly lookup = new Map<string, AggregateRequestsExpression[]>();
    private readonly map = new Map<AggregateRequestsExpression, ColumnExpression>();

    private constructor(expr: Expression) {
        super();
        for (const ae of AggregateGatherer.gather(expr)) {
            const key = ae.groupByAlias.toString();
            const list = this.lookup.get(key);
            if (list != null)
                list.push(ae);
            else
                this.lookup.set(key, [ae]);
        }
    }

    static rewrite(expr: Expression): Expression {
        return new AggregateRewriter(expr).visit(expr);
    }

    override visitSelect(select: SelectExpression): Expression {
        select = super.visitSelect(select) as SelectExpression;
        const requests = this.lookup.get(select.alias.toString());
        if (requests != null && requests.length > 0) {
            const aggColumns: ColumnDeclaration[] = [...select.columns];
            for (const ae of requests) {
                const cd = new ColumnDeclaration("agg" + aggColumns.length, ae.aggregate);
                this.map.set(ae, cd.getReference(ae.groupByAlias));
                aggColumns.push(cd);
            }
            return new SelectExpression(select.alias, select.isDistinct, select.top, aggColumns, select.from, select.where, select.orderBy, select.groupBy, select.selectOptions, select.offset);
        }
        return select;
    }

    override visitAggregateRequest(request: AggregateRequestsExpression): Expression {
        const col = this.map.get(request);
        if (col == null)
            throw new Error("AggregateRequest was not hoisted into its GROUP BY select: " + request.toString());
        return col;
    }
}

class AggregateGatherer extends DbExpressionVisitor {
    private readonly aggregates: AggregateRequestsExpression[] = [];

    static gather(expr: Expression): AggregateRequestsExpression[] {
        const g = new AggregateGatherer();
        g.visit(expr);
        return g.aggregates;
    }

    override visitAggregateRequest(request: AggregateRequestsExpression): Expression {
        this.aggregates.push(request);
        return super.visitAggregateRequest(request);
    }
}
