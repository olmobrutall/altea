import { Expression, ConstantExpression } from "../expressions";
import {
    SelectExpression, ColumnExpression, ColumnDeclaration, OrderExpression,
    JoinExpression, SetOperatorExpression, ScalarExpression, ExistsExpression, InExpression,
    ProjectionExpression, ChildProjectionExpression, RowNumberExpression, SqlConstantExpression, AggregateExpression,
    SourceExpression, SourceWithAliasExpression, DeleteExpression, UpdateExpression, InsertSelectExpression,
    ColumnAssignment,
} from "../expressions.sql";
import { Alias } from "../aliasGenerator";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's UnusedColumnRemover. A top-down pass that drops SELECT columns not
// referenced by any enclosing scope (so `SELECT id, name` instead of every column), and
// removes single-row LEFT/APPLY joins whose columns are entirely unused (so an eager
// reference join disappears when the projection never touches it). Usage is gathered by
// visiting the *consuming* parts of a node before its source: `visitColumn` records
// (alias, name), and each `visitSelect` keeps only the columns the outer scope recorded.
export class UnusedColumnRemover extends DbExpressionVisitor {
    private readonly used = new Map<string, Set<string>>();

    static remove(expression: Expression): Expression {
        return new UnusedColumnRemover().visit(expression);
    }

    private usedOf(alias: Alias): Set<string> {
        const key = alias.toString();
        let set = this.used.get(key);
        if (set == null)
            this.used.set(key, set = new Set());
        return set;
    }

    // Signum keys this off SqlConstant; altea also projects a group's key as a source-level
    // ConstantExpression (e.g. `groupBy(a => ({}))`), so treat both as constant — otherwise
    // an aggregate select carrying a constant key column isn't seen as all-aggregates and
    // its aggregates get pruned away.
    private static isConstant(e: Expression): boolean {
        return e instanceof SqlConstantExpression || e instanceof ConstantExpression;
    }

    override visitColumn(c: ColumnExpression): Expression {
        if (c.name != null)
            this.usedOf(c.alias).add(c.name);
        return c;
    }

    override visitSelect(select: SelectExpression): Expression {
        const columnsUsed = this.usedOf(select.alias);

        // Keep a column only if the outer scope uses it (by name). A DISTINCT select's
        // columns all define the distinct set, and an all-aggregates select's columns are
        // what make it a single-row aggregate (pruning them all would turn `COUNT(*)` back
        // into a plain multi-row select) — for those keep every non-constant column instead
        // (Signum's IsDistinct || IsAllAggregates rule).
        // All-aggregates over the non-constant columns: altea projects a group's constant
        // key as a column (Signum doesn't), so ignore constants when deciding — the keep
        // rule below then prunes that constant key but preserves the aggregates that make
        // the select single-row.
        const nonConst = select.columns.filter(c => !UnusedColumnRemover.isConstant(c.expression));
        const allAggregates = nonConst.length > 0 && nonConst.every(c => c.expression instanceof AggregateExpression);
        const columns: ColumnDeclaration[] = [];
        let columnsChanged = false;
        for (const c of select.columns) {
            // Normal select: keep columns the outer uses by name. DISTINCT / all-aggregates
            // select: keep every non-constant column (they define the row), and prune a
            // constant only when it is also unused — altea may project a group key as a
            // constant column that the outer still references (Signum inlines that key).
            const keep = (select.isDistinct || allAggregates)
                ? (!UnusedColumnRemover.isConstant(c.expression) || columnsUsed.has(c.name))
                : columnsUsed.has(c.name);
            if (!keep) { columnsChanged = true; continue; }
            const ex = this.visit(c.expression);
            if (ex !== c.expression) columnsChanged = true;
            columns.push(ex === c.expression ? c : new ColumnDeclaration(c.name, ex));
        }

        const orderBy = this.visitArray(select.orderBy, o => this.visitOrderBy(o));
        const where = select.where != null ? this.visit(select.where) : undefined;

        const groupBy: Expression[] = [];
        let groupChanged = false;
        for (const g of select.groupBy) {
            if (UnusedColumnRemover.isConstant(g)) { groupChanged = true; continue; }
            const vg = this.visit(g);
            if (vg !== g) groupChanged = true;
            groupBy.push(vg);
        }

        // Visit the FROM last, so all the column references above have been recorded.
        const from = select.from != null ? this.visitSource(select.from) : undefined;

        if (columnsChanged || orderBy !== select.orderBy || where !== select.where || from !== select.from || groupChanged)
            return new SelectExpression(select.alias, select.isDistinct, select.top, columns, from, where, orderBy, groupBy, select.selectOptions, select.offset);
        return select;
    }

