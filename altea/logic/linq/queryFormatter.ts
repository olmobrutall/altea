import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression,
} from "../expressions";
import { OpBinary } from "quote-transformer/quoted";
import {
    SourceExpression, TableExpression, SelectExpression, JoinExpression,
    ColumnExpression, ColumnDeclaration, OrderExpression, JoinType,
    AggregateExpression, SqlFunctionExpression, SqlConstantExpression,
    CaseExpression, LikeExpression, ScalarExpression, ExistsExpression, InExpression,
    IsNullExpression, IsNotNullExpression, PrimaryKeyExpression,
} from "../expressions.sql";
import { Alias } from "./aliasGenerator";

// Port of Signum's QueryFormatter. Renders a (SQL-only) DbExpression tree to SQL
// text + a positional parameter list, dialect-aware (Postgres `$n` / SQL Server
// `@pN`, identifier quoting). Step-3 scope: SELECT/FROM/WHERE/ORDER BY/TOP over
// table & nested-select sources + scalar expressions. JOIN/GROUP BY render too;
// the entity-semantic nodes must already be rewritten away before this runs.

export interface FormattedQuery {
    readonly sql: string;
    readonly parameters: unknown[];
}

export class QueryFormatter {
    private readonly parameters: unknown[] = [];

    constructor(private readonly isPostgres: boolean) { }

    static format(select: SelectExpression, isPostgres: boolean): FormattedQuery {
        const f = new QueryFormatter(isPostgres);
        const sql = f.formatSelect(select);
        return { sql, parameters: f.parameters };
    }

    private quote(id: string): string {
        return this.isPostgres ? `"${id}"` : `[${id}]`;
    }

    private addParameter(value: unknown): string {
        this.parameters.push(value);
        return this.isPostgres ? `$${this.parameters.length}` : `@p${this.parameters.length - 1}`;
    }

    // ---- sources ----------------------------------------------------------

    private formatSelect(s: SelectExpression): string {
        const cols = s.columns.length
            ? s.columns.map(c => this.formatColumnDeclaration(c)).join(", ")
            : "*";

        const top = s.top != null && !this.isPostgres ? `TOP ${this.literalNumber(s.top)} ` : "";
        let sql = `SELECT ${s.isDistinct ? "DISTINCT " : ""}${top}${cols}`;

        if (s.from != null)
            sql += `\nFROM ${this.formatSource(s.from)}`;
        if (s.where != null)
            sql += `\nWHERE ${this.visit(s.where)}`;
        if (s.groupBy.length)
            sql += `\nGROUP BY ${s.groupBy.map(g => this.visit(g)).join(", ")}`;
        if (s.orderBy.length)
            sql += `\nORDER BY ${s.orderBy.map(o => this.formatOrder(o)).join(", ")}`;
        if (s.top != null && this.isPostgres)
            sql += `\nLIMIT ${this.literalNumber(s.top)}`;

        return sql;
    }

    private formatSource(src: SourceExpression): string {
        if (src instanceof TableExpression) {
            const on = src.table.name;
            const tbl = on.schema?.name
                ? `${this.quote(on.schema.name)}.${this.quote(on.name)}`
                : this.quote(on.name);
            return `${tbl} ${this.quoteAlias(src.alias)}`;
        }
        if (src instanceof SelectExpression)
            return `(\n${this.formatSelect(src)}\n) ${this.quoteAlias(src.alias)}`;
        if (src instanceof JoinExpression)
            return this.formatJoin(src);

        throw new Error("Unsupported source in QueryFormatter: " + src.kind);
    }

    private formatJoin(j: JoinExpression): string {
        const keyword = this.joinKeyword(j.joinType);
        const left = this.formatSource(j.left);
        const right = this.formatSource(j.right);
        const on = j.condition != null ? ` ON ${this.visit(j.condition)}` : "";
        return `${left}\n${keyword} ${right}${on}`;
    }

    private joinKeyword(jt: JoinType): string {
        switch (jt) {
            case "CrossJoin": return "CROSS JOIN";
            case "InnerJoin": return "INNER JOIN";
            case "LeftOuterJoin":
            case "SingleRowLeftOuterJoin": return "LEFT OUTER JOIN";
            case "RightOuterJoin": return "RIGHT OUTER JOIN";
            case "FullOuterJoin": return "FULL OUTER JOIN";
            case "CrossApply": return this.isPostgres ? "CROSS JOIN LATERAL" : "CROSS APPLY";
            case "OuterApply": return this.isPostgres ? "LEFT JOIN LATERAL" : "OUTER APPLY";
        }
    }

    private formatColumnDeclaration(c: ColumnDeclaration): string {
        return `${this.visit(c.expression)} AS ${this.quote(c.name)}`;
    }

    private formatOrder(o: OrderExpression): string {
        return `${this.visit(o.expression)} ${o.orderType === "Ascending" ? "ASC" : "DESC"}`;
    }

    private quoteAlias(alias: Alias): string {
        return this.quote(alias.toString());
    }

