import { DbExpressionVisitor } from "./DbExpressionVisitor";
import {
    TableExpression, SelectExpression, ColumnExpression, ColumnDeclaration,
    IntervalExpression, SqlFunctionExpression, AsOfExpression,
} from "../expressions.sql";
import { Expression, BinaryExpression } from "../expressions";
import { LiteralType, TemporalType } from "../../../entities/runtimeTypes";
import { AliasGenerator } from "../AliasGenerator";
import { SystemTimeAll, SystemTimeJoinMode } from "../../systemTime";
import type { SystemVersionedInfo } from "../../schema/systemVersioned";

// Port of Signum's AsOfExpressionVisitor. A versioned TableExpression under a per-row
// `AsOfExpression(expr)` (a dynamic AS OF whose instant is a column, not a constant — produced for
// the time-series queries) is rewritten to `SELECT * FROM <table> FOR SYSTEM_TIME ALL WHERE
// period.contains(expr)`. This works on BOTH dialects: SQL Server's native `FOR SYSTEM_TIME AS OF`
// accepts only a constant/parameter, so a column-driven AS OF must instead read ALL versions and
// filter by the period; Postgres' `ALL` is then turned into the history UNION by DuplicateHistory
// (which runs next). Like DuplicateHistory, the rewrite REUSES the original table alias on the
// wrapping SELECT (so the enclosing query's column references still resolve) and projects every
// physical column; it must run after the column-pruning optimisers, right before DuplicateHistory.
export class AsOfExpressionVisitor extends DbExpressionVisitor {
    private constructor(private readonly aliasGenerator: AliasGenerator) { super(); }

    static rewrite(expression: Expression, aliasGenerator: AliasGenerator): Expression {
        return new AsOfExpressionVisitor(aliasGenerator).visit(expression);
    }

    override visitTable(table: TableExpression): Expression {
        const st = table.systemTime;
        if (!(st instanceof AsOfExpression))
            return super.visitTable(table);

        const sv = table.table.systemVersioned!;
        const innerAlias = this.aliasGenerator.nextTableAlias(table.table.name.name);
        // The same table read under ALL (every version); its period columns feed the predicate.
        const inner = new TableExpression(innerAlias, table.table, table.withHint, new SystemTimeAll(SystemTimeJoinMode.Current));
        const where = intervalContains(intervalAt(sv, innerAlias), st.expression);
        // Project every physical column so the enclosing SELECT (which references this alias) still
        // resolves — the over-projection is valid, and the outer scope was already pruned.
        const columns = Object.values(table.table.columns)
            .map(c => new ColumnDeclaration(c.name, new ColumnExpression(LiteralType.null, innerAlias, c.name)));
        // Reuse the original table alias on the wrapping SELECT (Signum uses a new alias + rebind;
        // altea reuses it, as DuplicateHistory does, since this runs after the rebinder).
        return new SelectExpression(table.alias, false, undefined, columns, inner, where, [], []);
    }
}

// The versioned table's period at `alias` (mirrors QueryBinder.systemPeriodExpression): SQL Server
// a start/end datetime2 pair; Postgres a single sys_period range (min/max = lower()/upper()).
function intervalAt(sv: SystemVersionedInfo, alias: import("../AliasGenerator").Alias): IntervalExpression {
    const dt = new TemporalType("dateTime");
    if (sv.postgresSysPeriodColumnName != null) {
        const range = new ColumnExpression(dt, alias, sv.postgresSysPeriodColumnName);
        return new IntervalExpression(dt,
            new SqlFunctionExpression(dt, undefined, "lower", [range]),
            new SqlFunctionExpression(dt, undefined, "upper", [range]),
            range);
    }
    return new IntervalExpression(dt,
        new ColumnExpression(dt, alias, sv.startColumnName!),
        new ColumnExpression(dt, alias, sv.endColumnName!),
        undefined);
}

// The period-contains predicate for a bound instant (Signum's IntervalExpression.Contains):
// Postgres uses the tstzrange `@>` operator; SQL Server the half-open `min <= expr AND expr < max`.
function intervalContains(interval: IntervalExpression, expression: Expression): Expression {
    if (interval.postgresRange != null)
        return new SqlFunctionExpression(LiteralType.boolean, undefined, "@>", [interval.postgresRange, expression]);
    return new BinaryExpression("&&",
        new BinaryExpression("<=", interval.min!, expression),
        new BinaryExpression("<", expression, interval.max!));
}
