import { Expression, BinaryExpression, ConstantExpression } from "../expressions";
import {
    SelectExpression, ProjectionExpression, JoinExpression, TableExpression,
    ScalarExpression, ExistsExpression, InExpression, SourceExpression,
    ColumnExpression, ColumnDeclaration, AggregateExpression, SqlConstantExpression,
    SelectOptions,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's RedundantSubqueryRemover
// (Engine/Linq/ExpressionVisitor/RedundantSubqueryRemover.cs), including its inner
// RedundantSubqueryGatherer + SubqueryRemover + SubqueryMerger + JoinSimplifier.
//
// After OrderByRewriter floats ORDER BY up and strips the now-pointless inner
// selects, the tree is full of trivial "SELECT cols FROM (subquery)" wrappers.
// This collapses them:
//   1. RedundantSubqueryGatherer finds pure pass-through selects (simple/name-map
//      projection, no distinct/reverse/top/where/order/group) and SubqueryRemover
//      splices each away, remapping its column references to the definitions below.
//   2. SubqueryMerger additionally merges a select with its FROM subquery when only
//      a WHERE/ORDER BY/TOP/DISTINCT difference separates them — this is what lands
//      ORDER BY and TOP on the SAME select (the SQL-Server-valid shape).
//   3. JoinSimplifier turns APPLY joins over a plain table into ordinary joins.
//
// Scoped to altea's node set (no Skip/SetOperator/RowNumber yet).
export class RedundantSubqueryRemover extends DbExpressionVisitor {
    constructor(private readonly isPostgres: boolean) { super(); }

    static remove(expression: Expression, isPostgres: boolean): Expression {
        const removed = new RedundantSubqueryRemover(isPostgres).visit(expression);
        const merged = SubqueryMerger.merge(removed);
        return JoinSimplifier.simplify(merged, isPostgres);
    }

    override visitSelect(select: SelectExpression): Expression {
        select = super.visitSelect(select) as SelectExpression;

        const redundant = RedundantSubqueryGatherer.gather(select.from, this.isPostgres);
        if (redundant != null)
            select = SubqueryRemover.remove(select, redundant) as SelectExpression;

        return select;
    }

    override visitProjection(proj: ProjectionExpression): Expression {
        proj = super.visitProjection(proj) as ProjectionExpression;
        if (proj.select.from instanceof SelectExpression) {
            const redundant = RedundantSubqueryGatherer.gather(proj.select, this.isPostgres);
            if (redundant != null)
                proj = SubqueryRemover.remove(proj, redundant) as ProjectionExpression;
        }
        return proj;
    }

    // A select whose columns are all `name = thatSameName` passthroughs.
    static isSimpleProjection(select: SelectExpression): boolean {
        return select.columns.every(cd =>
            cd.expression instanceof ColumnExpression && cd.name === cd.expression.name);
    }

    // A select that re-exposes its FROM-select's columns positionally, by name.
    static isNameMapProjection(select: SelectExpression): boolean {
        if (select.from instanceof TableExpression)
            return false;
        if (!(select.from instanceof SelectExpression) || select.columns.length !== select.from.columns.length)
            return false;
        const fromColumns = select.from.columns;
        return select.columns.every((cd, i) =>
            cd.expression instanceof ColumnExpression && cd.expression.name === fromColumns[i].name);
    }
}

// Collects the redundant (pure pass-through) selects directly inside a source.
class RedundantSubqueryGatherer extends DbExpressionVisitor {
    private redundant: SelectExpression[] | undefined;

    constructor(private readonly isPostgres: boolean) { super(); }

    static gather(source: Expression | undefined, isPostgres: boolean): SelectExpression[] | undefined {
        if (source == null)
            return undefined;
        const g = new RedundantSubqueryGatherer(isPostgres);
        g.visit(source);
        return g.redundant;
    }

    private static isRedundantSubquery(select: SelectExpression): boolean {
        return (RedundantSubqueryRemover.isSimpleProjection(select) || RedundantSubqueryRemover.isNameMapProjection(select))
            && !select.isDistinct
            && (select.selectOptions & SelectOptions.Reverse) === 0
            && select.top == null
            && select.where == null
            && select.orderBy.length === 0
            && select.groupBy.length === 0;
    }

    override visitSelect(select: SelectExpression): Expression {
        if (RedundantSubqueryGatherer.isRedundantSubquery(select))
            (this.redundant ??= []).push(select);
        return select;
    }

    // Don't gather inside correlated subqueries.
    override visitScalar(scalar: ScalarExpression): Expression { return scalar; }
    override visitExists(exists: ExistsExpression): Expression { return exists; }
    override visitIn(inExp: InExpression): Expression { return inExp; }

    override visitJoin(join: JoinExpression): Expression {
        const result = super.visitJoin(join) as JoinExpression;
        if (this.isPostgres && this.redundant != null &&
            (result.joinType === "CrossApply" || result.joinType === "OuterApply") &&
            result.right instanceof SelectExpression && this.redundant.includes(result.right)) {
            if (RedundantSubqueryGatherer.hasJoins(result.right))
                this.redundant = this.redundant.filter(s => s !== result.right);
        }
        return result;
    }

    private static hasJoins(s: SelectExpression): boolean {
        return s.from instanceof JoinExpression
            || (s.from instanceof SelectExpression && RedundantSubqueryGatherer.hasJoins(s.from));
    }
}

// Splices out a set of selects, remapping references to their columns to the
// expressions those columns were defined as.
class SubqueryRemover extends DbExpressionVisitor {
    private readonly selectsToRemove: Set<SelectExpression>;
    private readonly map: Map<string, Map<string, Expression>>;

    constructor(selectsToRemove: readonly SelectExpression[]) {
        super();
        this.selectsToRemove = new Set(selectsToRemove);
        this.map = new Map(selectsToRemove.map(s =>
            [s.alias.toString(), new Map(s.columns.map(cd => [cd.name, cd.expression]))]));
    }

    static remove(expression: Expression, selectsToRemove: readonly SelectExpression[]): Expression {
        return new SubqueryRemover(selectsToRemove).visit(expression);
    }

    override visitSelect(select: SelectExpression): Expression {
        if (this.selectsToRemove.has(select))
            return this.visit(select.from!);
        return super.visitSelect(select);
    }

    override visitColumn(column: ColumnExpression): Expression {
        const cols = column.name != null ? this.map.get(column.alias.toString()) : undefined;
        if (cols == null)
            return column;
        const mapped = cols.get(column.name!);
        if (mapped == null)
            throw new Error(`Reference to undefined column ${column}`);
        return mapped;
    }
}

// Merges a select with its left-most FROM subquery when only a where/order/top/
// distinct difference separates them (the cases RedundantSubqueryGatherer rejects).
class SubqueryMerger extends DbExpressionVisitor {
    private isTopLevel = true;

    static merge(expression: Expression): Expression {
        return new SubqueryMerger().visit(expression);
    }

    override visitSelect(select: SelectExpression): Expression {
        const wasTopLevel = this.isTopLevel;
        this.isTopLevel = false;

        select = super.visitSelect(select) as SelectExpression;

        while (SubqueryMerger.canMergeWithFrom(select, wasTopLevel)) {
            const fromSelect = SubqueryMerger.getLeftMostSelect(select.from!)!;

            select = SubqueryRemover.remove(select, [fromSelect]) as SelectExpression;

            let where = select.where;
            if (fromSelect.where != null)
                where = where != null ? new BinaryExpression("&&", fromSelect.where, where) : fromSelect.where;

            const orderBy = select.orderBy.length > 0 ? select.orderBy : fromSelect.orderBy;
            const groupBy = select.groupBy.length > 0 ? select.groupBy : fromSelect.groupBy;
            const top = select.top ?? fromSelect.top;
            const isDistinct = select.isDistinct || fromSelect.isDistinct;

            if (where !== select.where || orderBy !== select.orderBy || groupBy !== select.groupBy
                || isDistinct !== select.isDistinct || top !== select.top) {
                select = new SelectExpression(select.alias, isDistinct, top, select.columns,
                    select.from, where, orderBy, groupBy, select.selectOptions);
            }
        }

        return select;
    }

    private static isColumnProjection(select: SelectExpression): boolean {
        return select.columns.every(cd =>
            cd.expression instanceof ColumnExpression || cd.expression instanceof ConstantExpression);
    }

    private static canMergeWithFrom(select: SelectExpression, isTopLevel: boolean): boolean {
        const fromSelect = SubqueryMerger.getLeftMostSelect(select.from!);
        if (fromSelect == null)
            return false;
        if (!SubqueryMerger.isColumnProjection(fromSelect))
            return false;

        const selHasOrderBy = select.orderBy.length > 0;
        const selHasGroupBy = select.groupBy.length > 0;
        const frmHasOrderBy = fromSelect.orderBy.length > 0;
        const frmHasGroupBy = fromSelect.groupBy.length > 0;

        if (selHasOrderBy && frmHasOrderBy)
            return false;
        if (selHasGroupBy && frmHasGroupBy)
            return false;
        if ((select.selectOptions & SelectOptions.Reverse) !== 0 || (fromSelect.selectOptions & SelectOptions.Reverse) !== 0)
            return false;

        // can't move an order-by forward past a group-by / distinct / aggregate
        if (frmHasOrderBy && (selHasGroupBy || select.isDistinct || AggregateChecker.hasAggregates(select)))
            return false;
        // can't move a group-by forward (would change the projection)
        if (frmHasGroupBy)
            return false;
        // can't move a TOP forward past another TOP / distinct / group-by / apply / where
        if (fromSelect.top != null && (select.top != null || select.isDistinct || selHasGroupBy
            || SubqueryMerger.hasApplyJoin(select.from!) || select.where != null))
            return false;
        // can't move a DISTINCT forward past top / non-name-map projection / group-by / non-top-level order / aggregate
        if (fromSelect.isDistinct && (select.top != null || !RedundantSubqueryRemover.isNameMapProjection(select)
            || selHasGroupBy || (selHasOrderBy && !isTopLevel) || AggregateChecker.hasAggregates(select)))
            return false;

        return true;
    }

    static getLeftMostSelect(source: Expression): SelectExpression | undefined {
        if (source instanceof SelectExpression)
            return source;
        if (source instanceof JoinExpression && source.joinType !== "RightOuterJoin" && source.joinType !== "FullOuterJoin")
            return SubqueryMerger.getLeftMostSelect(source.left);
        return undefined;
    }

    private static hasApplyJoin(source: SourceExpression): boolean {
        if (!(source instanceof JoinExpression))
            return false;
        return source.joinType === "CrossApply" || source.joinType === "OuterApply"
            || SubqueryMerger.hasApplyJoin(source.left) || SubqueryMerger.hasApplyJoin(source.right);
    }
}

// Detects aggregates in the order/where/columns of a single select (not nested).
class AggregateChecker extends DbExpressionVisitor {
    private found = false;

    static hasAggregates(select: SelectExpression): boolean {
        const c = new AggregateChecker();
        c.visitSelect(select);
        return c.found;
    }

    override visitAggregate(aggregate: AggregateExpression): Expression {
        this.found = true;
        return aggregate;
    }

    override visitSelect(select: SelectExpression): Expression {
        this.visit(select.where);
        this.visitArray(select.orderBy, o => this.visitOrderBy(o));
        this.visitArray(select.columns, c => this.visitColumnDeclaration(c));
        return select;
    }

    // don't count aggregates buried in correlated subqueries
    override visitScalar(scalar: ScalarExpression): Expression { return scalar; }
    override visitExists(exists: ExistsExpression): Expression { return exists; }
    override visitIn(inExp: InExpression): Expression { return inExp; }
}

// Rewrites an APPLY join over a plain table into an ordinary INNER/LEFT OUTER join.
class JoinSimplifier extends DbExpressionVisitor {
    constructor(private readonly isPostgres: boolean) { super(); }

    static simplify(expression: Expression, isPostgres: boolean): Expression {
        return new JoinSimplifier(isPostgres).visit(expression);
    }

    override visitJoin(join: JoinExpression): Expression {
        const left = this.visitSource(join.left);
        const right = this.visitSource(join.right);
        const condition = this.visit(join.condition);

        if ((join.joinType === "CrossApply" || join.joinType === "OuterApply") && right instanceof TableExpression) {
            const trueConst = new SqlConstantExpression(true, (right as TableExpression).type);
            const cond = this.isPostgres ? trueConst : new BinaryExpression("==", new SqlConstantExpression(1, trueConst.type), new SqlConstantExpression(1, trueConst.type));
            return new JoinExpression(join.joinType === "OuterApply" ? "LeftOuterJoin" : "InnerJoin", left, right, cond);
        }

        if (left !== join.left || right !== join.right || condition !== join.condition)
            return new JoinExpression(join.joinType, left, right, condition);
        return join;
    }
}
