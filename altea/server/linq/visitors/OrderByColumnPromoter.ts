import { Expression, ConstantExpression } from "../expressions";
import {
    SelectExpression, ColumnDeclaration, ColumnExpression, OrderExpression,
    RowNumberExpression, SqlConstantExpression,
} from "../expressions.sql";
import { ColumnGenerator } from "../ColumnGenerator";
import { DbExpressionVisitor } from "./DbExpressionVisitor";
import { Alias } from "../aliasGenerator";
import { DeclaredAliasGatherer, UsedAliasGatherer, dbExpressionEquals } from "./AliasReplacer";
import { SubqueryRemover } from "./RedundantSubqueryRemover";

// Port of Signum's OrderByColumnPromoter (Engine/Linq/ExpressionVisitor/OrderByColumnPromoter.cs).
//
// Replaces complex orderings (typically correlated sub-queries) by a reference to a column of the
// sub-select they come from, reusing an equivalent column if there is already one.
//
// The OrderByRewriter moves the orderings to the SelectExpression that needs them (the one with
// TOP / OFFSET / ROW_NUMBER, and the outer-most one) and the QueryRebinder re-correlates them to
// the closest alias. As a side effect the whole expression gets duplicated once per nesting level,
// so ordering a paginated query by something like `a.albums().count()` ends up with the same
// sub-query repeated 3 or 4 times.
//
// Two divergences from Signum, both because altea's tree says less:
//
//  - NO RemoveNullify. Signum has to look through a `Convert(expr, T?)` because a QueryToken used
//    as an ORDER is nullified while the same token used as a COLUMN is not, so the two would not
//    look equivalent. TypeScript has no nullable-value-type conversion and altea's token layer
//    builds ONE expression for both (dQueryable's `orderBy` and `select` both call
//    `token.buildExpression`), so there is nothing to look through.
//
//  - the ROW_NUMBER pass is about `withIndex`, not about pagination. Signum's Skip becomes a
//    ROW_NUMBER select; altea's becomes an OFFSET on the select's own ORDER BY, so a paginated
//    query is handled by promoteOrderings alone. RowNumberPromoter is still ported: an indexed
//    selector's window inherits the query's orderings, which can be just as complex.
//
// `ref SelectExpression from` has no TypeScript counterpart, so the two functions that rewrite the
// FROM take a get/set pair over one local instead.
export class OrderByColumnPromoter extends DbExpressionVisitor {
    private constructor() { super(); }

    static promote(expression: Expression): Expression {
        return new OrderByColumnPromoter().visit(expression);
    }

    override visitSelect(select: SelectExpression): Expression {
        select = reuseOwnColumns(super.visitSelect(select) as SelectExpression);

        if (!(select.from instanceof SelectExpression) || !canAddColumns(select.from))
            return select;

        const from = select.from;
        let newFrom = from;
        const setFrom = (s: SelectExpression) => { newFrom = s; };
        const getFrom = () => newFrom;

        const columns = RowNumberPromoter.promote(select.columns, setFrom, getFrom);
        const orderBy = promoteOrderings(select.orderBy, setFrom, getFrom);

        if (newFrom !== from)
            newFrom = reuseOwnColumns(newFrom); // it could have got the column that its own ORDER BY is repeating

        if (newFrom === from && columns === select.columns && orderBy === select.orderBy)
            return select;

        return new SelectExpression(select.alias, select.isDistinct, select.top, columns, newFrom,
            select.where, orderBy, select.groupBy, select.selectOptions, select.offset);
    }
}

/**
 * A select can order by an expression that it is already returning as a column, referring to it by
 * the bare column alias (SELECT expr as c0 ... ORDER BY c0). No column is added, only repetitions
 * are removed.
 */
function reuseOwnColumns(select: SelectExpression): SelectExpression {
    if (!select.orderBy.some(o => isComplex(o.expression)))
        return select;

    const orderBy = select.orderBy.map(o => {
        if (!isComplex(o.expression))
            return o;

        const cd = findColumn(select, o.expression);

        return cd == null ? o : new OrderExpression(o.orderType, new ColumnExpression(cd.expression.type, select.alias, cd.name));
    });

    if (orderBy.every((o, i) => o === select.orderBy[i]))
        return select;

    return new SelectExpression(select.alias, select.isDistinct, select.top, select.columns, select.from,
        select.where, orderBy, select.groupBy, select.selectOptions, select.offset);
}

