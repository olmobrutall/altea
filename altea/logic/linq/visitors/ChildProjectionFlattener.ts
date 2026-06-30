import { Expression, ObjectExpression } from "../expressions";
import {
    SelectExpression, ProjectionExpression, JoinExpression, TableExpression,
    ColumnExpression, ColumnDeclaration, OrderExpression, SqlConstantExpression,
    SourceExpression, ChildProjectionExpression, LookupToken,
} from "../expressions.sql";
import { LiteralType } from "../../../entities/types";
import { Alias, AliasGenerator } from "../AliasGenerator";
import { ColumnGenerator } from "../ColumnGenerator";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Lookup tokens are keyed by object identity in the reader; the id is just a
// human-readable discriminator.
let tokenSeq = 0;

// Port of Signum's ChildProjectionFlattener
// (Engine/Linq/ExpressionVisitor/ChildProjectionFlattener.cs).
//
// A nested ProjectionExpression in a projector (e.g. `map(l => …toArray())`) is an
// eager-loaded child query. This pass replaces each with a ChildProjectionExpression
// carrying (a) a correlation key the parent row exposes and (b) a standalone child
// query that yields {key, value} rows. The reader runs each child query once,
// groups its rows by key into a lookup, and the parent projector reads its slice by
// key — turning N+1 navigation into one extra query per nesting level.
//
// Scoped to altea: eager only (no lazy MList), key/value carried as an
// ObjectExpression `{ k, v }` (no tuple/ArrayBox), and the reader serialises keys
// to strings. The Distinct path (non-key correlation) is ported; SetOperator/
// RowNumber sources are not modelled.
export class ChildProjectionFlattener extends DbExpressionVisitor {
    private currentSource: SelectExpression | undefined;

    constructor(private readonly aliasGenerator: AliasGenerator) { super(); }

    static flatten(proj: ProjectionExpression, aliasGenerator: AliasGenerator): ProjectionExpression {
        return new ChildProjectionFlattener(aliasGenerator).visit(proj) as ProjectionExpression;
    }

    override visitProjection(proj: ProjectionExpression): Expression {
        if (this.currentSource == null) {
            // Root projection: bind the current source and flatten the projector.
            this.currentSource = withoutOrder(proj.select);
            const projector = this.visit(proj.projector);
            this.currentSource = undefined;
            return projector !== proj.projector
                ? new ProjectionExpression(proj.select, projector, proj.uniqueFunction, proj.type)
                : proj;
        }

        // Nested projection → an eager child projection.
        const columns = ExternalColumnGatherer.gather(proj, this.currentSource.alias);

        if (columns.length === 0) {
            // Uncorrelated: a single constant-keyed bucket.
            const projector = this.visit(proj.projector);
            const key = new SqlConstantExpression(0, LiteralType.number);
            const childProj = new ProjectionExpression(proj.select, kvp(key, projector), proj.uniqueFunction, proj.type);
            return new ChildProjectionExpression(childProj, new SqlConstantExpression(0, LiteralType.number), false, proj.type, new LookupToken(tokenSeq++));
        }

        let external: SelectExpression;
        let externalColumns: ColumnExpression[];

        if (!isKey(this.currentSource, columns)) {
            // Correlation columns aren't the source key → SELECT DISTINCT them so a
            // parent appears once, then re-point the child's references to it.
            const aliasDistinct = this.aliasGenerator.nextSelectAlias();
            const gen = new ColumnGenerator();
            const columnDistinct = columns.map(ce => gen.mapColumn(ce));
            external = new SelectExpression(aliasDistinct, true, undefined, columnDistinct, this.currentSource, undefined, [], []);

            const replacements = new Map<string, ColumnExpression>(
                columnDistinct.map(cd => [colKey(cd.expression as ColumnExpression), cd.getReference(aliasDistinct)]));
            proj = ColumnReplacer.replace(proj, replacements) as ProjectionExpression;
            externalColumns = columnDistinct.map(cd => cd.getReference(aliasDistinct));
        } else {
            external = this.currentSource;
            externalColumns = columns;
        }

        const genSM = new ColumnGenerator();
        const columnsSMExternal = externalColumns.map(ce => genSM.mapColumn(ce));
        const columnsSMInternal = proj.select.columns.map(cd => genSM.mapColumn(cd.getReference(proj.select.alias)));

        const { select: innerSelect, orders: innerOrders } = extractOrders(proj.select);

        const aliasSM = this.aliasGenerator.nextSelectAlias();
        const selectMany = new SelectExpression(
            aliasSM, false, undefined, [...columnsSMExternal, ...columnsSMInternal],
            new JoinExpression("CrossApply", external, innerSelect, undefined),
            undefined, innerOrders ?? [], []);

        const old = this.currentSource;
        this.currentSource = withoutOrder(selectMany);

        const smReplacements = new Map<string, ColumnExpression>(
            selectMany.columns.map(cd => [colKey(cd.expression as ColumnExpression), cd.getReference(aliasSM)]));
        let projector = ColumnReplacer.replace(proj.projector, smReplacements);
        projector = this.visit(projector);

        this.currentSource = old;

        const keyInChild = singleOrObject(columnsSMExternal.map(cd => cd.getReference(aliasSM)));
        const childProj = new ProjectionExpression(selectMany, kvp(keyInChild, projector), proj.uniqueFunction, proj.type);

        const outerKey = singleOrObject(columns);
        return new ChildProjectionExpression(childProj, outerKey, false, proj.type, new LookupToken(tokenSeq++));
    }
}

