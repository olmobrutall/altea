import { Expression } from "../expressions";
import {
    SelectExpression, ProjectionExpression, JoinExpression, TableExpression,
    ScalarExpression, ColumnExpression, ColumnDeclaration, OrderExpression,
    SourceExpression,
} from "../expressions.sql";
import { Alias } from "../AliasGenerator";
import { ColumnGenerator } from "../ColumnGenerator";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's QueryRebinder (Engine/Linq/ExpressionVisitor/QueryRebinder.cs).
//
// After OrderByRewriter floats ORDER BY (and other expressions) up to outer
// selects, those expressions can reference columns of aliases that are nested
// several SELECT levels below — illegal SQL ("missing FROM-clause entry for s0").
// QueryRebinder walks top-down tracking, per scope, which columns each enclosing
// expression still needs ("asked" columns); at every SELECT it ANSWERS them by
// ensuring the column is exposed as a declaration (adding one if missing) and
// rewriting the outer reference to point at THIS select's alias. The effect is
// that a deep `s0.dead` reference becomes `s1.dead` then `s2.dead` as it climbs,
// so each reference resolves against its immediate FROM.
//
// Value-keyed column scopes are essential: Signum keys its dictionaries by
// ColumnExpression value-equality (alias+name), which a JS Map (reference-keyed)
// does not provide — hence ColScope below.
//
// Scoped to altea's node set (no SetOperator/RowNumber/TVF/command nodes).
export class QueryRebinder extends DbExpressionVisitor {
    private scopes: ColScope[] = [];
    private readonly collector = new ColumnCollector();

    private get currentScope(): ColScope {
        return this.scopes[this.scopes.length - 1];
    }

    static rebind(expression: Expression): Expression {
        const qr = new QueryRebinder();
        return qr.withScope(() => qr.visit(expression));
    }

    private withScope<T>(action: () => T): T {
        this.scopes.push(new ColScope());
        try {
            return action();
        } finally {
            this.scopes.pop();
        }
    }

    private getColumnCollector(knownAliases: readonly Alias[]): ColumnCollector {
        this.collector.currentScope = this.currentScope;
        this.collector.knownAliases = knownAliases;
        return this.collector;
    }

    override visitProjection(proj: ProjectionExpression): Expression {
        this.getColumnCollector(proj.select.knownAliases()).visit(proj.projector);

        const source = this.visit(proj.select) as SelectExpression;
        const projector = this.visit(proj.projector);

        for (const [key, value] of this.currentScope.entries()) {
            if (source.knownAliases().some(a => a.equals(key.alias))) {
                if (value == null)
                    throw new Error("QueryRebinder: unanswered column " + key);
                this.currentScope.delete(key);
            }
        }

        if (source !== proj.select || projector !== proj.projector)
            return new ProjectionExpression(source, projector, proj.uniqueFunction, proj.type);
        return proj;
    }

    override visitSelect(select: SelectExpression): Expression {
        const known = select.knownAliases();
        const askedColumns = this.currentScope.keys().filter(k => known.some(a => a.equals(k.alias)));
        const externalAnswers = this.currentScope.entries()
            .filter(([k, v]) => !known.some(a => a.equals(k.alias)) && v != null);

        let from!: SourceExpression;
        let top: Expression | undefined;
        let where: Expression | undefined;
        let orderBy: readonly OrderExpression[] = select.orderBy;
        let groupBy: readonly Expression[] = select.groupBy;
        let columns: readonly ColumnDeclaration[] = select.columns;
        let externals: [ColumnExpression, ColumnExpression | null][] = [];

        this.withScope(() => {
            const scope = this.currentScope;
            for (const k of askedColumns)
                if (!k.alias.equals(select.alias))
                    scope.set(k, null);
            for (const [k, v] of externalAnswers)
                scope.set(k, v);

            const col = this.getColumnCollector(known);
            col.visit(select.top);
            col.visit(select.where);
            for (const cd of select.columns) col.visit(cd.expression);
            for (const oe of select.orderBy) col.visit(oe.expression);
            for (const g of select.groupBy) col.visit(g);

            from = this.visitSource(select.from!);
            top = this.visit(select.top);
            where = this.visit(select.where);
            orderBy = this.visitArray(select.orderBy, o => this.visitOrderBy(o));
            if (orderBy.length > 0)
                orderBy = QueryRebinder.removeDuplicates(orderBy);
            groupBy = this.visitArray(select.groupBy, g => this.visit(g));
            columns = this.visitArray(select.columns, c => this.visitColumnDeclaration(c));
            columns = this.answerAndExpand(columns, select.alias, askedColumns);

            externals = this.currentScope.entries()
                .filter(([k, v]) => !known.some(a => a.equals(k.alias)) && v == null);
        });

        for (const [k, v] of externals)
            this.currentScope.set(k, v);
        // Publish the answers for what an enclosing scope asked of this select.
        for (const k of askedColumns)
            this.currentScope.set(k, this.askedAnswers.get(QueryRebinder.key(k)) ?? null);

        if (top !== select.top || from !== select.from || where !== select.where
            || columns !== select.columns || orderBy !== select.orderBy || groupBy !== select.groupBy)
            return new SelectExpression(select.alias, select.isDistinct, top, columns, from, where, orderBy, groupBy, select.selectOptions);

        return select;
    }