    private addSingleColumn(select: SelectExpression | undefined): void {
        if (select != null && select.columns.length >= 1)
            this.usedOf(select.alias).add(select.columns[0].name);
    }

    override visitScalar(scalar: ScalarExpression): Expression {
        this.addSingleColumn(scalar.select);
        return super.visitScalar(scalar);
    }

    override visitIn(inExp: InExpression): Expression {
        if (inExp.select != null)
            this.addSingleColumn(inExp.select);
        return super.visitIn(inExp);
    }

    override visitSetOperator(setOp: SetOperatorExpression): Expression {
        const columnsUsed = this.usedOf(setOp.alias);
        for (const name of columnsUsed) {
            this.usedOf(setOp.left.alias).add(name);
            this.usedOf(setOp.right.alias).add(name);
        }
        return super.visitSetOperator(setOp);
    }

    override visitProjection(proj: ProjectionExpression): Expression {
        const projector = this.visit(proj.projector);
        const select = this.visit(proj.select) as SelectExpression;
        if (projector !== proj.projector || select !== proj.select)
            return new ProjectionExpression(select, projector, proj.uniqueFunction, proj.type);
        return proj;
    }

    override visitJoin(join: JoinExpression): Expression {
        // A single-row LEFT/APPLY join whose right side contributes no used column is
        // dead weight (e.g. an eager reference the projection never reads) — drop it.
        if (join.joinType === "SingleRowLeftOuterJoin") {
            const hs = this.used.get((join.right as SourceWithAliasExpression).alias.toString());
            if (hs == null || hs.size === 0)
                return this.visitSource(join.left);
        }
        if (join.joinType === "OuterApply" || join.joinType === "LeftOuterJoin") {
            if (join.right instanceof SelectExpression && join.right.isOneRow()) {
                const hs = this.used.get(join.right.alias.toString());
                if (hs == null || hs.size === 0)
                    return this.visitSource(join.left);
            }
        }

        // Visit in reverse (condition, then right, then left): the condition and the
        // APPLY right side reference the left's columns, so record that before pruning it.
        const condition = join.condition != null ? this.visit(join.condition) : undefined;
        const right = this.visitSource(join.right);
        const left = this.visitSource(join.left);
        if (left !== join.left || right !== join.right || condition !== join.condition)
            return new JoinExpression(join.joinType, left, right, condition);
        return join;
    }

    override visitRowNumber(rowNumber: RowNumberExpression): Expression {
        const orderBy = rowNumber.orderBy
            .filter(o => !UnusedColumnRemover.isConstant(o.expression))
            .map(o => { const e = this.visit(o.expression); return e === o.expression ? o : new OrderExpression(o.orderType, e); });
        const changed = orderBy.length !== rowNumber.orderBy.length || orderBy.some((o, i) => o !== rowNumber.orderBy[i]);
        return changed ? rowNumber.updateRowNumber(orderBy) : rowNumber;
    }

    override visitChildProjection(child: ChildProjectionExpression): Expression {
        const key = this.visit(child.outerKey);
        const proj = UnusedColumnRemover.remove(child.projection) as ProjectionExpression;
        if (proj !== child.projection || key !== child.outerKey)
            return new ChildProjectionExpression(proj, key, child.isLazyMList, child.type, child.token);
        return child;
    }

    // DML: visit the consuming parts (where / assignments) BEFORE the source, so the
    // source select is pruned against the columns they actually use.
    override visitDelete(del: DeleteExpression): Expression {
        const where = del.where != null ? this.visit(del.where) : undefined;
        const source = this.visitSource(del.source) as SourceWithAliasExpression;
        if (source !== del.source || where !== del.where)
            return new DeleteExpression(del.table, source, where, del.returnRowCount, del.alias);
        return del;
    }

    override visitUpdate(update: UpdateExpression): Expression {
        const where = update.where != null ? this.visit(update.where) : undefined;
        const assignments = this.visitArray(update.assignments, a => this.visitColumnAssignment(a));
        const source = this.visitSource(update.source) as SourceWithAliasExpression;
        if (source !== update.source || where !== update.where || assignments !== update.assignments)
            return new UpdateExpression(update.table, source, where, assignments, update.returnRowCount);
        return update;
    }

    override visitInsertSelect(insert: InsertSelectExpression): Expression {
        const assignments = this.visitArray(insert.assignments, a => this.visitColumnAssignment(a));
        const source = this.visitSource(insert.source) as SourceWithAliasExpression;
        if (source !== insert.source || assignments !== insert.assignments)
            return new InsertSelectExpression(insert.table, source, assignments, insert.returnRowCount);
        return insert;
    }
}
