import type { Quoted } from "quote-transformer/quoted";
import {
    Expression, LambdaExpression, BinaryExpression, UnaryExpression,
    PropertyExpression, ConstantExpression, CastExpression,
} from "../linq/expressions";
import { ClassType } from "../../entities/runtimeTypes";
import type { Table } from "./table";
import type { IColumn } from "./column";
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
// handles, and nested member paths, are not modelled.
export function getIndexWhere(where: Quoted<(element: any) => boolean>, table: Table, isPostgres: boolean): string {
    const lambda = LambdaExpression.fromQuotedLambda(where, [new ClassType(table.type as unknown as new () => object)]);
    return new IndexWhereVisitor(table, isPostgres).visit(lambda.body);
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
            const cols = this.table.columnsFromFields([e.propertyName]);
            if (cols.length !== 1)
                throw new Error(`Index where: field '${e.propertyName}' maps to ${cols.length} columns (only single-column fields supported)`);
            return cols[0];
        }
        throw new Error(`Index where: unsupported field expression '${e.toString()}'`);
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
    private isNull(col: IColumn, equals: boolean): string {
        const name = sqlEscape(col.name, this.isPostgres);
        if (col.nullable === "No")
            return equals ? "(1 = 0)" : "(1 = 1)";
        const core = `${name} IS ${equals ? "" : "NOT "}NULL`;
        if (!col.dbType.isString())
            return core;
        return `(${core} ${equals ? "OR" : "AND"} ${name} ${equals ? "=" : "<>"} '')`;
    }

    private literal(value: unknown): string {
        if (typeof value === "string")
            return `'${value.replace(/'/g, "''")}'`;
        if (typeof value === "boolean")
            return this.isPostgres ? (value ? "TRUE" : "FALSE") : (value ? "1" : "0");
        return String(value); // number
    }
}
