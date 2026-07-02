import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression, CallExpression, PropertyExpression,
    ParameterExpression, LambdaExpression,
} from "./expressions";
import {
    ColumnExpression, SqlConstantExpression, SqlLiteralExpression, PrimaryKeyExpression,
    IsNullExpression, IsNotNullExpression, LikeExpression, SqlFunctionExpression, SqlCastExpression,
    AggregateExpression, AggregateRequestsExpression, CaseExpression, When, ScalarExpression, ExistsExpression, InExpression,
    ProjectionExpression,
} from "./expressions.sql";
import { EnumType, LiteralType, TemporalType, Type } from "../../entities/types";
import { enumEntityMembers } from "../../entities/enumEntity";
import { DbExpressionVisitor } from "./visitors/DbExpressionVisitor";

// Port of Signum's DbExpressionNominator. Like Signum's it does two jobs in one
// bottom-up pass and is a DbExpressionVisitor (dispatch is `accept` double-dispatch):
//
//  1. **Translate** the residual method-call nodes the binder leaves behind
//     (`a.name.indexOf(…)`, `a.name.toLowerCase()`, …) into SQL expressions
//     (`SqlFunctionExpression`/`LikeExpression`/arithmetic) — the port of
//     `HardCodedMethods`. Translation lives here, not in the binder, matching C#.
//  2. **Nominate** the maximal server-evaluable subtrees: a node is a candidate
//     iff its type is server-supported and all its (already-rewritten) children
//     are candidates. The maximal candidate subtrees become SELECT columns.
//
// Because step 1 rewrites nodes, each composite override nominates the *rebuilt*
// node and inspects the *rebuilt* children (the base DbExpressionVisitor rebuilds a
// node when a child changed, and returns it unchanged otherwise). The default base
// traversal already recurses into and doesn't nominate the client-materialised
// nodes (Entity / Embedded / Mixin / LiteReference / object & `new` literals).
class DbExpressionNominator extends DbExpressionVisitor {
    private readonly candidates = new Set<Expression>();

    constructor(private readonly isPostgres: boolean) {
        super();
    }

    // Translate + nominate: returns the rewritten tree and the candidate set (the
    // server-evaluable subtrees of it). Mirrors C#'s `Nominate(e, out newExpression)`.
    static nominate(expr: Expression, isPostgres: boolean): { candidates: Set<Expression>; expression: Expression } {
        const n = new DbExpressionNominator(isPostgres);
        const expression = n.visit(expr);
        return { candidates: n.candidates, expression };
    }

    // Translate only (no candidate set needed) — for WHERE / ORDER BY / aggregate
    // arguments, where the rewritten predicate/key is what we want. Mirrors C#'s
    // `FullNominate`, minus the "throws if anything is left untranslated" assertion.
    static translate(expr: Expression, isPostgres: boolean): Expression {
        return new DbExpressionNominator(isPostgres).visit(expr);
    }

    private add<T extends Expression>(expression: T): T {
        this.candidates.add(expression);
        return expression;
    }

    private has(expression: Expression | undefined): boolean {
        return expression != null && this.candidates.has(expression);
    }

    // Nominate `node` iff every (rewritten) child is already a candidate.
    private nominateIfAll<T extends Expression>(node: T, children: readonly (Expression | undefined)[]): T {
        if (children.every(c => c == null || this.has(c)))
            this.add(node);
        return node;
    }

    // ---- leaf server values: always candidates ---------------------------

    override visitColumn(column: ColumnExpression): Expression {
        return this.add(column);
    }

    override visitSqlConstant(sqlConstant: SqlConstantExpression): Expression {
        return this.add(sqlConstant);
    }

    override visitSqlLiteral(sqlLiteral: SqlLiteralExpression): Expression {
        return this.add(sqlLiteral);
    }

    override visitConstant(constant: ConstantExpression): Expression {
        return this.add(constant);
    }