// {key, value} carrier the reader understands (Signum's KeyValuePair).
function kvp(key: Expression, value: Expression): ObjectExpression {
    return new ObjectExpression({ k: key, v: value });
}

// A single column stays a column; several become an object so the key serialises
// deterministically on both the child (k) and parent (outerKey) sides.
function singleOrObject(columns: readonly ColumnExpression[]): Expression {
    if (columns.length === 1)
        return columns[0];
    const props: Record<string, Expression> = {};
    columns.forEach((c, i) => props["k" + i] = c);
    return new ObjectExpression(props);
}

function colKey(c: ColumnExpression): string {
    return `${c.alias}|${c.name}`;
}

function withoutOrder(sel: SelectExpression): SelectExpression {
    // A TOP or OFFSET makes the inner ORDER BY meaningful (it picks which rows), so
    // keep it; otherwise the order is irrelevant once flattened and is dropped.
    if (sel.top != null || sel.offset != null || sel.orderBy.length === 0)
        return sel;
    return new SelectExpression(sel.alias, sel.isDistinct, sel.top, sel.columns, sel.from, sel.where, [], sel.groupBy, sel.selectOptions, sel.offset);
}

// Pulls a child's ORDER BY out as extra columns so the order survives the CROSS
// APPLY flatten (the inner ORDER BY would otherwise be illegal / lost).
function extractOrders(sel: SelectExpression): { select: SelectExpression; orders: OrderExpression[] | undefined } {
    if (sel.top != null || sel.offset != null || sel.orderBy.length === 0)
        return { select: sel, orders: undefined };

    const cg = new ColumnGenerator(sel.columns);
    const orders: OrderExpression[] = [];
    const extra: ColumnDeclaration[] = [];
    for (const o of sel.orderBy) {
        const cd = cg.newColumn(o.expression);
        extra.push(cd);
        orders.push(new OrderExpression(o.orderType, cd.getReference(sel.alias)));
    }
    const select = new SelectExpression(sel.alias, sel.isDistinct, sel.top, [...sel.columns, ...extra], sel.from, sel.where, [], sel.groupBy, sel.selectOptions);
    return { select, orders };
}

function isKey(source: SelectExpression, columns: readonly ColumnExpression[]): boolean {
    const keys = keysOf(source);
    return keys.length > 0 && keys.every(k => k != null && columns.some(c => colKey(c) === colKey(k)));
}

// The columns that uniquely identify a row of `source` (Signum's KeyFinder),
// scoped to altea's source nodes.
function keysOf(source: SourceExpression): (ColumnExpression | undefined)[] {
    if (source instanceof TableExpression)
        return [new ColumnExpression(LiteralType.number, source.alias, source.table.primaryKey.column.name)];

    if (source instanceof JoinExpression) {
        if (source.joinType === "SingleRowLeftOuterJoin")
            return keysOf(source.left);
        return [...keysOf(source.left), ...keysOf(source.right)];
    }

    if (source instanceof SelectExpression) {
        if (source.groupBy.length > 0)
            return source.groupBy.map(ge => findExposed(source, ge));
        const inner = keysOf(source.from!);
        const result = inner.map(ce => ce == null ? undefined : findExposed(source, ce));
        if (!source.isDistinct)
            return result;
        if (result.some(c => c == null))
            return source.columns.map(cd => cd.getReference(source.alias));
        return result;
    }

    return [];
}

// The reference, at `select`'s alias, of whichever column declaration exposes `inner`.
function findExposed(select: SelectExpression, inner: Expression): ColumnExpression | undefined {
    const cd = select.columns.find(c => c.expression instanceof ColumnExpression && inner instanceof ColumnExpression && colKey(c.expression) === colKey(inner));
    return cd?.getReference(select.alias);
}

// Re-points ColumnExpressions per a replacement map; never descends into an
// already-extracted child projection.
class ColumnReplacer extends DbExpressionVisitor {
    constructor(private readonly replacements: Map<string, ColumnExpression>) { super(); }

    static replace(expression: Expression, replacements: Map<string, ColumnExpression>): Expression {
        return new ColumnReplacer(replacements).visit(expression);
    }

    override visitColumn(column: ColumnExpression): Expression {
        return this.replacements.get(colKey(column)) ?? column;
    }

    override visitChildProjection(child: ChildProjectionExpression): Expression {
        return child;
    }
}

// Collects the columns of an expression that reference `externalAlias` (the parent
// source) — i.e. the correlation key the child query depends on.
class ExternalColumnGatherer extends DbExpressionVisitor {
    private readonly found = new Map<string, ColumnExpression>();

    constructor(private readonly externalAlias: Alias) { super(); }

    static gather(source: Expression, externalAlias: Alias): ColumnExpression[] {
        const g = new ExternalColumnGatherer(externalAlias);
        g.visit(source);
        return [...g.found.values()];
    }

    override visitColumn(column: ColumnExpression): Expression {
        if (this.externalAlias.equals(column.alias))
            this.found.set(colKey(column), column);
        return column;
    }
}
