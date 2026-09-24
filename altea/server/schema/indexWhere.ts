import type { Quoted } from "quote-transformer/quoted";
import {
    Expression, LambdaExpression, BinaryExpression, UnaryExpression,
    PropertyExpression, ConstantExpression, CastExpression,
} from "../linq/expressions";
import { ClassType } from "../runtimeTypes";
import type { Table } from "./table";
import type { IColumn } from "./column";
import { Field, FieldEmbedded, FieldImplementedBy, FieldImplementedByAll } from "./field";
import { IsNullable } from "./dbType";
import { sqlEscape } from "../linq/sqlEscape";

// Port of Signum's Engine/Schema/TableIndexes.cs IndexWhereExpressionVisitor. Renders a
// filtered-index predicate LAMBDA to an SQL WHERE string in two steps, mirroring Signum:
//   1. Quoted → Expression: LambdaExpression.fromQuotedLambda (the same machinery the query
//      pipeline uses) turns the captured lambda into an altea Expression tree.
//   2. Expression → string: this visitor walks that tree — exactly as Signum walks its
//      LambdaExpression — resolving each member to a column and emitting SQL.
//
// Scope (altea's flat index model): comparisons/equality (→ `col = <literal>`, or IS [NOT]
// NULL against null, with the string `<> ''` companion), a bare boolean member (→ `col = <true>`),
// unary NOT, and/or, and arithmetic. The `is` type-check and SystemPeriod cases Signum also
// handles are not modelled; a nested member path walks EMBEDDED steps only (see fieldPath).
export function getIndexWhere(where: Quoted<(element: any) => boolean>, table: Table, isPostgres: boolean): string {
    const lambda = LambdaExpression.fromQuotedLambda(where, [new ClassType(table.type)]);
    return new IndexWhereVisitor(table, isPostgres).visit(lambda.body);
}

// The dialect that a filtered-index predicate is rendered in. `legacyMode` only reaches the
// spelling of a boolean literal — see booleanLiteral.
export interface IndexWhereDialect {
    readonly isPostgres: boolean;
    readonly legacyMode: boolean;
}

/**
 * "This field HAS (or has no) value" as an SQL predicate — Signum's static
 * `IndexWhereExpressionVisitor.IsNull(field, equals, isPostgres)`. `undefined` means the test is a
 * TAUTOLOGY and so no predicate is needed at all (the column cannot be null), which is how a unique
 * index over a required field comes out unfiltered.
 *
 * This is the filter every `@unique` field carries (Signum's `Field.GenerateUniqueIndex` calls it
 * with `equals: false`), and getting it right is what lets several rows share a NULL — or an empty
 * string — in a unique column, as Signum's databases do.
 *
 * The result is NOT parenthesised, matching Signum, because that is what the index NAME's hash is
 * computed over. Safe for `equals: false`, where the parts join with AND; an `equals: true` result
 * ends in an OR and must be wrapped by the caller before it meets an AND (the visitor's own
 * `isNull` does its own wrapping — see the divergence noted there).
 */