    // The id wrapper recurses to its column (rebuilding if it changed) but is not
    // itself a column candidate.
    override visitPrimaryKey(pk: PrimaryKeyExpression): Expression {
        return super.visitPrimaryKey(pk);
    }

    // ---- composite SQL nodes: candidate iff every operand is -------------

    override visitIsNull(node: IsNullExpression): Expression {
        const r = super.visitIsNull(node) as IsNullExpression;
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitIsNotNull(node: IsNotNullExpression): Expression {
        const r = super.visitIsNotNull(node) as IsNotNullExpression;
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitLike(node: LikeExpression): Expression {
        const r = super.visitLike(node) as LikeExpression;
        return this.nominateIfAll(r, [r.expression, r.pattern]);
    }

    override visitSqlFunction(node: SqlFunctionExpression): Expression {
        const r = super.visitSqlFunction(node) as SqlFunctionExpression;
        return this.nominateIfAll(r, [r.object, ...r.arguments]);
    }

    override visitSqlCast(node: SqlCastExpression): Expression {
        const r = super.visitSqlCast(node) as SqlCastExpression;
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitAggregate(node: AggregateExpression): Expression {
        const r = super.visitAggregate(node) as AggregateExpression;
        return this.nominateIfAll(r, r.arguments);
    }

    // A deferred group aggregate is nominated as a whole (so the column projector
    // emits a column for it); its inner aggregate belongs to the group-by select's
    // scope, so we don't recurse. AggregateRewriter rewrites it into a real column
    // before formatting. Mirrors Signum's `!innerProjection → Add(request)`.
    override visitAggregateRequest(node: AggregateRequestsExpression): Expression {
        return this.add(node);
    }

    override visitCase(node: CaseExpression): Expression {
        const r = super.visitCase(node) as CaseExpression;
        return this.nominateIfAll(r, [...r.whens.flatMap(w => [w.condition, w.value]), r.defaultValue]);
    }

    override visitUnary(node: UnaryExpression): Expression {
        const r = super.visitUnary(node) as UnaryExpression;
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitCast(node: CastExpression): Expression {
        const r = super.visitCast(node) as CastExpression;
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitBinary(node: BinaryExpression): Expression {
        const r = super.visitBinary(node) as BinaryExpression;
        return this.nominateIfAll(r, [r.left, r.right]);
    }

    override visitConditional(node: ConditionalExpression): Expression {
        const r = super.visitConditional(node) as ConditionalExpression;
        return this.nominateIfAll(r, [r.condition, r.whenTrue, r.whenFalse]);
    }

    // ---- method-call translation (HardCodedMethods) ----------------------
    // The binder leaves recognised SQL functions as a residual CallExpression with
    // a bound receiver (`CallExpression(PropertyExpression(<column>, name), args)`).
    // Here we visit the receiver/args (translating + nominating them) and lower the
    // call to its SQL form, then nominate the lowered server expression.

    override visitCall(node: CallExpression): Expression {
        if (node.func instanceof PropertyExpression) {
            const receiver = this.visit(node.func.object);
            const args = node.args.map(a => this.visit(a));
            const translated = this.hardCodedMethod(node.func.propertyName, receiver, args);
            if (translated != null)
                return this.visit(translated); // nominate the lowered server expression
            throw new Error(`The method '${node.func.propertyName}' cannot be translated to SQL`);
        }
        throw new Error("Unexpected call reached the nominator: " + node.toString());
    }

    // Port of DbExpressionNominator.HardCodedMethods. Cases are keyed
    // "<receiverType>.<method>" — Signum switches on `DeclaringType.TypeName() + "." +
    // MethodName` ("string.IndexOf"), so a method only matches on the right receiver
    // type (a number's `.toString()` won't hit `string.*`). The JS method names/
    // semantics differ from C# (substring takes an end index not a length; indexOf is
    // 0-based) but the emitted SQL is the same. Returns undefined for an unrecognised
    // receiver/method/arity (visitCall then throws).
    private hardCodedMethod(name: string, source: Expression, args: readonly Expression[]): Expression | undefined {
        const ns = this.receiverNamespace(source);
        if (ns === "Math")
            return this.translateMath(name, args);
        if (ns === "dateTime" || ns === "date")
            return this.translateDateMethod(name, source, args);
        // enum.toString() → a value→name CASE (Signum reads the enum's Name).
        if (name === "toString" && args.length === 0 && source.type instanceof EnumType)
            return this.enumToString(source, source.type);
        // value.toString() → a string CAST (Signum's int/decimal ToString). A string
        // receiver is already text. (Date/temporal ToString is handled above and is
        // still unsupported; entity/lite ToString is resolved earlier in the binder.)
        if (name === "toString" && args.length === 0)
            return source.type === LiteralType.string
                ? source
                : new SqlCastExpression(LiteralType.string, source, this.isPostgres ? "varchar" : "nvarchar(max)");
        if (ns !== "string")
            return undefined;
        switch (`${ns}.${name}`) {
            case "string.contains":
                return args.length === 1 ? new LikeExpression(source, this.likePattern("%", args[0], "%")) : undefined;
            case "string.startsWith":
                return args.length === 1 ? new LikeExpression(source, this.likePattern("", args[0], "%")) : undefined;
            case "string.endsWith":
                return args.length === 1 ? new LikeExpression(source, this.likePattern("%", args[0], "")) : undefined;
            // Signum's StringExtensions.Like: the pattern is a raw SQL LIKE string
            // (its own % / _ wildcards), passed through verbatim.
            case "string.like":
                return args.length === 1 ? new LikeExpression(source, args[0]) : undefined;
            case "string.indexOf":
                return this.translateIndexOf(source, args);
            case "string.toLowerCase":
                return this.sqlFunction(LiteralType.string, this.isPostgres ? "lower" : "LOWER", source);
            case "string.toUpperCase":
                return this.sqlFunction(LiteralType.string, this.isPostgres ? "upper" : "UPPER", source);
            case "string.trimStart":
                return args.length === 0 ? this.sqlFunction(LiteralType.string, this.isPostgres ? "ltrim" : "LTRIM", source) : undefined;
            case "string.trimEnd":
                return args.length === 0 ? this.sqlFunction(LiteralType.string, this.isPostgres ? "rtrim" : "RTRIM", source) : undefined;
            case "string.trim":
                if (args.length !== 0)
                    return undefined;
                return this.isPostgres
                    ? this.sqlFunction(LiteralType.string, "trim", source)
                    : this.sqlFunction(LiteralType.string, "LTRIM", this.sqlFunction(LiteralType.string, "RTRIM", source));
            case "string.substring":
                return this.translateSubstring(source, args);
            // StringExtensions.Start/End/Reverse/Replicate — `LEFT`/`RIGHT`/`REVERSE`/
            // `REPLICATE` (Postgres `left`/`right`/`reverse`/`repeat`).
            case "string.start":
                return args.length === 1 ? this.sqlFunction(LiteralType.string, this.isPostgres ? "left" : "LEFT", source, this.asSqlLiteral(args[0])) : undefined;
            case "string.end":
                return args.length === 1 ? this.sqlFunction(LiteralType.string, this.isPostgres ? "right" : "RIGHT", source, this.asSqlLiteral(args[0])) : undefined;
            case "string.reverse":
                return args.length === 0 ? this.sqlFunction(LiteralType.string, this.isPostgres ? "reverse" : "REVERSE", source) : undefined;
            case "string.replicate":
                return args.length === 1 ? this.sqlFunction(LiteralType.string, this.isPostgres ? "repeat" : "REPLICATE", source, this.asSqlLiteral(args[0])) : undefined;
            default:
                return undefined;
        }
    }

    // Port of DbExpressionNominator's `Math.*` cases. JS `Math` is the receiver
    // (a captured constant), so the SQL is built from the args, not `source`. Each
    // result is double/number. Function names diverge per dialect (ATN2 vs atan2,
    // LOG/LOG10 vs ln/log, ROUND(x,0,1) vs trunc, …).
    private translateMath(name: string, rawArgs: readonly Expression[]): Expression | undefined {
        const n = LiteralType.number;
        const args = rawArgs.map(a => this.asSqlLiteral(a));
        const fn = (ss: string, pg: string = ss) => this.sqlFunction(n, this.isPostgres ? pg : ss, ...args);
        switch (name) {
            case "sign": return fn("SIGN", "sign");
            case "abs": return fn("ABS", "abs");
            case "sin": return fn("SIN", "sin");
            case "asin": return fn("ASIN", "asin");
            case "cos": return fn("COS", "cos");
            case "acos": return fn("ACOS", "acos");
            case "tan": return fn("TAN", "tan");
            case "atan": return fn("ATAN", "atan");
            case "atan2": return fn("ATN2", "atan2");
            case "pow": return fn("POWER", "power");
            case "sqrt": return fn("SQRT", "sqrt");
            case "exp": return fn("EXP", "exp");
            case "floor": return fn("FLOOR", "floor");
            case "ceil": return fn("CEILING", "ceiling");
            case "log": return args.length === 1 ? fn("LOG", "ln") : undefined;   // natural log
            case "log10": return fn("LOG10", "log");                              // base-10 (Postgres log() is base 10)
            // SQL Server ROUND needs an explicit length. Postgres `round(numeric, int)`
            // exists but NOT `round(double precision, int)`, so for a 1-arg round we use
            // the 1-arg `round(double precision)` overload (the value here is double).
            case "round": return this.isPostgres
                ? this.sqlFunction(n, "round", ...args)
                : this.sqlFunction(n, "ROUND", ...args, ...(args.length === 1 ? [new SqlConstantExpression(0, n)] : []));
            case "trunc": return this.isPostgres
                ? this.sqlFunction(n, "trunc", ...args)
                : this.sqlFunction(n, "ROUND", ...args, new SqlConstantExpression(0, n), new SqlConstantExpression(1, n));
            default: return undefined;
        }
    }

    // `enum.toString()` → CASE WHEN col = <value> THEN '<name>' … END, from the
    // enum's members (Signum reads the enum-table Name; altea inlines the mapping).
    // `source` is a pure column read, so repeating it in each WHEN is safe.
    private enumToString(source: Expression, type: EnumType): Expression {
        const whens = enumEntityMembers(type.enumObject).map(m => new When(
            new BinaryExpression("==", source, new SqlConstantExpression(m.id, LiteralType.number)),
            new SqlConstantExpression(m.name, LiteralType.string)));
        return new CaseExpression(whens, new SqlConstantExpression(null, LiteralType.null));
    }

    // Date/time methods (port of DbExpressionNominator's DateTime/DateOnly cases).
    // `source` and `args` are already visited/translated. The truncation helpers
    // preserve the receiver's temporal kind; the diff/convert helpers return number
    // / a cast.
    private translateDateMethod(name: string, source: Expression, args: readonly Expression[]): Expression | undefined {
        switch (name) {
            case "quarter": return this.datePartFn("quarter", "quarter", source);
            // Truncation / "start of" (Signum's TrySqlStartOf): date_trunc on Postgres,
            // DATEADD(part, DATEDIFF(part, 0, x), 0) on SQL Server. Keeps the kind.
            case "yearStart": return this.dateTrunc("year", source);
            case "quarterStart": return this.dateTrunc("quarter", source);
            case "monthStart": return this.dateTrunc("month", source);
            case "weekStart": return this.dateTrunc("week", source);
            case "truncHours": return this.dateTrunc("hour", source);
            case "truncMinutes": return this.dateTrunc("minute", source);
            case "truncSeconds": return this.dateTrunc("second", source);
            // Convert (Signum's TrySqlCast): datetime→date / date→datetime.
            case "toPlainDate": return this.castTemporal("date", source, "date", "date");
            case "toPlainDateTime": return this.castTemporal("dateTime", source, "datetime2", "timestamp");
            // Whole-unit difference (Signum's TryDatePartTo).
            case "daysTo": return args.length === 1 ? this.datePartTo("day", source, args[0]) : undefined;
            case "monthsTo": return args.length === 1 ? this.datePartTo("month", source, args[0]) : undefined;
            case "yearsTo": return args.length === 1 ? this.datePartTo("year", source, args[0]) : undefined;
            default: return undefined;
        }
    }

    // date_trunc('part', x) (Postgres) / DATETRUNC(part, x) (SQL Server 2022+). The
    // older DATEADD(part, DATEDIFF(part, 0, x), 0) fallback overflows int for fine
    // parts (seconds since 1900 > 2^31), so DATETRUNC is used instead. The result has
    // the receiver's temporal type.
    private dateTrunc(part: string, source: Expression): Expression {
        return this.isPostgres
            ? this.sqlFunction(source.type, "date_trunc", new SqlLiteralExpression(`'${part}'`), source)
            : this.sqlFunction(source.type, "DATETRUNC", new SqlLiteralExpression(part), source);
    }

    // CAST(x AS <type>) — the temporal conversions (Signum's TrySqlCast / TrySqlDate).
    private castTemporal(kind: "dateTime" | "date" | "duration", source: Expression, sqlServerType: string, postgresType: string): Expression {
        return new SqlCastExpression(new TemporalType(kind), source, this.isPostgres ? postgresType : sqlServerType);
    }

    // Whole-unit count between two dates (Signum's TryDatePartTo). SQL Server uses a
    // DATEDIFF with a CASE correction (DATEDIFF over-counts boundary crossings);
    // Postgres uses date subtraction (days) / age() (months, years).
    private datePartTo(unit: "day" | "month" | "year", start: Expression, end: Expression): Expression {
        if (!this.isPostgres) {
            const diff = () => this.sqlFunction(LiteralType.number, "DATEDIFF", new SqlLiteralExpression(unit), start, end);
            const added = this.sqlFunction(start.type, "DATEADD", new SqlLiteralExpression(unit), diff(), start);
            return new CaseExpression(
                [new When(new BinaryExpression(">", added, end), new BinaryExpression("-", diff(), new SqlConstantExpression(1, LiteralType.number)))],
                diff());
        }
        // Postgres
        if (unit === "day") {
            const minus = new BinaryExpression("-", end, start);
            // date - date yields an integer day count; timestamp - timestamp an interval.
            return start.type instanceof TemporalType && start.type.kind === "date"
                ? minus
                : this.extract("day", minus);
        }
        const age = this.sqlFunction(new TemporalType("duration"), "age", start, end);
        if (unit === "year")
            return this.extract("year", age);
        // months: Signum's EXTRACT(year FROM age) + EXTRACT(month FROM age) * 12
        return new BinaryExpression("+", this.extract("year", age),
            new BinaryExpression("*", this.extract("month", age), new SqlConstantExpression(12, LiteralType.number)));
    }

    // Postgres EXTRACT(<part> from x) → number (Signum's GetDatePart on Postgres). The
    // formatter special-cases the EXTRACT function name to render `<part> from <source>`.
    private extract(part: string, source: Expression): Expression {
        return this.sqlFunction(LiteralType.number, "EXTRACT", new SqlLiteralExpression(part), source);
    }

    // DATEPART(<kw>, x) on SQL Server; EXTRACT(<kw> from x) on Postgres → number.
    private datePartFn(ss: string, pg: string, source: Expression): SqlFunctionExpression {
        return this.isPostgres
            ? this.sqlFunction(LiteralType.number, "EXTRACT", new SqlLiteralExpression(pg), source)
            : this.sqlFunction(LiteralType.number, "DATEPART", new SqlLiteralExpression(ss), source);
    }

    // The receiver type name a method's `<type>.<method>` key is qualified with
    // (Signum's `DeclaringType.TypeName()`). A null (unresolved) receiver type is
    // treated as string. `Math` is recognised by its captured constant value; a
    // temporal receiver by its TemporalType.
    private receiverNamespace(source: Expression): string | undefined {
        if (source instanceof ConstantExpression && source.value === Math)
            return "Math";
        if (source.type instanceof TemporalType)
            return source.type.kind;
        if (source.type === LiteralType.string || source.type === LiteralType.null)
            return "string";
        return undefined;
    }

    private sqlFunction(type: Type, fn: string, ...args: Expression[]): SqlFunctionExpression {
        return new SqlFunctionExpression(type, undefined, fn, args);
    }

    private likePattern(prefix: string, expression: Expression, suffix: string): Expression {
        if (expression instanceof ConstantExpression && typeof expression.value === "string")
            return new ConstantExpression(`${prefix}${expression.value}${suffix}`);
        throw new Error("Non-constant LIKE patterns are not implemented yet");
    }

    // `str.indexOf(value[, startIndex])` → 0-based position. SQL search functions are
    // 1-based, so subtract 1. SQL Server CHARINDEX(needle, haystack[, start]); Postgres
    // strpos(haystack, needle) (no start-index overload — Signum throws there too).
    private translateIndexOf(source: Expression, args: readonly Expression[]): Expression {
        const value = args[0];
        let charIndex: SqlFunctionExpression;
        if (this.isPostgres) {
            if (args.length > 1)
                throw new Error("string.indexOf with a startIndex is not supported on Postgres");
            charIndex = this.sqlFunction(LiteralType.number, "strpos", source, value);
        } else {
            charIndex = args.length > 1
                ? this.sqlFunction(LiteralType.number, "CHARINDEX", value, source, this.plusOne(args[1]))
                : this.sqlFunction(LiteralType.number, "CHARINDEX", value, source);
        }
        return new BinaryExpression("-", charIndex, new SqlConstantExpression(1, LiteralType.number));
    }

    // `str.substring(start[, end])` → SUBSTRING(str, start+1, end-start) / substr(…).
    // The JS↔C# impedance: JS takes an end index, C# a length, so we compute
    // `end - start`. Without an end, SQL Server needs an explicit large length;
    // Postgres' substr omits it. Numeric offsets become inline SqlConstants so the
    // arithmetic doesn't produce two bare params (Postgres `unknown <op> unknown`).
    private translateSubstring(source: Expression, args: readonly Expression[]): Expression {
        const arg0 = this.asSqlLiteral(args[0]);
        const start = this.plusOne(arg0);
        const length = args.length > 1
            ? new BinaryExpression("-", this.asSqlLiteral(args[1]), arg0)
            : undefined;
        if (this.isPostgres)
            return length == null
                ? this.sqlFunction(LiteralType.string, "substr", source, start)
                : this.sqlFunction(LiteralType.string, "substr", source, start, length);
        return this.sqlFunction(LiteralType.string, "SUBSTRING", source, start,
            length ?? new SqlConstantExpression(2147483647, LiteralType.number));
    }

    private plusOne(e: Expression): Expression {
        return new BinaryExpression("+", e, new SqlConstantExpression(1, LiteralType.number));
    }

    // A captured numeric literal becomes an inline SqlConstant so arithmetic over it
    // doesn't produce two bare parameters (Postgres rejects `unknown <op> unknown`).
    private asSqlLiteral(e: Expression): Expression {
        return e instanceof ConstantExpression && typeof e.value === "number"
            ? new SqlConstantExpression(e.value, LiteralType.number)
            : e;
    }

    // ---- self-contained subqueries: candidate as a whole, no recursion ---
    // (their inner columns belong to the subquery's own scope, not this one).

    override visitScalar(node: ScalarExpression): Expression {
        return this.add(node);
    }

    override visitExists(node: ExistsExpression): Expression {
        return this.add(node);
    }

    // A value-IN (`x IN (1,2,…)`) must translate its LHS — it may be a residual
    // date-part / method node the binder left for us. A subquery-IN keeps its select
    // opaque (its own scope), like the other subquery nodes.
    override visitIn(node: InExpression): Expression {
        if (node.select == null) {
            const expr = this.visit(node.expression);
            return this.add(expr === node.expression ? node : InExpression.fromValues(expr, node.values!));
        }
        return this.add(node);
    }

    // ---- non-server nodes: never recursed, never nominated ---------------
    // A child projection has its own scope; parameters/properties/lambdas are
    // residual source nodes the reader handles, not server expressions.

    override visitProjection(node: ProjectionExpression): Expression {
        return node;
    }

    override visitParameter(node: ParameterExpression): Expression {
        return node;
    }

    // Date/time part access on a temporal column (`creationTime.year`, `.dayOfWeek`, …)
    // → DATEPART / EXTRACT. Signum handles date MemberExpressions in the nominator;
    // the binder leaves them as residual PropertyExpressions for us to lower. Any other
    // residual property (e.g. on a captured constant) passes through untranslated.
    override visitProperty(node: PropertyExpression): Expression {
        const obj = this.visit(node.object);
        if (obj.type instanceof TemporalType) {
            const translated = this.dateMemberPart(node.propertyName, obj);
            if (translated != null)
                return this.visit(translated);
            throw new Error(`The date member '${node.propertyName}' cannot be translated to SQL`);
        }
        return node;
    }

    // The datepart keyword per dialect for a JS date property (SQL Server name,
    // Postgres name). SQL Server: DATEPART(<kw>, x); Postgres: EXTRACT(<kw> from x).
    private static readonly dateParts: Record<string, readonly [string, string]> = {
        year: ["year", "year"],
        month: ["month", "month"],
        day: ["day", "day"],
        hour: ["hour", "hour"],
        minute: ["minute", "minute"],
        second: ["second", "second"],
        millisecond: ["millisecond", "milliseconds"],
        dayOfYear: ["dayofyear", "doy"],
        // altea's dayOfWeek is Temporal-ISO (Mon=1..Sun=7). SQL Server DATEPART(weekday)
        // already yields that (DATEFIRST=1); Postgres `dow` is .NET-style (Sun=0..Sat=6),
        // so use `isodow` (Mon=1..Sun=7) to match the in-memory Temporal value.
        dayOfWeek: ["weekday", "isodow"],
        // Temporal.Duration component members are plural.
        hours: ["hour", "hour"],
        minutes: ["minute", "minute"],
        seconds: ["second", "second"],
        milliseconds: ["millisecond", "milliseconds"],
    };

    private dateMemberPart(name: string, source: Expression): Expression | undefined {
        switch (name) {
            // `.date` truncates to the date (Signum's TrySqlDate); `.timeOfDay` keeps
            // only the time (TrySqlTime) — both a CAST in altea's modern dialects.
            case "date": return this.castTemporal("date", source, "date", "date");
            case "timeOfDay": return this.castTemporal("duration", source, "time", "time");
            // DateOnly.DayNumber: whole days since a fixed epoch.
            case "dayNumber":
                return this.isPostgres
                    ? new BinaryExpression("-", source, new SqlLiteralExpression("DATE '0001-01-01'"))
                    : this.sqlFunction(LiteralType.number, "DATEDIFF", new SqlLiteralExpression("day"), new SqlLiteralExpression("'0001-01-01'"), source);
        }
        const parts = DbExpressionNominator.dateParts[name];
        return parts == null ? undefined : this.datePartFn(parts[0], parts[1], source);
    }

    override visitLambda(node: LambdaExpression): Expression {
        return node;
    }
}

export function nominate(expr: Expression, isPostgres: boolean): { candidates: Set<Expression>; expression: Expression } {
    return DbExpressionNominator.nominate(expr, isPostgres);
}

export function fullNominate(expr: Expression, isPostgres: boolean): Expression {
    return DbExpressionNominator.translate(expr, isPostgres);
}