    private literalNumber(e: Expression): string {
        if (e instanceof ConstantExpression && typeof e.value === "number")
            return String(e.value);
        if (e instanceof SqlConstantExpression && typeof e.value === "number")
            return String(e.value);
        return this.visit(e);
    }

    // ---- scalar expressions ----------------------------------------------

    private visit(e: Expression): string {
        if (e instanceof ColumnExpression)
            return `${this.quoteAlias(e.alias)}.${this.quote(e.name!)}`;

        if (e instanceof PrimaryKeyExpression)
            return this.visit(e.value);

        if (e instanceof ConstantExpression)
            return e.value == null ? "NULL" : this.addParameter(e.value);

        if (e instanceof SqlConstantExpression)
            return e.value == null ? "NULL" : this.addParameter(e.value);

        if (e instanceof BinaryExpression)
            return this.formatBinary(e);

        if (e instanceof UnaryExpression) {
            const op = e.kind === "!" ? "NOT " : e.kind === "-u" ? "-" : e.kind === "+u" ? "+" : "~";
            return `(${op}${this.visit(e.expression)})`;
        }

        if (e instanceof ConditionalExpression)
            return `CASE WHEN ${this.visit(e.condition)} THEN ${this.visit(e.whenTrue)} ELSE ${this.visit(e.whenFalse)} END`;

        if (e instanceof CastExpression)
            return this.visit(e.expression); // cast is a no-op for now (step 7 narrows IB)

        if (e instanceof IsNullExpression)
            return `${this.visit(e.expression)} IS NULL`;

        if (e instanceof IsNotNullExpression)
            return `${this.visit(e.expression)} IS NOT NULL`;

        if (e instanceof LikeExpression)
            return `${this.visit(e.expression)} LIKE ${this.visit(e.pattern)}`;

        if (e instanceof AggregateExpression) {
            const inner = e.arguments.length ? e.arguments.map(a => this.visit(a)).join(", ") : "*";
            const fn = e.aggregateFunction === "Average" ? "AVG"
                : e.aggregateFunction === "CountDistinct" ? "COUNT"
                    : e.aggregateFunction.toUpperCase();
            const distinct = e.aggregateFunction === "CountDistinct" ? "DISTINCT " : "";
            return `${fn}(${distinct}${inner})`;
        }

        if (e instanceof SqlFunctionExpression)
            return `${e.sqlFunction}(${e.arguments.map(a => this.visit(a)).join(", ")})`;

        if (e instanceof CaseExpression) {
            const whens = e.whens.map(w => `WHEN ${this.visit(w.condition)} THEN ${this.visit(w.value)}`).join(" ");
            return `CASE ${whens} ELSE ${e.defaultValue != null ? this.visit(e.defaultValue) : "NULL"} END`;
        }

        if (e instanceof ScalarExpression)
            return `(${this.formatSelect(e.select!)})`;

        if (e instanceof ExistsExpression)
            return `EXISTS(${this.formatSelect(e.select!)})`;

        if (e instanceof InExpression) {
            const rhs = e.select != null
                ? this.formatSelect(e.select)
                : (e.values ?? []).map(v => this.addParameter(v)).join(", ");
            return `${this.visit(e.expression)} IN (${rhs})`;
        }

        throw new Error("Unsupported expression in QueryFormatter: " + e.kind + " — " + e.toString());
    }

    private formatBinary(e: BinaryExpression): string {
        if (e.kind === "??")
            return `COALESCE(${this.visit(e.left)}, ${this.visit(e.right)})`;

        // NULL-aware equality: `x == null` → IS NULL.
        if ((e.kind === "==" || e.kind === "===") && this.isNullConstant(e.right))
            return `${this.visit(e.left)} IS NULL`;
        if ((e.kind === "==" || e.kind === "===") && this.isNullConstant(e.left))
            return `${this.visit(e.right)} IS NULL`;
        if ((e.kind === "!=" || e.kind === "!==") && this.isNullConstant(e.right))
            return `${this.visit(e.left)} IS NOT NULL`;
        if ((e.kind === "!=" || e.kind === "!==") && this.isNullConstant(e.left))
            return `${this.visit(e.right)} IS NOT NULL`;

        return `(${this.visit(e.left)} ${this.sqlOperator(e.kind)} ${this.visit(e.right)})`;
    }

    private isNullConstant(e: Expression): boolean {
        return e instanceof ConstantExpression && e.value == null;
    }

    private sqlOperator(op: OpBinary): string {
        switch (op) {
            case "==": case "===": return "=";
            case "!=": case "!==": return "<>";
            case "&&": return "AND";
            case "||": return "OR";
            case "<": return "<";
            case "<=": return "<=";
            case ">": return ">";
            case ">=": return ">=";
            case "+": return "+";
            case "-": return "-";
            case "*": return "*";
            case "/": return "/";
            case "%": return "%";
            default: throw new Error("Unsupported SQL binary operator: " + op);
        }
    }
}