    // Scratch space carrying AnswerAndExpand's results out of the inner scope.
    private readonly askedAnswers = new Map<string, ColumnExpression>();

    override visitTable(table: TableExpression): Expression {
        for (const c of this.currentScope.keys())
            if (c.alias.equals(table.alias))
                this.currentScope.set(c, c);
        return table;
    }

    override visitJoin(join: JoinExpression): Expression {
        if (join.condition != null)
            this.getColumnCollector(join.knownAliases()).visit(join.condition);
        else if (join.joinType === "CrossApply" || join.joinType === "OuterApply")
            this.getColumnCollector(join.left.knownAliases()).visit(join.right);

        const left = this.visitSource(join.left);
        const right = this.visitSource(join.right);
        const condition = this.visit(join.condition);
        if (left !== join.left || right !== join.right || condition !== join.condition)
            return new JoinExpression(join.joinType, left, right, condition);
        return join;
    }

    override visitScalar(scalar: ScalarExpression): Expression {
        const column = scalar.select!.columns[0];
        this.visitColumn(new ColumnExpression(scalar.type, scalar.select!.alias, column.name));

        const select = this.visit(scalar.select!) as SelectExpression;
        if (select !== scalar.select)
            return new ScalarExpression(scalar.type, select);
        return scalar;
    }

    override visitColumn(column: ColumnExpression): Expression {
        const answer = this.currentScope.get(column);
        if (answer !== undefined)
            return answer ?? column;
        this.currentScope.set(column, null);
        return column;
    }

    // Ensures every asked column is exposed at `currentAlias`: a column already at
    // this alias answers as itself; a deeper one (already answered to an inner
    // column in this scope) gets a declaration here (reused or freshly mapped) and
    // the asked column is answered with a reference to it.
    private answerAndExpand(columns: readonly ColumnDeclaration[], currentAlias: Alias, askedColumns: readonly ColumnExpression[]): readonly ColumnDeclaration[] {
        const cg = new ColumnGenerator(columns);
        this.askedAnswers.clear();

        for (const col of askedColumns) {
            if (col.alias.equals(currentAlias)) {
                this.askedAnswers.set(QueryRebinder.key(col), col);
            } else {
                const colExp = this.currentScope.get(col) as ColumnExpression;
                let cd = cg.declarations.find(c => c.expression instanceof ColumnExpression && c.expression.equalsColumn(colExp));
                if (cd == null)
                    cd = cg.mapColumn(colExp);
                this.askedAnswers.set(QueryRebinder.key(col), new ColumnExpression(col.type, currentAlias, cd.name));
            }
        }

        if (columns.length !== cg.declarations.length)
            return cg.declarations;
        return columns;
    }

    private static removeDuplicates(orderBy: readonly OrderExpression[]): readonly OrderExpression[] {
        const result: OrderExpression[] = [];
        const used = new Set<string>();
        for (const o of orderBy) {
            const k = o.expression instanceof ColumnExpression ? QueryRebinder.key(o.expression) : null;
            if (k == null) { result.push(o); continue; }
            if (!used.has(k)) { used.add(k); result.push(o); }
        }
        return result.length === orderBy.length ? orderBy : result;
    }

    static key(c: ColumnExpression): string {
        return `${c.alias}|${c.name}`;
    }
}

// Value-keyed column scope: ColumnExpressions compare by alias+name, not identity.
class ColScope {
    private readonly m = new Map<string, [ColumnExpression, ColumnExpression | null]>();

    get(c: ColumnExpression): ColumnExpression | null | undefined {
        const e = this.m.get(QueryRebinder.key(c));
        return e === undefined ? undefined : e[1];
    }
    set(c: ColumnExpression, answer: ColumnExpression | null): void {
        this.m.set(QueryRebinder.key(c), [c, answer]);
    }
    delete(c: ColumnExpression): void {
        this.m.delete(QueryRebinder.key(c));
    }
    keys(): ColumnExpression[] {
        return [...this.m.values()].map(e => e[0]);
    }
    entries(): [ColumnExpression, ColumnExpression | null][] {
        return [...this.m.values()];
    }
}

// Marks every column referenced under one of `knownAliases` as an asked (null)
// entry in the active scope.
class ColumnCollector extends DbExpressionVisitor {
    knownAliases: readonly Alias[] = [];
    currentScope!: ColScope;

    override visitColumn(column: ColumnExpression): Expression {
        if (this.knownAliases.some(a => a.equals(column.alias)))
            this.currentScope.set(column, null);
        return column;
    }
}
