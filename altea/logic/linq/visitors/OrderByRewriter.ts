import { Expression, BinaryExpression, ConstantExpression, UnaryExpression } from "../expressions";
import {
    SelectExpression, ProjectionExpression, JoinExpression, TableExpression,
    ScalarExpression, ExistsExpression, InExpression, SourceExpression,
    ColumnExpression, OrderExpression, SqlConstantExpression,
    AggregateExpression, IsNullExpression, SelectOptions,
} from "../expressions.sql";
import { LiteralType } from "../../../entities/runtimeTypes";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's OrderByRewriter (Engine/Linq/ExpressionVisitor/OrderByRewriter.cs).
//
// SQL forbids ORDER BY inside a derived table/subquery unless it also carries TOP
// (SQL Server is strict about this; Postgres tolerates it but the result order is
// not guaranteed). This pass GATHERS the ORDER BY of inner selects bottom-up,
// strips them from those inner selects, and re-emits the accumulated ordering only
// where it is meaningful: at the outermost SELECT, or at a SELECT that has TOP.
// It also resolves the SelectOptions.Reverse flag (Signum's IsReverse) by
// inverting the gathered ordering directions.
//
// Scoped to altea's current node set. Signum additionally handles RowNumber,
// SetOperator, ForXml/string_agg scalars and the OrderAlsoByKeys/HasIndex key
// machinery (used by skip/groupBy paging); those are deferred with their tiers.
// The key-gathering branches are ported structurally but stay dormant until a
// select sets those flags or carries TOP under a nested projection.
export class OrderByRewriter extends DbExpressionVisitor {
    private gatheredKeys: ColumnExpression[] | undefined;
    private gatheredOrderings: OrderExpression[] | undefined;
    private outerMostSelect: SelectExpression | undefined;
    private hasProjectionInProjector = false;

    static rewrite(expression: Expression): Expression {
        return new OrderByRewriter().visit(expression);
    }

    // Saves/clears the gathered ordering+key state for the duration of `action`
    // (Signum's Scope()); a fresh subquery scope must not leak orderings to/from
    // its surroundings.
    private scope<T>(action: () => T): T {
        const oldOrderings = this.gatheredOrderings;
        const oldKeys = this.gatheredKeys;
        this.gatheredOrderings = undefined;
        this.gatheredKeys = undefined;
        try {
            return action();
        } finally {
            this.gatheredKeys = oldKeys;
            this.gatheredOrderings = oldOrderings;
        }
    }

    override visitProjection(proj: ProjectionExpression): Expression {
        return this.scope(() => {
            const oldOuterMost = this.outerMostSelect;
            this.outerMostSelect = proj.select;

            const oldHasProjection = this.hasProjectionInProjector;
            this.hasProjectionInProjector = false;

            const projector = this.visit(proj.projector);
            const source = this.visit(proj.select) as SelectExpression;

            this.hasProjectionInProjector = oldHasProjection || true;
            this.outerMostSelect = oldOuterMost;

            if (source !== proj.select || projector !== proj.projector)
                return new ProjectionExpression(source, projector, proj.uniqueFunction, proj.type);
            return proj;
        });
    }

