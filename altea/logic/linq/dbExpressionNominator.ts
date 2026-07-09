import {
    Expression, BinaryExpression, UnaryExpression, ConditionalExpression,
    ConstantExpression, CastExpression, CallExpression, PropertyExpression,
    ParameterExpression, LambdaExpression, ObjectExpression,
} from "./expressions";
import { inSql, Temporal } from "../../entities/basics";
import {
    ColumnExpression, SqlConstantExpression, SqlLiteralExpression, PrimaryKeyExpression,
    IsNullExpression, IsNotNullExpression, LikeExpression, SqlFunctionExpression, SqlCastExpression,
    AggregateExpression, AggregateRequestsExpression, CaseExpression, When, ScalarExpression, ExistsExpression, InExpression,
    ProjectionExpression, ToDayOfWeekExpression, SqlArrayIndexExpression,
} from "./expressions.sql";
import { EnumType, LiteralType, TemporalType, Type } from "../../entities/types";
import { enumEntityMembers } from "../../entities/enumEntity";
import { DbExpressionVisitor } from "./visitors/DbExpressionVisitor";

// A since() difference marker — a SqlFunctionExpression carrying (start, end) until
// duration.total(unit) turns it into a real DATEDIFF. Never reaches the formatter.
const TIMESPAN_MARKER = "__timespan__";

// Binary operators that a projection leaves for CLIENT-SIDE evaluation (the reader combines
// the selected leaf columns) rather than nominating to a SQL column: arithmetic, comparison
// and string concatenation (`+`). Logical (`&&`/`||`), coalesce (`??`) and bitwise stay in
// SQL. Only applies outside a full-translate / inside-CASE context; `InSql()` overrides it.
const CLIENT_PROJECTOR_OPS = new Set<string>([
    "+", "-", "*", "/", "%",
    "<", "<=", ">", ">=", "==", "!=", "===", "!==",
]);

// The captured Temporal class → the kind its `from({…})` constructs. A date/time literal
// (`Temporal.PlainDate.from({ year, month, day })`, the altea analog of Signum's
// `new DateTime(…)`) is translated to a SQL date-part constructor here, mirroring Signum's
// DbExpressionNominator.VisitNew.
type TemporalKind = "dateTime" | "date" | "time" | "duration";
const TEMPORAL_CTOR_KINDS: ReadonlyMap<unknown, TemporalKind> = new Map<unknown, TemporalKind>([
    [Temporal.PlainDateTime, "dateTime"],
    [Temporal.PlainDate, "date"],
    [Temporal.PlainTime, "time"],
    [Temporal.Duration, "duration"],
]);

// A type the reader can operate on with a plain JS operator (`+`, `<`, …). Arithmetic /
// comparison over these can move client-side; other types must stay in SQL — a
// Temporal (date/time) throws on JS `-`/`<` (`valueOf`), and Decimal/entity/etc. don't
// compare with native operators either. Enums materialise as their numeric value.
function isClientScalar(t: Type | undefined): boolean {
    return t === LiteralType.number || t === LiteralType.string || t === LiteralType.boolean
        || t instanceof EnumType;
}