export function indexWhereIsNull(field: Field, equals: boolean, dialect: IndexWhereDialect): string | undefined {
    // A polymorphic reference: one column per implementation, exactly one filled per row. So "has a
    // value" is the OR of the columns being non-null — and the inverse an AND, which is why Signum
    // joins on the negated operator.
    if (field instanceof FieldImplementedBy) {
        if (field.implementationColumns.length === 0)
            return equals ? "TRUE" : "FALSE";
        // A single non-nullable implementation is always present, so the test is a tautology.
        if (field.implementationColumns.length === 1 && field.implementationColumns[0].nullable === IsNullable.No)
            return undefined;
        return field.implementationColumns
            .map(c => plainNullTest(c, equals, dialect.isPostgres))
            .join(equals ? " AND " : " OR ");
    }

    // @implementedByAll: the DISCRIMINATOR alone answers the question — exactly one is written per
    // row, whichever id column the target's key type uses.
    //
    // DIVERGENCE: Signum formats the type COLUMN OBJECT here rather than its `.Name`, so its own
    // output is the column class's ToString. Nothing exercises it (it needs a NULLABLE
    // @implementedByAll under a field-level [UniqueIndex]; Southwind's one such index —
    // `uix_color_palette_specific_colors_entity_id_typ…` — has a NOT NULL discriminator and so comes
    // out unfiltered, which altea matches), so altea emits the obvious intent.
    if (field instanceof FieldImplementedByAll) {
        if (field.typeColumn.nullable === IsNullable.No)
            return undefined;
        return plainNullTest(field.typeColumn, equals, dialect.isPostgres);
    }

    // An embedded is flattened into this row, so its HasValue indicator is the test. A non-nullable
    // embedded has no indicator column and is always present.
    //
    // DIVERGENCE: Signum compares against `1` in both dialects, which Postgres rejects for a
    // boolean column — so there is no Signum output to be compatible with there, and altea uses the
    // dialect's own boolean literal.
    if (field instanceof FieldEmbedded) {
        if (field.hasValue == null)
            return undefined;
        const name = sqlEscape(field.hasValue.name, dialect.isPostgres);
        const literal = dialect.isPostgres ? booleanLiteral(true, dialect) : "1";
        return `${name} ${equals ? "<>" : "="} ${literal}`;
    }

    // Everything else is Signum's `field is IColumn` case — a value or single-target reference,
    // which in altea owns exactly one column.
    const columns = field.columns();
    if (columns.length === 1) {
        // A column that cannot be null makes the test a tautology, so there is NO predicate: this is
        // what keeps a unique index over a REQUIRED field unfiltered, and therefore named without a
        // WHERE-signature suffix (`uix_role_name`, not `uix_role_name__8ftnsgz`).
        if (columns[0].nullable === IsNullable.No)
            return undefined;
        return nullOrEmptyTest(columns[0], equals, dialect.isPostgres);
    }

    throw new Error(`Index where: cannot test '${field.constructor.name}' for null (${columns.length} columns).`);
}

// `col IS [NOT] NULL`, plus Signum's empty-string companion for a string column — where "no value"
// covers `''` as well as NULL.
function nullOrEmptyTest(col: IColumn, equals: boolean, isPostgres: boolean): string {
    const name = sqlEscape(col.name, isPostgres);
    const core = plainNullTest(col, equals, isPostgres);
    if (!col.dbType.isString())
        return core;
    return `${core} ${equals ? "OR" : "AND"} ${name} ${equals ? "=" : "<>"} ''`;
}

// Just `col IS [NOT] NULL` — what the polymorphic branches join, where the columns are foreign keys
// and Signum adds no empty-string companion and tests no column's own nullability.
function plainNullTest(col: IColumn, equals: boolean, isPostgres: boolean): string {
    return `${sqlEscape(col.name, isPostgres)} IS ${equals ? "" : "NOT "}NULL`;
}

// A Postgres boolean literal, and the one place where a predicate's TEXT — not just its meaning — is
// load-bearing: the rendered string is what the index NAME's hash suffix is computed over
// (SqlBuilder.whereSignature / Signum's TableIndex.WhereSignature), so two spellings of the same
// value produce two different index names.
//
// Signum reaches this through `SqlPreCommandSimple.LiteralValue`, which for a bool on Postgres is
// plain `b.ToString()` — .NET's "True"/"False". Postgres accepts either spelling and stores the
// predicate identically (`WHERE (is_default = true)` whichever went in), so this is naming, not
// semantics: exactly what legacyMode is for. Without it a Signum-generated
// `uix_holiday_calendar_is_default__q3ba1w0` and altea's `…__q0f7g6y` are the same index under two
// names, and every sync drops one to create the other.
function booleanLiteral(value: boolean, dialect: IndexWhereDialect): string {
    if (!dialect.isPostgres)
        return value ? "1" : "0";
    if (dialect.legacyMode)
        return value ? "True" : "False";
    return value ? "TRUE" : "FALSE";
}

class IndexWhereVisitor {
    constructor(private readonly table: Table, private readonly isPostgres: boolean) { }

    visit(e: Expression): string {
        if (e instanceof CastExpression)
            return this.visit(e.expression);
        // A bare boolean member (`e => e.active`): Signum's VisitMember → `col = <true>`.
        if (e instanceof PropertyExpression)
            return this.equalsField(this.getColumn(e), true, /* equals */ true);
        if (e instanceof UnaryExpression) {
            if (e.kind === "!") return " NOT " + this.visit(e.expression);
            if (e.kind === "-u") return " - " + this.visit(e.expression);
            if (e.kind === "+u") return " + " + this.visit(e.expression);
        }
        if (e instanceof BinaryExpression)
            return this.visitBinary(e);
        throw new Error(`Index where: unsupported expression '${e.toString()}'`);
    }