    override visitSelect(select: SelectExpression): Expression {
        const isOuterMost = select === this.outerMostSelect;
        const isReverse = (select.selectOptions & SelectOptions.Reverse) !== 0;
        const isOrderAlsoByKeys = (select.selectOptions & SelectOptions.OrderAlsoByKeys) !== 0;
        const hasIndex = (select.selectOptions & SelectOptions.HasIndex) !== 0;

        if (isOrderAlsoByKeys || hasIndex || (select.top != null && this.hasProjectionInProjector)) {
            if (this.gatheredKeys == null)
                this.gatheredKeys = [];
        }

        let savedKeys: ColumnExpression[] | undefined;
        if (this.gatheredKeys != null && (select.isDistinct || select.groupBy.length > 0 || OrderByRewriter.isAllAggregates(select)))
            savedKeys = [...this.gatheredKeys];

        select = super.visitSelect(select) as SelectExpression;

        if (savedKeys != null)
            this.gatheredKeys = savedKeys;

        if (select.groupBy.length > 0) {
            this.gatheredOrderings = undefined;
            if (this.gatheredKeys != null)
                this.gatheredKeys.push(...select.columns.map(cd => cd.getReference(select.alias)));
        }

        // Signum's `select.IsAllAggregates` branch: an aggregate-only select (a group-all with
        // an empty GROUP BY, e.g. `groupBy(s => ({})).…sum(…)`) also collapses to one row, so a
        // gathered inner ORDER BY is meaningless and must be dropped — otherwise its key column
        // leaks into the select and SQL Server rejects it (not grouped nor aggregated).
        if (OrderByRewriter.isAllAggregates(select)) {
            this.gatheredOrderings = undefined;
            if (this.gatheredKeys != null)
                this.gatheredKeys.push(...select.columns.map(cd => cd.getReference(select.alias)));
        }

        if (select.isDistinct) {
            if (this.gatheredKeys != null)
                this.gatheredKeys.push(...select.columns.map(cd => cd.getReference(select.alias)));
        }

        if (isReverse && this.gatheredOrderings != null && this.gatheredOrderings.length > 0)
            this.gatheredOrderings = this.gatheredOrderings.map(o => new OrderExpression(
                o.orderType === "Ascending" ? "Descending" : "Ascending", o.expression));

        if (select.orderBy.length > 0)
            this.prependOrderings(select.orderBy);

        let orderings: OrderExpression[] | undefined;

        if (isOuterMost && !OrderByRewriter.isCountSumOrAvg(select)) {
            this.appendKeys();
            orderings = this.gatheredOrderings;
            this.gatheredOrderings = undefined;
        } else if (select.top != null || select.offset != null) {
            // TOP and OFFSET both make an ORDER BY meaningful at their own level
            // (OFFSET requires one on SQL Server), so emit the gathered ordering here.
            this.appendKeys();
            orderings = this.gatheredOrderings;
            // OFFSET consumes the order at this level; a TOP does too, unless it is a
            // TOP 1 still offering its order to a CROSS APPLY parent.
            if (select.offset != null || (select.top != null && OrderByRewriter.isOne(select.top)))
                this.gatheredOrderings = undefined;
        }

        if (OrderByRewriter.areEqual(select.orderBy, orderings) && !isReverse)
            return select;

        return new SelectExpression(
            select.alias, select.isDistinct, select.top, select.columns,
            select.from, select.where, orderings ?? [], select.groupBy,
            select.selectOptions & ~SelectOptions.Reverse, select.offset);
    }

    override visitScalar(scalar: ScalarExpression): Expression {
        return this.scope(() => super.visitScalar(scalar));
    }

    override visitExists(exists: ExistsExpression): Expression {
        return this.scope(() => super.visitExists(exists));
    }

    override visitIn(inExp: InExpression): Expression {
        if (inExp.values != null)
            return super.visitIn(inExp);
        return this.scope(() => super.visitIn(inExp));
    }

    override visitJoin(join: JoinExpression): Expression {
        const left = this.visitSource(join.left);

        const leftOrders = this.gatheredOrderings;
        this.gatheredOrderings = undefined;

        // The right side of an APPLY join may correlate with the left, so its own
        // ORDER BY must not be hoisted across the join boundary; everything else is
        // visited normally. A bare TableExpression has nothing to gather.
        const right = join.right instanceof TableExpression ? join.right : this.visitSource(join.right);

        this.prependOrderings(leftOrders);

        const condition = this.visit(join.condition);

        if (left !== join.left || right !== join.right || condition !== join.condition)
            return new JoinExpression(join.joinType, left, right, condition);
        return join;
    }

    override visitTable(table: TableExpression): Expression {
        if (this.gatheredKeys != null)
            this.gatheredKeys.push(OrderByRewriter.idExpression(table));
        return table;
    }

    // ---- ordering accumulation -------------------------------------------

