import { Expression } from "../expressions";
import {
    SelectExpression, TableExpression, SetOperatorExpression, SqlTableValuedFunctionExpression,
    ColumnExpression, EntityExpression, PrimaryKeyExpression,
    SourceWithAliasExpression,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";
import { Alias, AliasGenerator } from "../aliasGenerator";

// Port of Signum's DeclaredAliasGatherer.GatherDeclared: the aliases *introduced*
// by a source tree (the alias of every Select / Table / SetOperator / TVF node).
// These are the aliases owned by the subquery, as opposed to the correlation aliases
// it merely references.
class DeclaredAliasGatherer extends DbExpressionVisitor {
    readonly aliases: Alias[] = [];

    static gather(source: Expression): Alias[] {
        const g = new DeclaredAliasGatherer();
        g.visit(source);
        return g.aliases;
    }

    private add(alias: Alias): void {
        if (!this.aliases.some(a => a.equals(alias)))
            this.aliases.push(alias);
    }

    override visitSelect(select: SelectExpression): Expression {
        this.add(select.alias);
        return super.visitSelect(select);
    }

    override visitTable(table: TableExpression): Expression {
        this.add(table.alias);
        return table;
    }

    override visitSetOperator(setOp: SetOperatorExpression): Expression {
        this.add(setOp.alias);
        return super.visitSetOperator(setOp);
    }

    override visitTableValuedFunction(e: SqlTableValuedFunctionExpression): Expression {
        this.add(e.alias);
        return super.visitTableValuedFunction(e);
    }
}

// Port of Signum's AliasReplacer.cs. Renames every alias *declared* inside `source`
// to a fresh clone (from the alias generator), and re-points every ColumnExpression /
// EntityExpression.tableAlias that references a renamed alias. Correlation columns
// (referencing aliases declared OUTSIDE `source`) are left untouched — their alias is
// not in the map — so the subquery stays correctly correlated to its outer scope.
// Used by BindUniqueRow to make the APPLY subquery self-contained with unique aliases.
export class AliasReplacer extends DbExpressionVisitor {
    private constructor(private readonly aliasMap: Map<string, Alias>) {
        super();
    }

    static replace(source: Expression, aliasGenerator: AliasGenerator): Expression {
        const declared = DeclaredAliasGatherer.gather(source);
        const aliasMap = new Map<string, Alias>();
        // Reverse order matches Signum (GatherDeclared().Reverse()): inner aliases are
        // cloned first. Cloning order only affects the generated suffixes, not correctness.
        for (const a of [...declared].reverse())
            aliasMap.set(a.toString(), aliasGenerator.cloneAlias(a));
        return new AliasReplacer(aliasMap).visit(source);
    }

    private map(alias: Alias): Alias {
        return this.aliasMap.get(alias.toString()) ?? alias;
    }

    override visitColumn(column: ColumnExpression): Expression {
        const newAlias = this.aliasMap.get(column.alias.toString());
        if (newAlias != null)
            return new ColumnExpression(column.type, newAlias, column.name);
        return column;
    }

    override visitTable(table: TableExpression): Expression {
        const newAlias = this.map(table.alias);
        if (!newAlias.equals(table.alias))
            return new TableExpression(newAlias, table.table, table.withHint, table.systemTime);
        return table;
    }

    override visitSelect(select: SelectExpression): Expression {
        const top = this.visit(select.top);
        const from = select.from == null ? undefined : this.visitSource(select.from);
        const where = this.visit(select.where);
        const columns = this.visitArray(select.columns, c => this.visitColumnDeclaration(c));
        const orderBy = this.visitArray(select.orderBy, o => this.visitOrderBy(o));
        const groupBy = this.visitArray(select.groupBy, g => this.visit(g));
        const offset = this.visit(select.offset);
        const newAlias = this.map(select.alias);
        if (top !== select.top || from !== select.from || where !== select.where ||
            columns !== select.columns || orderBy !== select.orderBy || groupBy !== select.groupBy ||
            offset !== select.offset || !newAlias.equals(select.alias))
            return new SelectExpression(newAlias, select.isDistinct, top, columns, from, where, orderBy, groupBy, select.selectOptions, offset);
        return select;
    }

    override visitSetOperator(setOp: SetOperatorExpression): Expression {
        const left = this.visitSource(setOp.left) as SourceWithAliasExpression;
        const right = this.visitSource(setOp.right) as SourceWithAliasExpression;
        const newAlias = this.map(setOp.alias);
        if (left !== setOp.left || right !== setOp.right || !newAlias.equals(setOp.alias))
            return new SetOperatorExpression(setOp.operator, left, right, newAlias);
        return setOp;
    }

    override visitTableValuedFunction(e: SqlTableValuedFunctionExpression): Expression {
        const args = this.visitArray(e.arguments, a => this.visit(a));
        const newAlias = this.map(e.alias);
        if (args !== e.arguments || !newAlias.equals(e.alias))
            return new SqlTableValuedFunctionExpression(newAlias, e.functionName, e.columnName, args);
        return e;
    }

    override visitEntity(ee: EntityExpression): Expression {
        const externalId = this.visit(ee.externalId) as PrimaryKeyExpression;
        const bindings = ee.bindings == null ? undefined : this.visitArray(ee.bindings, b => this.visitFieldBinding(b));
        const mixins = ee.mixins == null ? undefined : this.visitArray(ee.mixins, m => this.visitMixinEntity(m));
        const additional = ee.additionalBindings == null ? undefined : this.visitArray(ee.additionalBindings, a => this.visitAdditionalBinding(a));
        const newAlias = ee.tableAlias == null ? undefined : this.map(ee.tableAlias);
        if (externalId !== ee.externalId || bindings !== ee.bindings || mixins !== ee.mixins || additional !== ee.additionalBindings ||
            (newAlias != null && ee.tableAlias != null && !newAlias.equals(ee.tableAlias)))
            return new EntityExpression(ee.type, ee.table, externalId, newAlias, bindings, mixins, ee.avoidExpandOnRetrieving, additional);
        return ee;
    }
}

// Canonical structural key for a unique-function APPLY subquery (Signum keys
// uniqueFunctionReplacements by DbExpressionComparer with alias alpha-equivalence).
// Rather than porting the 545-line comparer, we canonicalise: rename the subquery's OWN
// declared aliases to positional names (`_u0`, `_u1`, …) in visitation order, leaving
// correlation columns (referencing outer aliases) untouched, then key a Map by the
// resulting toString(). Two selects that differ only in their fresh (AliasReplacer-
// generated) aliases produce the same signature and collapse to one APPLY.
class CanonicalAliasVisitor extends DbExpressionVisitor {
    private constructor(private readonly aliasMap: Map<string, Alias>) {
        super();
    }

    // Any post-binder expression, not only a Select: an ORDER BY whose expression is a
    // correlated sub-query needs the same alpha-equivalence (see dbExpressionEquals).
    static signature(expression: Expression): string {
        const declared = DeclaredAliasGatherer.gather(expression);
        const aliasMap = new Map<string, Alias>();
        // Deterministic positional renaming. Aliases with a name only (no ObjectName);
        // real table ObjectName aliases are never among a select's declared set.
        declared.forEach((a, i) => aliasMap.set(a.toString(), Alias.named("_u" + i, a.isPostgres)));
        const canonical = new CanonicalAliasVisitor(aliasMap).visit(expression);
        return canonical.toString();
    }

    private map(alias: Alias): Alias {
        return this.aliasMap.get(alias.toString()) ?? alias;
    }

    override visitColumn(column: ColumnExpression): Expression {
        const newAlias = this.aliasMap.get(column.alias.toString());
        return newAlias != null ? new ColumnExpression(column.type, newAlias, column.name) : column;
    }

    override visitTable(table: TableExpression): Expression {
        const newAlias = this.map(table.alias);
        return !newAlias.equals(table.alias) ? new TableExpression(newAlias, table.table, table.withHint, table.systemTime) : table;
    }

    override visitSelect(select: SelectExpression): Expression {
        const top = this.visit(select.top);
        const from = select.from == null ? undefined : this.visitSource(select.from);
        const where = this.visit(select.where);
        const columns = this.visitArray(select.columns, c => this.visitColumnDeclaration(c));
        const orderBy = this.visitArray(select.orderBy, o => this.visitOrderBy(o));
        const groupBy = this.visitArray(select.groupBy, g => this.visit(g));
        const offset = this.visit(select.offset);
        const newAlias = this.map(select.alias);
        return new SelectExpression(newAlias, select.isDistinct, top, columns, from, where, orderBy, groupBy, select.selectOptions, offset);
    }

    override visitSetOperator(setOp: SetOperatorExpression): Expression {
        const left = this.visitSource(setOp.left) as SourceWithAliasExpression;
        const right = this.visitSource(setOp.right) as SourceWithAliasExpression;
        return new SetOperatorExpression(setOp.operator, left, right, this.map(setOp.alias));
    }

    override visitTableValuedFunction(e: SqlTableValuedFunctionExpression): Expression {
        const args = this.visitArray(e.arguments, a => this.visit(a));
        return new SqlTableValuedFunctionExpression(this.map(e.alias), e.functionName, e.columnName, args);
    }

    override visitEntity(ee: EntityExpression): Expression {
        const externalId = this.visit(ee.externalId) as PrimaryKeyExpression;
        const bindings = ee.bindings == null ? undefined : this.visitArray(ee.bindings, b => this.visitFieldBinding(b));
        const mixins = ee.mixins == null ? undefined : this.visitArray(ee.mixins, m => this.visitMixinEntity(m));
        const additional = ee.additionalBindings == null ? undefined : this.visitArray(ee.additionalBindings, a => this.visitAdditionalBinding(a));
        const newAlias = ee.tableAlias == null ? undefined : this.map(ee.tableAlias);
        return new EntityExpression(ee.type, ee.table, externalId, newAlias, bindings, mixins, ee.avoidExpandOnRetrieving, additional);
    }
}

// Structural signature helper for the unique-function dedup.
export class UniqueRequestKey {
    static of(select: SelectExpression): string {
        return CanonicalAliasVisitor.signature(select);
    }
}

/**
 * Signum's `DbExpressionComparer.AreEqual` for a POST-BINDER tree: structural equality with alias
 * ALPHA-EQUIVALENCE, so two identical correlated sub-queries that differ only in the aliases the
 * binder happened to generate (`… FROM album AS a2` vs `AS a3`) compare equal, while a reference to
 * an OUTER alias — which is what makes a sub-query correlated — still has to match exactly.
 *
 * Implemented as the canonical signature above rather than as a port of Signum's 545-line per-node
 * comparer, for the reason CanonicalAliasVisitor's own header gives: `toString()` is already the
 * structural signature this codebase compares post-binder subtrees by (RedundantJoinRemover's join
 * dedupe), and the alias renaming is the one thing it cannot express. Each node's `toString()` is
 * therefore part of that contract — see RowNumberExpression / SelectExpression, which carry their
 * orderings and options for exactly this reason.
 */
export function dbExpressionEquals(a: Expression | undefined, b: Expression | undefined): boolean {
    if (a === b)
        return true;
    if (a == null || b == null)
        return false;
    return CanonicalAliasVisitor.signature(a) === CanonicalAliasVisitor.signature(b);
}

// Port of Signum's UsedAliasGatherer.Externals: the distinct table aliases an expression reads
// columns from. Lives beside DeclaredAliasGatherer (the aliases an expression *introduces*) — the
// two are asked together wherever "does this expression only refer to things this source knows?"
// is the question: the binder's GetCurrentSource, and the OrderByColumnPromoter.
export class UsedAliasGatherer extends DbExpressionVisitor {
    private readonly aliases: Alias[] = [];

    static externals(e: Expression): Alias[] {
        const g = new UsedAliasGatherer();
        g.visit(e);
        return g.aliases;
    }

    override visitColumn(c: ColumnExpression): Expression {
        if (!this.aliases.some(a => a.equals(c.alias)))
            this.aliases.push(c.alias);
        return c;
    }
}

// Re-export for callers that only need the declared-alias set.
export { DeclaredAliasGatherer };