    // `x == null` / `x != null` → IS [NOT] NULL; `x == <value>` → `col = <literal>`. Mirrors
    // Signum's VisitBinary Equal/NotEqual: exactly one side must be a constant.
    private visitBinary(b: BinaryExpression): string {
        if (b.kind === "==" || b.kind === "===" || b.kind === "!=" || b.kind === "!==") {
            const equals = b.kind === "==" || b.kind === "===";
            const leftConst = b.left instanceof ConstantExpression;
            const rightConst = b.right instanceof ConstantExpression;
            if (leftConst && rightConst)
                throw new Error("Index where: NULL == NULL not supported");
            if (rightConst)
                return this.equalsField(this.getColumn(b.left), (b.right as ConstantExpression).value, equals);
            if (leftConst)
                return this.equalsField(this.getColumn(b.right), (b.left as ConstantExpression).value, equals);
            throw new Error("Index where: a comparison must have one constant side");
        }
        const sql = b.kind === "&&" ? " AND " : b.kind === "||" ? " OR " : ` ${b.kind} `;
        return `(${this.visit(b.left)}${sql}${this.visit(b.right)})`;
    }

    // Resolve a flat member access (`e.field`, or a Lite's `.entity`/`.entityOrNull` unwrapped)
    // to its physical column via the table's columns.
    private getColumn(e: Expression): IColumn {
        if (e instanceof CastExpression)
            return this.getColumn(e.expression);
        if (e instanceof PropertyExpression) {
            if (e.propertyName === "entity" || e.propertyName === "entityOrNull")
                return this.getColumn(e.object);
            const path = this.fieldPath(e);
            const cols = this.table.columnsFromFields([path]);
            if (cols.length !== 1)
                throw new Error(`Index where: field '${path}' maps to ${cols.length} columns (only single-column fields supported)`);
            return cols[0];
        }
        throw new Error(`Index where: unsupported field expression '${e.toString()}'`);
    }

    // `e.a.b` → "a.b": the dotted name columnsFromFields walks through EMBEDDED steps (a collection row's
    // `element.skillGroup`), so a filter reaches the same fields the index's own key can.
    private fieldPath(e: PropertyExpression): string {
        const steps: string[] = [e.propertyName];
        let obj = e.object;
        while (obj instanceof CastExpression)
            obj = obj.expression;
        while (obj instanceof PropertyExpression) {
            steps.unshift(obj.propertyName);
            obj = obj.object;
            while (obj instanceof CastExpression)
                obj = obj.expression;
        }
        return steps.join(".");
    }

    // Signum's Equals: value==null routes to IS NULL; otherwise `col = <literal>`.
    private equalsField(col: IColumn, value: unknown, equals: boolean): string {
        if (value == null)
            return this.isNull(col, equals);
        const name = sqlEscape(col.name, this.isPostgres);
        return `${name} ${equals ? "=" : "<>"} ${this.literal(value)}`;
    }

    // Signum's IsNull: `col IS [NOT] NULL`, plus the empty-string companion for string columns.
    // A non-nullable column makes the test a tautology (altea indexes rarely filter on those).
    //
    // DIVERGENCE: the string companion is PARENTHESISED here and is not in Signum, which concatenates
    // `col IS NULL` + " OR " + `col = ''` bare. In an `equals` (IS NULL) test that leaves the OR
    // loose inside a surrounding AND — `(a AND b IS NULL OR b = '')` binds as
    // `(a AND b IS NULL) OR b = ''`, which is not what the predicate says. Reproducing that would
    // also change the predicate text, and so the index name; it is left alone because no index in a
    // Signum-generated database reaches this path (a filtered index's `== null` test is rare, and
    // the null filters that DO appear come from multiUniqueIndexes / generateUniqueIndex, which
    // match Signum exactly). Revisit if a real predicate ever needs the two to agree.
    private isNull(col: IColumn, equals: boolean): string {
        const name = sqlEscape(col.name, this.isPostgres);
        if (col.nullable === "No")
            return equals ? "(1 = 0)" : "(1 = 1)";
        const core = `${name} IS ${equals ? "" : "NOT "}NULL`;
        if (!col.dbType.isString())
            return core;
        return `(${core} ${equals ? "OR" : "AND"} ${name} ${equals ? "=" : "<>"} '')`;
    }

    // Signum's SqlPreCommandSimple.LiteralValue.
    private literal(value: unknown): string {
        if (typeof value === "string")
            return `'${value.replace(/'/g, "''")}'`;
        if (typeof value === "boolean")
            return booleanLiteral(value, this.table);
        return String(value); // number
    }
}