    private appendKeys(): void {
        if (this.gatheredKeys == null || this.gatheredKeys.length === 0)
            return;

        if (this.gatheredOrderings == null || this.gatheredOrderings.length === 0) {
            this.gatheredOrderings = this.gatheredKeys.map(k => new OrderExpression("Ascending", k));
        } else {
            const used = new Set(this.gatheredOrderings
                .map(o => OrderByRewriter.cleanCast(o.expression))
                .filter((e): e is ColumnExpression => e instanceof ColumnExpression)
                .map(c => OrderByRewriter.columnKey(c)));
            const postOrders = this.gatheredKeys
                .filter(k => !used.has(OrderByRewriter.columnKey(k)))
                .map(k => new OrderExpression("Ascending", k));
            this.gatheredOrderings = [...this.gatheredOrderings, ...postOrders];
        }

        this.gatheredKeys = undefined;
    }

    // Inserts newOrderings BEFORE the ones gathered so far (an inner ORDER BY is
    // the primary sort; keys/outer orders are tie-breakers). Constant orderings are
    // dropped — ordering by a literal is meaningless.
    private prependOrderings(newOrderings: readonly OrderExpression[] | undefined): void {
        const filtered = newOrderings?.filter(o =>
            !(o.expression instanceof ConstantExpression || o.expression instanceof SqlConstantExpression));

        if (filtered == null || filtered.length === 0)
            return;

        if (this.gatheredOrderings == null || this.gatheredOrderings.length === 0)
            this.gatheredOrderings = [...filtered];
        else
            this.gatheredOrderings = [...filtered, ...this.gatheredOrderings];
    }

    // ---- helpers ----------------------------------------------------------

    private static areEqual(a: readonly OrderExpression[] | undefined, b: readonly OrderExpression[] | undefined): boolean {
        const aEmpty = a == null || a.length === 0;
        const bEmpty = b == null || b.length === 0;
        if (aEmpty && bEmpty)
            return true;
        if (aEmpty || bEmpty)
            return false;
        return a === b;
    }

    private static isOne(top: Expression): boolean {
        if (top instanceof SqlConstantExpression && top.value === 1)
            return true;
        if (top instanceof ConstantExpression && top.value === 1)
            return true;
        return false;
    }

    private static cleanCast(exp: Expression): Expression {
        while (exp instanceof UnaryExpression && (exp.kind === "+u" || exp.kind === "-u"))
            exp = exp.expression;
        return exp;
    }

    private static columnKey(c: ColumnExpression): string {
        return `${c.alias}|${c.name}`;
    }

    private static idExpression(table: TableExpression): ColumnExpression {
        return new ColumnExpression(LiteralType.number, table.alias, table.table.primaryKey.column.name);
    }

    // Signum's SelectExpression.IsAllAggregates: a group-all select (one row). Constant
    // columns are ignored — altea projects a trivial group key (`groupBy(s => ({}))`) as a
    // constant column, which Signum omits, so like UnusedColumnRemover we look only at the
    // non-constant columns being aggregates.
    private static isAllAggregates(select: SelectExpression): boolean {
        const nonConst = select.columns.filter(c =>
            !(c.expression instanceof ConstantExpression || c.expression instanceof SqlConstantExpression));
        return nonConst.length > 0 && nonConst.every(c => c.expression instanceof AggregateExpression);
    }

    // A single-column COUNT/SUM/AVG/… select returns a scalar that must NOT be
    // re-sorted at the outermost level (sorting an aggregate row is meaningless and
    // would re-introduce the inner ORDER BY).
    private static isCountSumOrAvg(select: SelectExpression): boolean {
        if (select.columns.length !== 1)
            return false;

        let exp: Expression = select.columns[0].expression;

        if (exp instanceof IsNullExpression)
            exp = exp.expression;

        if (exp instanceof BinaryExpression && exp.kind === "??") {
            if (exp.right instanceof ConstantExpression || exp.right instanceof SqlConstantExpression)
                exp = exp.left;
        }

        if (!(exp instanceof AggregateExpression))
            return false;

        const fn = exp.aggregateFunction;
        return fn === "Count" || fn === "CountDistinct" || fn === "Sum"
            || fn === "Average" || fn === "StdDev" || fn === "StdDevP";
    }
}
