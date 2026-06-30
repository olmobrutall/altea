import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression,
} from "./expressions";
import { OpBinary } from "quote-transformer/quoted";
import {
    SourceExpression, TableExpression, SelectExpression, JoinExpression,
    ColumnExpression, ColumnDeclaration, OrderExpression, JoinType,
    AggregateExpression, SqlFunctionExpression, SqlConstantExpression, SqlLiteralExpression,
    CaseExpression, LikeExpression, ScalarExpression, ExistsExpression, InExpression,
    IsNullExpression, IsNotNullExpression, PrimaryKeyExpression,
    CommandExpression, DeleteExpression, UpdateExpression, InsertSelectExpression,
    CommandAggregateExpression,
} from "./expressions.sql";
import { ObjectName } from "../schema/objectName";
import { Alias } from "./AliasGenerator";
import { LiteralType } from "../../entities/types";
import { DbExpressionVisitor } from "./visitors/DbExpressionVisitor";

// Port of Signum's QueryFormatter. Like the C# formatter, this is a visitor
// that renders SQL as a side effect while returning the original expression tree.

export interface FormattedQuery {
    readonly sql: string;
    readonly parameters: unknown[];
}

export class QueryFormatter extends DbExpressionVisitor {
    private readonly parameters: unknown[] = [];
    // A constant value can be rendered more than once — notably a group key
    // expression that appears in both the SELECT list and the GROUP BY clause (and,
    // after ConditionsRewriter, the bit constants of a key CASE). Each occurrence
    // must use the *same* placeholder, or SQL Server / Postgres see the SELECT and
    // GROUP BY expressions as different and reject the grouping. Reuse one parameter
    // per primitive value (the IN-list path adds its parameters directly and is
    // unaffected).
    private readonly paramByValue = new Map<unknown, string>();
    private parts: string[] = [];

    constructor(private readonly isPostgres: boolean) {
        super();
    }

    static format(select: SelectExpression, isPostgres: boolean): FormattedQuery {
        const f = new QueryFormatter(isPostgres);
        f.visit(select);
        return { sql: f.toSql(), parameters: f.parameters };
    }

    // Bulk-DML entry: formats a CommandExpression (Update/Delete/InsertSelect or a
    // CommandAggregate of them) into a statement that, when run via executeQuery,
    // yields a single scalar = the affected row count.
    static formatCommand(command: CommandExpression, isPostgres: boolean): FormattedQuery {
        const f = new QueryFormatter(isPostgres);
        f.visit(command);
        return { sql: f.toSql(), parameters: f.parameters };
    }

    private append(value: string): void {
        this.parts.push(value);
    }

    private toSql(): string {
        return this.parts.join("");
    }

    private capture(action: () => unknown): string {
        const previous = this.parts;
        this.parts = [];
        action();
        const result = this.toSql();
        this.parts = previous;
        return result;
    }

    private quote(id: string): string {
        return this.isPostgres ? `"${id}"` : `[${id}]`;
    }

    private addParameter(value: unknown): string {
        this.parameters.push(value);
        return this.isPostgres ? `$${this.parameters.length}` : `@p${this.parameters.length - 1}`;
    }

    // ---- sources ----------------------------------------------------------

    override visitSelect(s: SelectExpression): Expression {
        const cols = s.columns.length
            ? s.columns.map(c => this.capture(() => this.visitColumnDeclaration(c))).join(", ")
            : "*";

        const top = s.top != null && !this.isPostgres ? `TOP ${this.literalNumber(s.top)} ` : "";
        this.append(`SELECT ${s.isDistinct ? "DISTINCT " : ""}${top}${cols}`);

        if (s.from != null)
            this.append(`\nFROM ${this.capture(() => this.visitSource(s.from!))}`);
        if (s.where != null)
            this.append(`\nWHERE ${this.capture(() => this.visit(s.where))}`);
        if (s.groupBy.length)
            this.append(`\nGROUP BY ${s.groupBy.map(g => this.capture(() => this.visit(g))).join(", ")}`);
        if (s.orderBy.length)
            this.append(`\nORDER BY ${s.orderBy.map(o => this.capture(() => this.visitOrderBy(o))).join(", ")}`);
        if (s.top != null && this.isPostgres)
            this.append(`\nLIMIT ${this.literalNumber(s.top)}`);

        return s;
    }