// Temporal unit → SQL DATEADD/DATEDIFF part + seconds-per-unit (for the Postgres EPOCH divisor
// in duration.total). Keyed by Temporal.Duration's plural field names.
const DIFF_UNITS: Record<string, { ss: string; seconds: number }> = {
    years: { ss: "year", seconds: 31557600 },
    months: { ss: "month", seconds: 2629800 },
    weeks: { ss: "week", seconds: 604800 },
    days: { ss: "day", seconds: 86400 },
    hours: { ss: "hour", seconds: 3600 },
    minutes: { ss: "minute", seconds: 60 },
    seconds: { ss: "second", seconds: 1 },
    milliseconds: { ss: "millisecond", seconds: 0.001 },
};

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

    // `fullTranslate` = the FullNominate path (WHERE / ORDER BY / predicate), where the whole
    // expression must live in SQL. There a day-of-week VALUE compared in a predicate has its
    // ISO conversion folded into server SQL (coerceDayOfWeek). In the plain `nominate` path (a
    // projector) the comparison stays client-side over the raw column, so the conversion never
    // contaminates the SELECT.
    // > 0 while visiting the children of a SQL-mandatory node (a CASE, function, cast, LIKE,
    // aggregate, array index): a composite (arithmetic / comparison / conditional / concat)
    // found there is kept in SQL — its parent must nominate as one self-contained server
    // expression, never split into client-side pieces the reader can't recombine into e.g. a
    // `FLOOR(year + 0.5)`. Generalises Signum's insideCase to every enclosing SQL node.
    private mustNominateDepth = 0;

    // Visit under a "must nominate" scope, so composites in the built subtree stay server-side.
    private nominateChildren<T>(build: () => T): T {
        this.mustNominateDepth++;
        try { return build(); }
        finally { this.mustNominateDepth--; }
    }

    // `aggressive` = Signum's group-key / distinct nomination: like fullTranslate it forces
    // composite operators (arithmetic / comparison / conditional / concat) into SQL, so a
    // DISTINCT or GROUP BY key dedupes/groups on the COMPUTED value rather than its raw leaf
    // columns. It differs from fullTranslate only in intent (a projected key, not a predicate).
    constructor(private readonly isPostgres: boolean, private readonly fullTranslate: boolean = false, private readonly aggressive: boolean = false) {
        super();
    }

    // Signum's DbExpressionNominator.IsFullNominateOrAggresive: the projection carve-outs
    // (lazy client-side arithmetic / comparison / conditional / concat) apply only when this
    // is false — i.e. a plain projection. A predicate (fullTranslate) or a group key / distinct
    // (aggressive) keeps everything in SQL.
    private get isFullNominateOrAggresive(): boolean {
        return this.fullTranslate || this.aggressive;
    }

    // Translate + nominate: returns the rewritten tree and the candidate set (the
    // server-evaluable subtrees of it). Mirrors C#'s `Nominate(e, out newExpression)`.
    // `aggressive` forces full nomination for a group key / distinct projector.
    static nominate(expr: Expression, isPostgres: boolean, aggressive = false): { candidates: Set<Expression>; expression: Expression } {
        const n = new DbExpressionNominator(isPostgres, /* fullTranslate */ false, aggressive);
        const expression = n.visit(expr);
        return { candidates: n.candidates, expression };
    }

    // Translate only (no candidate set needed) — for WHERE / ORDER BY / aggregate
    // arguments, where the rewritten predicate/key is what we want. Mirrors C#'s
    // `FullNominate`, minus the "throws if anything is left untranslated" assertion.
    static translate(expr: Expression, isPostgres: boolean): Expression {
        return new DbExpressionNominator(isPostgres, /* fullTranslate */ true).visit(expr);
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
        if (this.leaveNullInline(sqlConstant.value))
            return sqlConstant;
        return this.add(sqlConstant);
    }

    override visitSqlLiteral(sqlLiteral: SqlLiteralExpression): Expression {
        return this.add(sqlLiteral);
    }

    override visitConstant(constant: ConstantExpression): Expression {
        if (this.leaveNullInline(constant.value))
            return constant;
        return this.add(constant);
    }

    // A bare NULL selected as its own column is typed `text` by Postgres, which then clashes
    // in a downstream CASE (`CASE … THEN <that null column> ELSE <int> END`). In a plain
    // projection leave a NULL constant UN-nominated so it stays inline for the reader — and so
    // an aggressive re-nomination (a DISTINCT / GROUP BY key over the value) renders it inline
    // in the CASE, where the DBMS infers its type from the other branch. Non-null constants and
    // full-translate / group-key contexts still nominate normally.
    private leaveNullInline(value: unknown): boolean {
        return value == null && !this.isFullNominateOrAggresive && this.mustNominateDepth === 0;
    }

    // The id wrapper recurses to its column (rebuilding if it changed) but is not
    // itself a column candidate.
    override visitPrimaryKey(pk: PrimaryKeyExpression): Expression {
        return super.visitPrimaryKey(pk);
    }

    // ---- composite SQL nodes: candidate iff every operand is -------------

    override visitIsNull(node: IsNullExpression): Expression {
        const r = this.nominateChildren(() => super.visitIsNull(node) as IsNullExpression);
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitIsNotNull(node: IsNotNullExpression): Expression {
        const r = this.nominateChildren(() => super.visitIsNotNull(node) as IsNotNullExpression);
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitLike(node: LikeExpression): Expression {
        const r = this.nominateChildren(() => super.visitLike(node) as LikeExpression);
        return this.nominateIfAll(r, [r.expression, r.pattern]);
    }

    override visitSqlFunction(node: SqlFunctionExpression): Expression {
        const r = this.nominateChildren(() => super.visitSqlFunction(node) as SqlFunctionExpression);
        return this.nominateIfAll(r, [r.object, ...r.arguments]);
    }

    override visitArrayIndex(node: SqlArrayIndexExpression): Expression {
        const r = this.nominateChildren(() => super.visitArrayIndex(node) as SqlArrayIndexExpression);
        return this.nominateIfAll(r, [r.array, r.index]);
    }

    override visitSqlCast(node: SqlCastExpression): Expression {
        const r = this.nominateChildren(() => super.visitSqlCast(node) as SqlCastExpression);
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitAggregate(node: AggregateExpression): Expression {
        const r = this.nominateChildren(() => super.visitAggregate(node) as AggregateExpression);
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
        // Visit the branches under nominateChildren so a composite among them stays in SQL
        // (see visitBinary): a CASE must translate as one self-contained server column, never
        // split into client-side pieces that would leave a CASE in the projector.
        const r = this.nominateChildren(() => super.visitCase(node) as CaseExpression);
        return this.nominateIfAll(r, [...r.whens.flatMap(w => [w.condition, w.value]), r.defaultValue]);
    }

    override visitUnary(node: UnaryExpression): Expression {
        const r = super.visitUnary(node) as UnaryExpression;
        if (!this.isFullNominateOrAggresive && this.mustNominateDepth === 0 && isClientScalar(r.expression.type))
            return r;
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitCast(node: CastExpression): Expression {
        const r = super.visitCast(node) as CastExpression;
        return this.nominateIfAll(r, [r.expression]);
    }

    override visitBinary(node: BinaryExpression): Expression {
        let r = super.visitBinary(node) as BinaryExpression;
        // A day-of-week operand compared in SQL folds its ISO conversion inline here.
        const left = this.coerceDayOfWeek(r.left);
        const right = this.coerceDayOfWeek(r.right);
        if (left !== r.left || right !== r.right)
            r = new BinaryExpression(r.kind, left, right);
        // Lazy projector (Signum's DbExpressionNominator): in a projection — not a
        // full-translate context (WHERE / ORDER BY / aggregate) and not inside a nominated
        // CASE — user arithmetic, comparison and string concatenation are left UN-nominated
        // so the ColumnProjector selects only their leaf columns and the reader combines
        // them client-side, relieving the DBMS. `inSql()` forces the subtree back into SQL
        // (see visitCall). Logical/coalesce/bitwise stay nominated (SQL three-valued logic /
        // COALESCE). A concat inside a CASE stays SQL so the whole CASE is one server column.
        if (!this.isFullNominateOrAggresive && this.mustNominateDepth === 0
            && CLIENT_PROJECTOR_OPS.has(r.kind) && isClientScalar(r.left.type) && isClientScalar(r.right.type))
            return r;
        return this.nominateIfAll(r, [r.left, r.right]);
    }

    override visitConditional(node: ConditionalExpression): Expression {
        const r = super.visitConditional(node) as ConditionalExpression;
        // A projected conditional is evaluated client-side (a JS ternary in the reader);
        // only a full-translate / group-key / inside-CASE conditional becomes a SQL CASE.
        if (!this.isFullNominateOrAggresive && this.mustNominateDepth === 0)
            return r;
        return this.nominateIfAll(r, [r.condition, r.whenTrue, r.whenFalse]);
    }

    // ---- method-call translation (HardCodedMethods) ----------------------
    // The binder leaves recognised SQL functions as a residual CallExpression with
    // a bound receiver (`CallExpression(PropertyExpression(<column>, name), args)`).
    // Here we visit the receiver/args (translating + nominating them) and lower the
    // call to its SQL form, then nominate the lowered server expression.

    override visitCall(node: CallExpression): Expression {
        // inSql(x) (Signum's LinqHints.InSql, handled in its DbExpressionNominator.VisitMethodCall):
        // visit the argument fully in SQL and nominate it as one server expression, then strip
        // the call — forcing the subtree into SQL and defeating the lazy projector. In a
        // full-translate context it is a no-op beyond stripping.
        if (node.func instanceof ConstantExpression && node.func.value === inSql)
            return this.add(this.nominateChildren(() => this.visit(node.args[0])));
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

    // The temporal kind a receiver's `from(...)` constructs, when the receiver is a captured
    // Temporal class — `Temporal.PlainDate` (a PropertyExpression off the captured Temporal
    // namespace) or the class captured directly. Otherwise undefined.
    private temporalCtorKind(source: Expression): TemporalKind | undefined {
        let ctor: unknown;
        if (source instanceof ConstantExpression)
            ctor = source.value;
        else if (source instanceof PropertyExpression && source.object instanceof ConstantExpression && source.object.value != null)
            ctor = (source.object.value as Record<string, unknown>)[source.propertyName];
        return ctor == null ? undefined : TEMPORAL_CTOR_KINDS.get(ctor);
    }

    // Translate a `Temporal.*.from({ … })` construction with a NON-constant component to a SQL
    // date-part constructor — MAKE_DATE / MAKE_TIMESTAMP / MAKE_TIME / MAKE_INTERVAL on Postgres,
    // DATEFROMPARTS / DATETIMEFROMPARTS / TIMEFROMPARTS on SQL Server (Signum's VisitNew per
    // DateTime / DateOnly / TimeOnly / TimeSpan). An all-constant construction never reaches here —
    // it folds to a date value; only a non-constant one (e.g. a column component) survives.
    private temporalConstructor(kind: TemporalKind, arg: Expression): Expression {
        if (!(arg instanceof ObjectExpression))
            throw new Error("A date/time constructor (Temporal.*.from(...)) requires an object literal argument");
        const props = arg.properties;
        const kindType = new TemporalType(kind === "date" ? "date" : kind === "dateTime" ? "dateTime" : "duration");
        const lit = (v: number) => new SqlConstantExpression(v, LiteralType.number);
        const numOf = (e: Expression | undefined): number | undefined =>
            (e instanceof ConstantExpression || e instanceof SqlConstantExpression) && typeof e.value === "number" ? e.value : undefined;
        // Each integer component: a constant → an inline literal; a non-constant (a column, e.g.
        // `EXTRACT(year …)`) → cast to integer on Postgres, where MAKE_* wants int (SQL Server's
        // DATEPART already yields int). Missing → 0.
        const comp = (name: string): Expression => {
            const e = props[name];
            if (e == null) return lit(0);
            const v = numOf(e);
            if (v != null) return lit(v);
            return this.isPostgres ? new SqlCastExpression(LiteralType.number, e, "integer") : e;
        };
        // Postgres MAKE_TIMESTAMP/MAKE_TIME take fractional (double) seconds: fold second + ms/1000
        // when both are constant (the usual case); a non-constant second passes through as-is.
        const pgSeconds = (secName: string, msName: string): Expression => {
            const s = numOf(props[secName]), ms = numOf(props[msName]);
            return s != null && ms != null ? lit(s + ms / 1000) : (props[secName] ?? lit(0));
        };
        const fn = (name: string, args: Expression[]) => new SqlFunctionExpression(kindType, undefined, name, args);

        switch (kind) {
            case "date":
                return this.isPostgres ? fn("MAKE_DATE", [comp("year"), comp("month"), comp("day")])
                    : fn("DATEFROMPARTS", [comp("year"), comp("month"), comp("day")]);
            case "dateTime":
                // SQL Server's DATETIMEFROMPARTS takes a separate integer milliseconds argument.
                return this.isPostgres
                    ? fn("MAKE_TIMESTAMP", [comp("year"), comp("month"), comp("day"), comp("hour"), comp("minute"), pgSeconds("second", "millisecond")])
                    : fn("DATETIMEFROMPARTS", [comp("year"), comp("month"), comp("day"), comp("hour"), comp("minute"), comp("second"), comp("millisecond")]);
            case "time":
                // TIMEFROMPARTS's scale (last arg) must be a literal, not a parameter.
                return this.isPostgres
                    ? fn("MAKE_TIME", [comp("hour"), comp("minute"), pgSeconds("second", "millisecond")])
                    : fn("TIMEFROMPARTS", [comp("hour"), comp("minute"), comp("second"), comp("millisecond"), lit(3)]);
            case "duration":
                // A TimeSpan/Duration up to a day maps to a SQL interval / time value.
                return this.isPostgres
                    ? fn("MAKE_INTERVAL", [lit(0), lit(0), lit(0), lit(0), comp("hours"), comp("minutes"), pgSeconds("seconds", "milliseconds")])
                    : fn("TIMEFROMPARTS", [comp("hours"), comp("minutes"), comp("seconds"), comp("milliseconds"), lit(3)]);
        }
    }

    // Port of DbExpressionNominator.HardCodedMethods. Cases are keyed
    // "<receiverType>.<method>" — Signum switches on `DeclaringType.TypeName() + "." +
    // MethodName` ("string.IndexOf"), so a method only matches on the right receiver
    // type (a number's `.toString()` won't hit `string.*`). The JS method names/
    // semantics differ from C# (substring takes an end index not a length; indexOf is
    // 0-based) but the emitted SQL is the same. Returns undefined for an unrecognised
    // receiver/method/arity (visitCall then throws).
    private hardCodedMethod(name: string, source: Expression, args: readonly Expression[]): Expression | undefined {
        // Date/time literal `Temporal.PlainDate.from({ … })` (Signum's `new DateTime(…)`,
        // handled in DbExpressionNominator.VisitNew) → a SQL date-part constructor.
        if (name === "from") {
            const kind = this.temporalCtorKind(source);
            if (kind != null)
                return this.temporalConstructor(kind, args[0]);
        }
        const ns = this.receiverNamespace(source);
        if (ns === "Math")
            return this.translateMath(name, args);
        if (ns === "dateTime" || ns === "date")
            return this.translateDateMethod(name, source, args);
        if (ns === "duration")
            return this.translateDurationMethod(name, source, args);
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
            // StringExtensions.Etc(max[, etcString]): truncate to `max` chars, appending
            // `etcString` (default "(…)") when longer — `str.Length > max ? str.Start(max -
            // etcString.Length) + etcString : str`. Lowered to a CASE so the concat stays
            // server-side; Start → LEFT/left, Length → LEN/length.
            case "string.etc": {
                if (args.length < 1 || args.length > 2)
                    return undefined;
                // Signum's TryEtc: Etc truncates a value for display (a SELECT), but under
                // IsFullNominateOrAggresive (a WHERE / predicate / order-by / group key) it is a
                // NO-OP so the expression matches the FULL string — a column can show truncated
                // text yet a filter/group over `Etc(n)` still uses the whole value.
                if (this.isFullNominateOrAggresive)
                    return source;
                const len = (e: Expression) => this.sqlFunction(LiteralType.number, this.isPostgres ? "length" : "LEN", e);
                const max = this.asSqlLiteral(args[0]);
                const etc = args.length === 2 ? args[1] : new SqlConstantExpression("(…)", LiteralType.string);
                const truncated = new BinaryExpression("+",
                    this.sqlFunction(LiteralType.string, this.isPostgres ? "left" : "LEFT",
                        source, new BinaryExpression("-", max, len(etc))),
                    etc);
                return new CaseExpression([new When(new BinaryExpression(">", len(source), max), truncated)], source);
            }
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
            // Temporal.add(duration) → DATEADD (SQL Server) / date + interval (Postgres).
            case "add": return args.length === 1 ? this.dateAdd(source, args[0]) : undefined;
            // Temporal.since(other) → a lazy difference marker consumed by duration.total(unit).
            case "since": return args.length === 1 ? this.timeSpanMarker(args[0], source) : undefined;
            default: return undefined;
        }
    }

    // Duration methods. `total(unit)` turns a since() difference into a number of `unit`s:
    // DATEDIFF(part, start, end) on SQL Server; EXTRACT(EPOCH …)/divisor on Postgres.
    private translateDurationMethod(name: string, source: Expression, args: readonly Expression[]): Expression | undefined {
        if (name !== "total" || args.length !== 1)
            return undefined;
        if (!(source instanceof SqlFunctionExpression) || source.sqlFunction !== TIMESPAN_MARKER)
            return undefined; // only a since() difference is supported (not a stored duration)
        const [start, end] = source.arguments;
        const unit = args[0] instanceof ConstantExpression ? String((args[0] as ConstantExpression).value) : undefined;
        const part = unit != null ? DIFF_UNITS[unit] : undefined;
        if (part == null)
            return undefined;
        if (!this.isPostgres)
            return this.sqlFunction(LiteralType.number, "DATEDIFF", new SqlLiteralExpression(part.ss), start, end);
        // Postgres: seconds between the two, divided into the requested unit.
        const epoch = this.sqlFunction(LiteralType.number, "EXTRACT", new SqlLiteralExpression("EPOCH"), new BinaryExpression("-", end, start));
        return new BinaryExpression("/", epoch, new SqlConstantExpression(part.seconds, LiteralType.number));
    }

    // Temporal.add({ days, hours, … }) → chained DATEADD (SQL Server) / `+ N * interval '1 unit'`
    // (Postgres). The argument is a constant Duration-like object.
    private dateAdd(source: Expression, arg: Expression): Expression | undefined {
        if (!(arg instanceof ConstantExpression) || arg.value == null || typeof arg.value !== "object")
            return undefined;
        const isDate = source.type instanceof TemporalType && source.type.kind === "date";
        const pgType = isDate ? "date" : "timestamp";
        let acc = source;
        for (const [unit, amount] of Object.entries(arg.value as Record<string, number>)) {
            const part = DIFF_UNITS[unit];
            if (part == null || typeof amount !== "number")
                return undefined;
            const amt = new SqlConstantExpression(amount, LiteralType.number);
            if (this.isPostgres) {
                // Cast the (date + interval) back to the source temporal type so a following
                // .since() still sees a date/timestamp.
                const interval = new BinaryExpression("*", amt, new SqlLiteralExpression(`INTERVAL '1 ${part.ss}'`));
                acc = new SqlCastExpression(source.type, new BinaryExpression("+", acc, interval), pgType);
            } else {
                acc = this.sqlFunction(source.type, "DATEADD", new SqlLiteralExpression(part.ss), amt, acc);
            }
        }
        return acc;
    }

    // The since() difference marker: a SqlFunctionExpression that merely carries (start, end)
    // until duration.total(unit) turns it into a real DATEDIFF. Never formatted directly.
    private timeSpanMarker(start: Expression, end: Expression): Expression {
        return new SqlFunctionExpression(new TemporalType("duration"), undefined, TIMESPAN_MARKER, [start, end]);
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
            const expr = this.coerceDayOfWeek(this.visit(node.expression));
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
        // dayOfWeek is handled specially (dayOfWeekIso) — it needs a DATEFIRST-independent
        // normalisation on SQL Server, not a plain DATEPART.
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
            // dayOfWeek is Temporal-ISO (Mon=1..Sun=7); normalised per dialect (see below).
            case "dayOfWeek": return this.dayOfWeekIso(source);
        }
        const parts = DbExpressionNominator.dateParts[name];
        return parts == null ? undefined : this.datePartFn(parts[0], parts[1], source);
    }

    // The ISO day-of-week (Mon=1..Sun=7), matching the in-memory `Temporal.dayOfWeek`.
    // Postgres `EXTRACT(isodow …)` yields it directly. SQL Server `DATEPART(weekday …)`
    // depends on the session's `SET DATEFIRST`, so normalise it to ISO independently of
    // that setting: ((DATEPART(weekday, x) + @@DATEFIRST + 5) % 7) + 1. (Signum instead
    // reads the raw weekday and converts in the projector via @@DATEFIRST; altea folds the
    // conversion into SQL so the DB value already equals the Temporal one.)
    private dayOfWeekIso(source: Expression): Expression {
        if (this.isPostgres)
            // `isodow` is already ISO (Mon=1..Sun=7) — a single clean expression, no
            // conversion to delay.
            return this.sqlFunction(LiteralType.number, "EXTRACT", new SqlLiteralExpression("isodow"), source);
        // SQL Server: DATEPART(weekday) is DATEFIRST-dependent. Wrap the RAW weekday in a
        // ToDayOfWeek marker so the ISO conversion is delayed to the projector (Signum's
        // ToDayOfWeekExpression) and doesn't contaminate the SELECT/GROUP BY. In a WHERE the
        // marker is folded to server SQL instead (visitToDayOfWeek / fullTranslate).
        return new ToDayOfWeekExpression(this.sqlFunction(LiteralType.number, "DATEPART", new SqlLiteralExpression("weekday"), source));
    }

    // The server-side ISO normalisation of a raw SQL Server weekday, used only where the
    // value must live in SQL (a WHERE/predicate): ((weekday + @@DATEFIRST + 5) % 7) + 1.
    private ssWeekdayToIsoSql(weekday: Expression): Expression {
        const shifted = new BinaryExpression("+",
            new BinaryExpression("+", weekday, new SqlLiteralExpression("@@DATEFIRST", LiteralType.number)),
            new SqlConstantExpression(5, LiteralType.number));
        const mod = new BinaryExpression("%", shifted, new SqlConstantExpression(7, LiteralType.number));
        return new BinaryExpression("+", mod, new SqlConstantExpression(1, LiteralType.number));
    }

    // A raw weekday wrapped for delayed ISO conversion. Always left in place, nominating only
    // the raw inner: a projector compiles the ISO conversion (TranslatorBuilder), a comparison
    // folds it into server SQL (coerceDayOfWeek, below), and a bare ORDER BY key renders as
    // the raw inner (the formatter) — ordering by the raw weekday, exactly like Signum.
    override visitToDayOfWeek(node: ToDayOfWeekExpression): Expression {
        const inner = this.visit(node.expression);
        return inner === node.expression ? node : new ToDayOfWeekExpression(inner);
    }

    // Under IsFullNominateOrAggresive (a predicate / order-by / group key) a day-of-week VALUE
    // compared in SQL must have its ISO conversion evaluated server-side (Signum's
    // ExtractDayOfWeek). In a plain projector the comparison is left client-side (the projector
    // converts the raw column). A bare ToDayOfWeek key in ORDER BY is never a binary operand,
    // so it renders as the raw weekday.
    private coerceDayOfWeek(e: Expression): Expression {
        return this.isFullNominateOrAggresive && e instanceof ToDayOfWeekExpression
            ? this.visit(this.ssWeekdayToIsoSql(e.expression))
            : e;
    }

    override visitLambda(node: LambdaExpression): Expression {
        return node;
    }
}

export function nominate(expr: Expression, isPostgres: boolean, aggressive = false): { candidates: Set<Expression>; expression: Expression } {
    return DbExpressionNominator.nominate(expr, isPostgres, aggressive);
}

export function fullNominate(expr: Expression, isPostgres: boolean): Expression {
    return DbExpressionNominator.translate(expr, isPostgres);
}
