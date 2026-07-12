import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression,
} from "./expressions";
import { OpBinary } from "quote-transformer/quoted";
import {
    SourceExpression, TableExpression, SelectExpression, JoinExpression,
    SetOperatorExpression, SourceWithAliasExpression,
    ColumnExpression, ColumnDeclaration, OrderExpression, JoinType,
    AggregateExpression, RowNumberExpression, SqlFunctionExpression, SqlConstantExpression, SqlLiteralExpression,
    CaseExpression, LikeExpression, ScalarExpression, ExistsExpression, InExpression,
    IsNullExpression, IsNotNullExpression, PrimaryKeyExpression, SqlCastExpression, ToDayOfWeekExpression,
    CommandExpression, DeleteExpression, UpdateExpression, InsertSelectExpression,
    CommandAggregateExpression, SqlArrayIndexExpression, SqlTableValuedFunctionExpression,
} from "./expressions.sql";
import { ObjectName } from "../schema/objectName";
import { sqlEscape } from "./sqlEscape";
import { normalizeScalar } from "../normalizeScalar";
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

    // Quote an identifier only when it must be (reserved word / non-simple name / not
    // already lowercase on PG) — Signum's SqlEscape. So altea emits `a.sex_id`, not
    // `"a"."sex_id"`.
    private quote(id: string): string {
        return sqlEscape(id, this.isPostgres);
    }

    private addParameter(value: unknown): string {
        // Normalise to a driver-portable form (same as the save path): notably a bound
        // Temporal value — e.g. a folded `Clock.now` constant — must become a string, as
        // the mssql driver throws calling valueOf on a Temporal object.
        this.parameters.push(normalizeScalar(value));
        return this.isPostgres ? `$${this.parameters.length}` : `@p${this.parameters.length - 1}`;
    }

    // ---- sources ----------------------------------------------------------

    override visitSelect(s: SelectExpression): Expression {
        // One column per line, indented — Signum's column layout.
        const cols = s.columns.length
            ? "\n  " + s.columns.map(c => this.capture(() => this.visitColumnDeclaration(c))).join(", \n  ")
            : "*";

        // SQL Server: TOP and OFFSET/FETCH are mutually exclusive — when there is an
        // OFFSET, the row limit is expressed with FETCH NEXT (below), not TOP.
        const top = s.top != null && (this.isPostgres ? false : s.offset == null) ? `TOP ${this.literalNumber(s.top)} ` : "";
        this.append(`SELECT ${s.isDistinct ? "DISTINCT " : ""}${top}${cols}`);

        if (s.from != null)
            this.append(`\nFROM ${this.capture(() => this.visitSource(s.from!))}`);
        if (s.where != null)
            this.append(`\nWHERE ${this.capture(() => this.visit(s.where))}`);
        if (s.groupBy.length)
            this.append(`\nGROUP BY ${s.groupBy.map(g => this.capture(() => this.visit(g))).join(", ")}`);
        if (s.orderBy.length)
            this.append(`\nORDER BY ${s.orderBy.map(o => this.capture(() => this.visitOrderBy(o))).join(", ")}`);
        else if (s.offset != null && !this.isPostgres)
            // SQL Server requires an ORDER BY for OFFSET/FETCH; a bare `skip` with no
            // order gets a no-op ordering (Postgres needs none).
            this.append(`\nORDER BY (SELECT 1)`);

        if (this.isPostgres) {
            if (s.top != null)
                this.append(`\nLIMIT ${this.literalNumber(s.top)}`);
            if (s.offset != null)
                this.append(`\nOFFSET ${this.literalNumber(s.offset)}`);
        } else if (s.offset != null) {
            this.append(`\nOFFSET ${this.literalNumber(s.offset)} ROWS`);
            if (s.top != null)
                this.append(`\nFETCH NEXT ${this.literalNumber(s.top)} ROWS ONLY`);
        }

        return s;
    }

    private quoteObjectName(on: ObjectName): string {
        // A SQL Server temp table (`#Name`) lives in tempdb and is referenced unqualified —
        // never schema-prefixed (`dbo.#Name` is invalid). Same on Postgres temp tables.
        if (on.name.startsWith("#"))
            return this.quote(on.name);
        // Qualify with the schema (Signum always does): the explicit one, else the
        // dialect default the tables actually live in — `public` (PG) / `dbo` (SS).
        const schema = on.schema?.name || (this.isPostgres ? "public" : "dbo");
        return `${this.quote(schema)}.${this.quote(on.name)}`;
    }

    protected override visitSource(src: SourceExpression): SourceExpression {
        if (src instanceof TableExpression) {
            this.append(`${this.quoteObjectName(src.table.name)} AS ${this.quoteAlias(src.alias)}`);
            return src;
        }

        if (src instanceof SelectExpression) {
            this.append(`(\n${indent(this.capture(() => this.visitSelect(src)))}\n) AS ${this.quoteAlias(src.alias)}`);
            return src;
        }

        if (src instanceof JoinExpression) {
            this.visitJoin(src);
            return src;
        }

        if (src instanceof SetOperatorExpression) {
            this.append(`(\n${indent(this.renderSetOperatorBody(src))}\n) AS ${this.quoteAlias(src.alias)}`);
            return src;
        }

        if (src instanceof SqlTableValuedFunctionExpression) {
            const args = src.arguments.map(a => this.capture(() => this.visit(a))).join(", ");
            // Postgres SRFs (generate_subscripts) take a column-alias list — `func(args) AS
            // alias(colName)` — which names the output column so the projector can reference it.
            // SQL Server rejects a column alias on a table-valued function ("cannot have a column
            // alias"): the UDF already declares its column names, so emit only `func(args) AS alias`
            // and let the projector reference `alias.ColName`.
            const columnAlias = this.isPostgres ? `(${this.quote(src.columnName)})` : "";
            // Escape each dot-separated segment of the (possibly schema-qualified) function name,
            // so a mixed-case UDF like public."MinimumTableValued" is quoted on Postgres (unquoted
            // it would fold to lowercase and not resolve). Built-in lowercase names (generate_subscripts,
            // pg_catalog.*) stay bare.
            const funcName = src.functionName.split(".").map(p => sqlEscape(p, this.isPostgres)).join(".");
            this.append(`${funcName}(${args}) AS ${this.quoteAlias(src.alias)}${columnAlias}`);
            return src;
        }

        throw new Error("Unsupported source in QueryFormatter: " + src.kind);
    }

    // The body of a UNION/… source: each operand SELECT rendered bare (no derived-
    // table alias — set-operation components are not aliased), joined by the operator
    // keyword. Nested set operators (3+ implementations) recurse.
    private renderSetOperatorBody(s: SetOperatorExpression): string {
        const side = (x: SourceWithAliasExpression): string =>
            x instanceof SetOperatorExpression ? this.renderSetOperatorBody(x)
                : this.capture(() => this.visitSelect(x as SelectExpression));
        const keyword = s.operator === "UnionAll" ? "UNION ALL"
            : s.operator === "Union" ? "UNION"
                : s.operator === "Intersect" ? "INTERSECT" : "EXCEPT";
        return `${side(s.left)}\n${keyword}\n${side(s.right)}`;
    }

    override visitJoin(j: JoinExpression): Expression {
        const keyword = this.joinKeyword(j.joinType);
        const left = this.capture(() => this.visitSource(j.left));
        const right = this.capture(() => this.visitSource(j.right));
        let on = j.condition != null ? ` ON ${this.capture(() => this.visit(j.condition))}` : "";
        // Postgres renders OUTER APPLY as LEFT JOIN LATERAL, which (unlike CROSS JOIN LATERAL)
        // requires an ON clause; an apply has no join condition, so supply `ON true`.
        if (on === "" && this.isPostgres && j.joinType === "OuterApply")
            on = " ON true";
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
        // Omit a redundant alias — Signum's AppendColumn skips `AS x` when the expression
        // is a column already named `x` (so `a.id`, not `a.id AS id`).
        const redundant = c.expression instanceof ColumnExpression && c.expression.name === c.name;
        if (c.name && !redundant)
            this.append(` AS ${this.quote(c.name)}`);
        return c;
    }

    override visitOrderBy(o: OrderExpression): OrderExpression {
        this.visit(o.expression);
        this.append(` ${o.orderType === "Ascending" ? "ASC" : "DESC"}`);
        return o;
    }

    // ROW_NUMBER() OVER (ORDER BY …). SQL Server requires an ORDER BY inside OVER;
    // when the query imposes no order fall back to a constant (`(SELECT 1)`, the same
    // idiom the OFFSET/FETCH path uses), valid on both dialects.
    override visitRowNumber(e: RowNumberExpression): Expression {
        if (e.orderBy.length === 0)
            this.append("ROW_NUMBER() OVER (ORDER BY (SELECT 1))");
        else
            this.append(`ROW_NUMBER() OVER (ORDER BY ${e.orderBy.map(o => this.capture(() => this.visitOrderBy(o))).join(", ")})`);
        return e;
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
        // A numeric value stays a bound parameter (cache-friendly, safe) but on Postgres is
        // given an explicit type: node-postgres sends parameters untyped, so Postgres infers
        // them from context and defaults to `text` where there is none — e.g.
        // `AVG(CASE WHEN … THEN $1 ELSE $2 END)` becomes `avg(text)` and fails, and
        // `intColumn + $1` coerces a `0.5` parameter to integer. A CAST keeps the SQL text
        // constant across values, so the plan still caches. SQL Server infers parameter types
        // from context, so it needs none. Integers use the narrowest type that fits (so an
        // int4 column's index stays usable); non-integers use float.
        if (this.isPostgres && typeof e.value === "number") {
            const castType = !Number.isInteger(e.value) ? "float"
                : (e.value >= -2147483648 && e.value <= 2147483647) ? "integer" : "bigint";
            this.append(`CAST(${placeholder} AS ${castType})`);
        } else if (typeof e.value === "number" && !Number.isInteger(e.value)) {
            this.append(`CAST(${placeholder} AS float)`);
        } else {
            this.append(placeholder);
        }
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
                // Sample / population standard deviation: SQL Server STDEV/STDEVP,
                // Postgres STDDEV_SAMP/STDDEV_POP.
                : e.aggregateFunction === "StdDev" ? (this.isPostgres ? "STDDEV_SAMP" : "STDEV")
                    : e.aggregateFunction === "StdDevP" ? (this.isPostgres ? "STDDEV_POP" : "STDEVP")
                        : e.aggregateFunction.toUpperCase();
        const distinct = e.aggregateFunction === "CountDistinct" ? "DISTINCT " : "";
        // An ordered aggregate (string_agg from `.join()` over an ordered sub-query): Postgres puts
        // the ORDER BY inside the call, SQL Server appends WITHIN GROUP (ORDER BY …).
        if (e.orderBy != null && e.orderBy.length > 0) {
            const orderSql = e.orderBy
                .map(o => `${this.capture(() => this.visit(o.expression))}${o.orderType === "Ascending" ? " ASC" : " DESC"}`)
                .join(", ");
            this.append(this.isPostgres
                ? `${fn}(${distinct}${inner} ORDER BY ${orderSql})`
                : `${fn}(${distinct}${inner}) WITHIN GROUP (ORDER BY ${orderSql})`);
            return e;
        }
        this.append(`${fn}(${distinct}${inner})`);
        return e;
    }

    override visitSqlFunction(e: SqlFunctionExpression): Expression {
        // Postgres EXTRACT(<part> from <source>) — Signum's QueryFormatter special-cases
        // it the same way (the part is an unquoted keyword, not a comma-separated arg).
        if (this.isPostgres && e.sqlFunction === "EXTRACT") {
            this.append(`EXTRACT(${this.capture(() => this.visit(e.arguments[0]))} from ${this.capture(() => this.visit(e.arguments[1]))})`);
            return e;
        }
        this.append(`${e.sqlFunction}(${e.arguments.map(a => this.capture(() => this.visit(a))).join(", ")})`);
        return e;
    }

    override visitSqlCast(e: SqlCastExpression): Expression {
        this.append("CAST(");
        this.visit(e.expression);
        this.append(` AS ${e.sqlType})`);
        return e;
    }

    override visitArrayIndex(e: SqlArrayIndexExpression): Expression {
        this.append("(");
        this.visit(e.array);
        this.append(")[");
        this.visit(e.index);
        this.append("]");
        return e;
    }

    // A ToDayOfWeek that survived into a server position (e.g. ORDER BY over the group key)
    // renders as its raw inner weekday — the ISO conversion is a client concern and is
    // order-preserving enough (Signum likewise orders by the raw DATEPART).
    override visitToDayOfWeek(e: ToDayOfWeekExpression): Expression {
        this.visit(e.expression);
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
        // Explicit-id insert: the projection assigns the identity PK column (Signum's
        // Administrator.DisableIdentity). SQL Server needs SET IDENTITY_INSERT ON/OFF around
        // the statement; Postgres needs OVERRIDING SYSTEM VALUE (its PKs are GENERATED ALWAYS).
        const pkCol = e.table.primaryKey.column;
        const identityInsert = pkCol.identity && e.assignments.some(a => a.column === pkCol.name);

        const core = this.capture(() => {
            this.append(`INSERT INTO ${this.quoteObjectName(e.name)}(`);
            this.append(e.assignments.map(a => this.quote(a.column)).join(", "));
            this.append(")");
            if (identityInsert && this.isPostgres)
                this.append(" OVERRIDING SYSTEM VALUE");
            this.append("\nSELECT ");
            e.assignments.forEach((a, i) => {
                if (i > 0) this.append(", ");
                this.visit(a.expression);
            });
            this.append("\nFROM ");
            this.visitSource(e.source);
        });
        let sql = this.wrapRowCount(core, e.returnRowCount);
        if (identityInsert && !this.isPostgres) {
            const t = this.quoteObjectName(e.name);
            sql = `SET IDENTITY_INSERT ${t} ON;\n${sql}\nSET IDENTITY_INSERT ${t} OFF;`;
        }
        this.append(sql);
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

        // SQL Server also uses `+` to concatenate, but with a numeric operand it does
        // arithmetic (converting the string operand to a number, which fails). Cast the
        // non-string operand(s) to text so `+` concatenates — e.g. `a.name + i`.
        if (e.kind === "+" && !this.isPostgres && (e.left.type === LiteralType.string || e.right.type === LiteralType.string)) {
            const side = (x: Expression) => x.type === LiteralType.string
                ? this.capture(() => this.visit(x))
                : `CAST(${this.capture(() => this.visit(x))} AS nvarchar(max))`;
            this.append(`(${side(e.left)} + ${side(e.right)})`);
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

// Indent every line of a nested subquery by two spaces, so a derived table / APPLY /
// set-operator source reads as a visually nested block (Signum's QueryFormatter does the
// same). Nesting compounds naturally — each enclosing source indents the already-indented
// inner text again.
function indent(sql: string): string {
    return sql.replace(/^/gm, "  ");
}