/** The orderings are expressed in the scope of the select that has `getFrom()` in the FROM. */
function promoteOrderings(orderings: readonly OrderExpression[], setFrom: (s: SelectExpression) => void,
    getFrom: () => SelectExpression): readonly OrderExpression[] {

    if (!orderings.some(o => shouldPromote(o.expression, getFrom())))
        return orderings;

    const result: OrderExpression[] = [];

    for (const o of orderings) {
        if (!shouldPromote(o.expression, getFrom())) {
            result.push(o);
        } else {
            const cd = promoteColumn(SubqueryRemover.remove(o.expression, [getFrom()]), setFrom, getFrom);

            result.push(new OrderExpression(o.orderType, new ColumnExpression(cd.expression.type, getFrom().alias, cd.name)));
        }
    }

    return result;
}

/**
 * `expression` is expressed in the scope of `getFrom()` (it refers to the aliases of its own FROM).
 * Returns the column of that select which now contains the expression.
 */
function promoteColumn(expression: Expression, setFrom: (s: SelectExpression) => void,
    getFrom: () => SelectExpression): ColumnDeclaration {

    const from = getFrom();

    const equivalent = findColumn(from, expression);
    if (equivalent != null)
        return equivalent;

    // If the sub-select is just a wrapper keep going down, so the expression is evaluated only once
    // and each intermediate select just forwards the column.
    const deeper = from.from;
    if (isComplex(expression) && deeper instanceof SelectExpression && canAddColumns(deeper) &&
        externalAliases(expression).every(a => deeper.knownAliases().some(k => k.equals(a)))) {

        let newDeeper = deeper;
        const deeperColumn = promoteColumn(SubqueryRemover.remove(expression, [deeper]),
            s => { newDeeper = s; }, () => newDeeper);

        const forward = new ColumnExpression(deeperColumn.expression.type, newDeeper.alias, deeperColumn.name);

        const generator = new ColumnGenerator(from.columns);
        const declaration = findColumn(from, forward) ?? generator.newColumn(forward);

        setFrom(new SelectExpression(from.alias, from.isDistinct, from.top, generator.declarations, newDeeper,
            from.where, from.orderBy, from.groupBy, from.selectOptions, from.offset));

        return declaration;
    }

    const cg = new ColumnGenerator(from.columns);
    const newColumn = cg.newColumn(expression);

    setFrom(new SelectExpression(from.alias, from.isDistinct, from.top, cg.declarations, from.from, from.where,
        from.orderBy, from.groupBy, from.selectOptions, from.offset));

    return newColumn;
}

function findColumn(select: SelectExpression, expression: Expression): ColumnDeclaration | undefined {
    return select.columns.find(cd => dbExpressionEquals(cd.expression, expression));
}

function shouldPromote(expression: Expression, from: SelectExpression): boolean {
    return isComplex(expression) && externalAliases(expression).every(a => from.knownAliases().some(k => k.equals(a)));
}

/** The aliases the expression refers to but does not declare itself (a correlated sub-query declares its own). */
function externalAliases(expression: Expression): Alias[] {
    const declared = DeclaredAliasGatherer.gather(expression);
    return UsedAliasGatherer.externals(expression).filter(a => !declared.some(d => d.equals(a)));
}

function isComplex(expression: Expression): boolean {
    return !(expression instanceof ColumnExpression) &&
        !(expression instanceof ConstantExpression) &&
        !(expression instanceof SqlConstantExpression);
}

/** Adding a column to the sub-select must not change the rows it returns. */
function canAddColumns(select: SelectExpression): boolean {
    return !select.isDistinct &&
        select.groupBy.length === 0 &&
        !select.isAllAggregates() &&
        !select.isForXmlPathEmpty() &&
        select.from != null;
}

/**
 * The ORDER BY of a ROW_NUMBER (altea's indexed selector) lives inside a ColumnDeclaration, but is
 * evaluated in the same scope as the ORDER BY of the select, so it can share the promoted columns.
 */
class RowNumberPromoter extends DbExpressionVisitor {
    private constructor(
        private readonly setFrom: (s: SelectExpression) => void,
        private readonly getFrom: () => SelectExpression,
    ) { super(); }

    static promote(columns: readonly ColumnDeclaration[], setFrom: (s: SelectExpression) => void,
        getFrom: () => SelectExpression): readonly ColumnDeclaration[] {

        const visitor = new RowNumberPromoter(setFrom, getFrom);

        return visitor.visitArray(columns, c => visitor.visitColumnDeclaration(c));
    }

    override visitRowNumber(rowNumber: RowNumberExpression): Expression {
        if (rowNumber.orderBy.length === 0)
            return rowNumber;

        const newOrderBy = promoteOrderings(rowNumber.orderBy, this.setFrom, this.getFrom);

        return newOrderBy === rowNumber.orderBy ? rowNumber : new RowNumberExpression(newOrderBy);
    }

    // Sub-queries have their own scope, and are already visited by the OrderByColumnPromoter itself
    override visitSelect(select: SelectExpression): Expression { return select; }
}