    private quoteObjectName(on: ObjectName): string {
        return on.schema?.name
            ? `${this.quote(on.schema.name)}.${this.quote(on.name)}`
            : this.quote(on.name);
    }

    protected override visitSource(src: SourceExpression): SourceExpression {
        if (src instanceof TableExpression) {
            this.append(`${this.quoteObjectName(src.table.name)} ${this.quoteAlias(src.alias)}`);
            return src;
        }

        if (src instanceof SelectExpression) {
            this.append(`(\n${this.capture(() => this.visitSelect(src))}\n) ${this.quoteAlias(src.alias)}`);
            return src;
        }

        if (src instanceof JoinExpression) {
            this.visitJoin(src);
            return src;
        }

        throw new Error("Unsupported source in QueryFormatter: " + src.kind);
    }

    override visitJoin(j: JoinExpression): Expression {
        const keyword = this.joinKeyword(j.joinType);
        const left = this.capture(() => this.visitSource(j.left));
        const right = this.capture(() => this.visitSource(j.right));
        const on = j.condition != null ? ` ON ${this.capture(() => this.visit(j.condition))}` : "";
        this.append(`${left}\n${keyword} ${right}${on}`);
        return j;
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

    override visitColumnDeclaration(c: ColumnDeclaration): ColumnDeclaration {
        this.visit(c.expression);
        this.append(` AS ${this.quote(c.name)}`);
        return c;
    }

    override visitOrderBy(o: OrderExpression): OrderExpression {
        this.visit(o.expression);
        this.append(` ${o.orderType === "Ascending" ? "ASC" : "DESC"}`);
        return o;
    }

    private quoteAlias(alias: Alias): string {
        // A table-name alias (Signum's `Alias(ObjectName)`, used as the UPDATE/DELETE
        // target reference) renders as the qualified, per-part-quoted table name —
        // not the whole dotted string quoted as one identifier.
        if (alias.objectName != null)
            return this.quoteObjectName(alias.objectName);
        return this.quote(alias.toString());
    }

    private literalNumber(e: Expression): string {
        if (e instanceof ConstantExpression && typeof e.value === "number")
            return String(e.value);
        if (e instanceof SqlConstantExpression && typeof e.value === "number")
            return String(e.value);
        return this.capture(() => this.visit(e));
    }

    // ---- scalar expressions ----------------------------------------------

    override visitColumn(e: ColumnExpression): Expression {
        this.append(`${this.quoteAlias(e.alias)}.${this.quote(e.name!)}`);
        return e;
    }

    override visitPrimaryKey(e: PrimaryKeyExpression): Expression {
        this.visit(e.value);
        return e;
    }

    override visitConstant(e: ConstantExpression): Expression {
        if (e.value == null) {
            this.append("NULL");
            return e;
        }
        const placeholder = this.parameterFor(e.value);
        // A non-integer numeric value stays a bound parameter (cache-friendly, safe) but
        // is given an explicit type: Postgres otherwise infers an untyped parameter from
        // its context — `intColumn + $1` coerces a `0.5` parameter to integer and rejects
        // it ("invalid input syntax for type integer"). The CAST keeps the SQL text
        // constant across values, so the plan still caches.
        if (typeof e.value === "number" && !Number.isInteger(e.value))
            this.append(`CAST(${placeholder} AS float)`);
        else
            this.append(placeholder);
        return e;
    }

    // SqlConstantExpression renders as an INLINE literal (Signum's VisitSqlConstant),
    // not a bound parameter — so synthetic offsets like substring/indexOf's `+1`/`-1`
    // carry a known SQL type. Postgres rejects `$1 + $2` ("operator is not unique:
    // unknown + unknown") when both operands are untyped parameters; an inline literal
    // gives the arithmetic a typed operand. Booleans render dialect-aware (bit 1/0 on
    // SQL Server, true/false on Postgres); strings are quoted; numbers print verbatim.
    override visitSqlLiteral(e: SqlLiteralExpression): Expression {
        this.append(e.value);
        return e;
    }

    override visitSqlConstant(e: SqlConstantExpression): Expression {
        if (e.value == null)
            this.append("NULL");
        else if (typeof e.value === "boolean")
            this.append(this.isPostgres ? (e.value ? "true" : "false") : (e.value ? "1" : "0"));
        else if (typeof e.value === "string")
            this.append(e.value === "" ? "''" : `'${e.value.replace(/'/g, "''")}'`);
        else
            this.append(String(e.value));
        return e;
    }

    // Reuse one placeholder per (primitive) constant value (see paramByValue).
    private parameterFor(value: unknown): string {
        const existing = this.paramByValue.get(value);
        if (existing != null)
            return existing;
        const placeholder = this.addParameter(value);
        this.paramByValue.set(value, placeholder);
        return placeholder;
    }

    override visitBinary(e: BinaryExpression): Expression {
        this.formatBinary(e);
        return e;
    }

    override visitUnary(e: UnaryExpression): Expression {
        const op = e.kind === "!" ? "NOT " : e.kind === "-u" ? "-" : e.kind === "+u" ? "+" : "~";
        this.append(`(${op}`);
        this.visit(e.expression);
        this.append(")");
        return e;
    }

    override visitConditional(e: ConditionalExpression): Expression {
        this.append("CASE WHEN ");
        this.visit(e.condition);
        this.append(" THEN ");
        this.visit(e.whenTrue);
        this.append(" ELSE ");
        this.visit(e.whenFalse);
        this.append(" END");
        return e;
    }

    override visitCast(e: CastExpression): Expression {
        this.visit(e.expression);
        return e;
    }

    override visitIsNull(e: IsNullExpression): Expression {
        this.visit(e.expression);
        this.append(" IS NULL");
        return e;
    }

    override visitIsNotNull(e: IsNotNullExpression): Expression {
        this.visit(e.expression);
        this.append(" IS NOT NULL");
        return e;
    }

    override visitLike(e: LikeExpression): Expression {
        this.visit(e.expression);
        this.append(" LIKE ");
        this.visit(e.pattern);
        return e;
    }

    override visitAggregate(e: AggregateExpression): Expression {
        const inner = e.arguments.length ? e.arguments.map(a => this.capture(() => this.visit(a))).join(", ") : "*";
        const fn = e.aggregateFunction === "Average" ? "AVG"
            : e.aggregateFunction === "CountDistinct" ? "COUNT"
                : e.aggregateFunction.toUpperCase();
        const distinct = e.aggregateFunction === "CountDistinct" ? "DISTINCT " : "";
        this.append(`${fn}(${distinct}${inner})`);
        return e;
    }

    override visitSqlFunction(e: SqlFunctionExpression): Expression {
        this.append(`${e.sqlFunction}(${e.arguments.map(a => this.capture(() => this.visit(a))).join(", ")})`);
        return e;
    }

    override visitCase(e: CaseExpression): Expression {
        const whens = e.whens
            .map(w => `WHEN ${this.capture(() => this.visit(w.condition))} THEN ${this.capture(() => this.visit(w.value))}`)
            .join(" ");
        const defaultValue = e.defaultValue != null ? this.capture(() => this.visit(e.defaultValue)) : "NULL";
        this.append(`CASE ${whens} ELSE ${defaultValue} END`);
        return e;
    }

    override visitScalar(e: ScalarExpression): Expression {
        this.append(`(${this.capture(() => this.visitSelect(e.select!))})`);
        return e;
    }

    override visitExists(e: ExistsExpression): Expression {
        this.append(`EXISTS(${this.capture(() => this.visitSelect(e.select!))})`);
        return e;
    }

    override visitIn(e: InExpression): Expression {
        this.visit(e.expression);
        const rhs = e.select != null
            ? this.capture(() => this.visitSelect(e.select!))
            : (e.values ?? []).map(v => this.addParameter(v)).join(", ");
        this.append(` IN (${rhs})`);
        return e;
    }

    // ---- command nodes (bulk DML) ----------------------------------------

    override visitCommandAggregate(ca: CommandAggregateExpression): Expression {
        ca.commands.forEach((c, i) => {
            if (i > 0) this.append("\n");
            this.visit(c);
        });
        return ca;
    }

    override visitDelete(e: DeleteExpression): Expression {
        const core = this.capture(() => {
            this.append("DELETE FROM ");
            this.append(e.alias != null ? this.quoteAlias(e.alias) : this.quoteObjectName(e.name));
            // SQL Server: DELETE FROM t FROM <source>; Postgres: DELETE FROM t USING <source>.
            this.append(this.isPostgres ? "\nUSING " : "\nFROM ");
            this.visitSource(e.source);
            if (e.where != null) {
                this.append("\nWHERE ");
                this.visit(e.where);
            }
        });
        this.append(this.wrapRowCount(core, e.returnRowCount));
        return e;
    }

    override visitUpdate(e: UpdateExpression): Expression {
        const core = this.capture(() => {
            this.append(`UPDATE ${this.quoteObjectName(e.name)} SET\n`);
            e.assignments.forEach((a, i) => {
                if (i > 0) this.append(",\n");
                this.append(`${this.quote(a.column)} = `);
                this.visit(a.expression);
            });
            this.append("\nFROM ");
            this.visitSource(e.source);
            if (e.where != null) {
                this.append("\nWHERE ");
                this.visit(e.where);
            }
        });
        this.append(this.wrapRowCount(core, e.returnRowCount));
        return e;
    }

    override visitInsertSelect(e: InsertSelectExpression): Expression {
        const core = this.capture(() => {
            this.append(`INSERT INTO ${this.quoteObjectName(e.name)}(`);
            this.append(e.assignments.map(a => this.quote(a.column)).join(", "));
            this.append(")\nSELECT ");
            e.assignments.forEach((a, i) => {
                if (i > 0) this.append(", ");
                this.visit(a.expression);
            });
            this.append("\nFROM ");
            this.visitSource(e.source);
        });
        this.append(this.wrapRowCount(core, e.returnRowCount));
        return e;
    }

    // Signum's PrintSelectRowCount: make the statement yield its affected-row count
    // as a single scalar. SQL Server appends `SELECT @@rowcount`; Postgres wraps the
    // statement in a CTE with `RETURNING 1` and counts the returned rows.
    private wrapRowCount(core: string, returnRowCount: boolean): string {
        if (!returnRowCount)
            return core + ";";
        if (!this.isPostgres)
            return core + ";\nSELECT @@rowcount";
        return `WITH rows AS (\n${core}\nRETURNING 1\n)\nSELECT CAST(COUNT(*) AS INTEGER) FROM rows`;
    }

    private formatBinary(e: BinaryExpression): void {
        if (e.kind === "??") {
            this.append(`COALESCE(${this.capture(() => this.visit(e.left))}, ${this.capture(() => this.visit(e.right))})`);
            return;
        }

        // Postgres concatenates strings with `||`, not `+` (SQL Server uses `+` for
        // both). When either operand is string-typed, emit `||` on Postgres.
        if (e.kind === "+" && this.isPostgres && (e.left.type === LiteralType.string || e.right.type === LiteralType.string)) {
            this.append(`(${this.capture(() => this.visit(e.left))} || ${this.capture(() => this.visit(e.right))})`);
            return;
        }

        if ((e.kind === "==" || e.kind === "===") && this.isNullConstant(e.right)) {
            this.append(`${this.capture(() => this.visit(e.left))} IS NULL`);
            return;
        }
        if ((e.kind === "==" || e.kind === "===") && this.isNullConstant(e.left)) {
            this.append(`${this.capture(() => this.visit(e.right))} IS NULL`);
            return;
        }
        if ((e.kind === "!=" || e.kind === "!==") && this.isNullConstant(e.right)) {
            this.append(`${this.capture(() => this.visit(e.left))} IS NOT NULL`);
            return;
        }
        if ((e.kind === "!=" || e.kind === "!==") && this.isNullConstant(e.left)) {
            this.append(`${this.capture(() => this.visit(e.right))} IS NOT NULL`);
            return;
        }

        this.append(`(${this.capture(() => this.visit(e.left))} ${this.sqlOperator(e.kind)} ${this.capture(() => this.visit(e.right))})`);
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
