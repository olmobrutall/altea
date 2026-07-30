import { Expression, BinaryExpression } from "../expressions";
import {
    CommandExpression, DeleteExpression, SelectExpression, TableExpression,
    ColumnExpression, PrimaryKeyExpression,
} from "../expressions.sql";
import { AliasGenerator } from "../aliasGenerator";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's CommandSimplifier (UpdateDeleteSimplifier.cs). On SQL Server,
// when a DELETE's WHERE is the trivial `id == id` self-correlation over a single
// table, collapse the `DELETE FROM t FROM (SELECT … FROM t a) s WHERE …` self-join
// into `DELETE FROM a FROM t a WHERE <the source's own WHERE>`. No-op on Postgres
// (its `DELETE … USING …` form is left as-is) and for non-trivial sources.
export class CommandSimplifier extends DbExpressionVisitor {
    constructor(private readonly aliasGenerator: AliasGenerator, private readonly isPostgres: boolean) {
        super();
    }

    static simplify(ce: CommandExpression, aliasGenerator: AliasGenerator, isPostgres: boolean): CommandExpression {
        return new CommandSimplifier(aliasGenerator, isPostgres).visit(ce) as CommandExpression;
    }

    override visitDelete(del: DeleteExpression): Expression {
        if (this.isPostgres)
            return del;

        const select = del.source;
        if (!(select instanceof SelectExpression) || !(select.from instanceof TableExpression) || select.from.table !== del.table)
            return del;

        if (!this.trivialWhere(del, select))
            return del;

        return new DeleteExpression(del.table, select.from, select.where, del.returnRowCount, select.from.alias);
    }

    private trivialWhere(del: DeleteExpression, select: SelectExpression): boolean {
        if (select.groupBy.length || select.orderBy.length || select.top != null || select.offset != null || select.isDistinct)
            return false;
        if (!(del.where instanceof BinaryExpression) || (del.where.kind !== "==" && del.where.kind !== "==="))
            return false;

        const left = this.asColumn(del.where.left);
        const right = this.asColumn(del.where.right);
        if (left == null || right == null)
            return false;

        const c1 = this.resolveColumn(left, select);
        const c2 = this.resolveColumn(right, select);
        return c1.name === c2.name && c1.alias.equals(c2.alias);
    }

    private asColumn(e: Expression): ColumnExpression | undefined {
        if (e instanceof PrimaryKeyExpression)
            return this.asColumn(e.value);
        return e instanceof ColumnExpression ? e : undefined;
    }

    // Resolve a column referencing the select's own alias down to the underlying
    // table column (and rename the table alias to the deterministic table-name alias
    // so the two sides of the correlation become identical when trivial).
    private resolveColumn(ce: ColumnExpression, select: SelectExpression): ColumnExpression {
        if (!ce.alias.equals(select.alias))
            return ce;

        const cd = select.columns.find(c => c.name === ce.name);
        if (cd == null || !(cd.expression instanceof ColumnExpression))
            return ce;

        const result = cd.expression;
        const table = select.from as TableExpression;
        if (table.alias.equals(result.alias))
            return new ColumnExpression(result.type, this.aliasGenerator.table(table.table.name), result.name);
        return result;
    }
}
