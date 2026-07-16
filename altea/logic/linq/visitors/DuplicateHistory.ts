import { DbExpressionVisitor } from "./DbExpressionVisitor";
import {
    TableExpression, SelectExpression, SetOperatorExpression, ColumnExpression,
    ColumnDeclaration, SqlFunctionExpression, SqlCastExpression,
} from "../expressions.sql";
import { Expression, ConstantExpression } from "../expressions";
import { LiteralType } from "../../../entities/runtimeTypes";
import { AliasGenerator } from "../AliasGenerator";
import {
    SystemTime, SystemTimeHistoryTable, SystemTimeAsOf, SystemTimeBetween, SystemTimeContainedIn, SystemTimeAll,
} from "../../systemTime";

// Postgres port of Signum's DuplicateHistory. Postgres has no native FOR SYSTEM_TIME, so a
// query over a system-versioned table under a SystemTime override is rewritten: the versioned
// TableExpression becomes `UNION ALL(<main> WHERE period-pred, <history> WHERE period-pred)`,
// reusing the original table alias so the enclosing SELECT's column references still resolve.
// The period predicate matches the mode against the `sys_period` tstzrange:
//   AsOf(t)          → sys_period @> t
//   All              → (no predicate)
//   Between(s,e)     → sys_period && tstzrange(s,e)      (overlap)
//   ContainedIn(s,e) → sys_period <@ tstzrange(s,e)      (contained in)
// Divergence from Signum: both branches project ALL physical columns (Signum tracks only the
// referenced ones); UnusedColumnRemover prunes the rest afterward. Runs only on Postgres.
export class DuplicateHistory extends DbExpressionVisitor {
    private constructor(private readonly aliasGenerator: AliasGenerator) { super(); }

    static rewrite(expression: Expression, aliasGenerator: AliasGenerator): Expression {
        return new DuplicateHistory(aliasGenerator).visit(expression);
    }

    override visitTable(table: TableExpression): Expression {
        const st = table.systemTime;
        if (st == null || st instanceof SystemTimeHistoryTable)
            return table;

        const sv = table.table.systemVersioned!;
        const branch = (systemTime: SystemTime | undefined): SelectExpression => {
            const alias = this.aliasGenerator.nextTableAlias(table.table.name.name);
            const inner = new TableExpression(alias, table.table, undefined, systemTime);
            const period = new ColumnExpression(LiteralType.null, alias, sv.postgresSysPeriodColumnName!);
            const columns = Object.values(table.table.columns)
                .map(c => new ColumnDeclaration(c.name, new ColumnExpression(LiteralType.null, alias, c.name)));
            const selectAlias = this.aliasGenerator.nextSelectAlias();
            return new SelectExpression(selectAlias, false, undefined, columns, inner, periodPredicate(st, period), [], []);
        };

        const current = branch(undefined);
        const history = branch(new SystemTimeHistoryTable());
        // Keep the ORIGINAL table alias on the union so the enclosing SELECT's columns resolve.
        return new SetOperatorExpression("UnionAll", current, history, table.alias);
    }
}

// The tstzrange period predicate for a mode, over the `period` column. `undefined` = no filter.
function periodPredicate(st: SystemTime, period: ColumnExpression): Expression | undefined {
    const bool = LiteralType.boolean;
    const rangeType = LiteralType.null;
    // A bound instant: a parametrised ConstantExpression cast to timestamptz (node-pg sends
    // params untyped, so the cast disambiguates the `@>` / range-function overloads).
    const instant = (v: unknown) => new SqlCastExpression(rangeType, new ConstantExpression(v), "timestamptz");
    const tstzrange = (a: unknown, b: unknown) =>
        new SqlFunctionExpression(rangeType, undefined, "tstzrange", [instant(a), instant(b)]);
    // The PG range operators render infix (see QueryFormatter.visitSqlFunction).
    const op = (name: string, l: Expression, r: Expression) => new SqlFunctionExpression(bool, undefined, name, [l, r]);

    if (st instanceof SystemTimeAll)
        return undefined;
    if (st instanceof SystemTimeAsOf)
        return op("@>", period, instant(st.dateTime));
    if (st instanceof SystemTimeBetween)
        return op("&&", period, tstzrange(st.startDateTime, st.endDateTime));
    if (st instanceof SystemTimeContainedIn)
        return op("<@", period, tstzrange(st.startDateTime, st.endDateTime));
    throw new Error(`Unsupported SystemTime mode in DuplicateHistory: ${st}`);
}
