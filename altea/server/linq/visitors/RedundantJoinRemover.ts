import { Expression, BinaryExpression } from "../expressions";
import {
    SelectExpression, JoinExpression, TableExpression, ColumnExpression, ColumnDeclaration,
    OrderExpression, SourceExpression,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";
import { Alias } from "../aliasGenerator";

// Merges structurally-identical entity-completion joins within one SELECT. Two references to the
// same entity reached by different paths — e.g. `a.label.toLite()` (whose display model navigates
// the label for its ToStr) and `a.label.name` — bind to two distinct EntityExpressions and become
// two identical `SingleRowLeftOuterJoin`s to the same table on the same FK. Signum avoids this by
// sharing one EntityExpression per reference; altea's binder doesn't unify across the toLite/navigate
// boundary, so we dedupe here — AFTER RedundantSubqueryRemover has collapsed the transient subquery
// aliases so both joins read the same owner FK (`… ON A.LabelID = X.ID`).
//
// Conservative by construction: only `SingleRowLeftOuterJoin`s to a bare TableExpression with an
// equality FK condition are candidates (exactly the completion joins); INNER joins, applies and
// UNION-combine sub-selects are never touched. Two joins merge only when table + owner-FK column
// match, which means the same target row — so the merge can never change results.
export class RedundantJoinRemover extends DbExpressionVisitor {
    static remove(expression: Expression): Expression {
        return new RedundantJoinRemover().visit(expression);
    }

    override visitSelect(select: SelectExpression): Expression {
        // Bottom-up: dedupe nested selects first.
        const s = super.visitSelect(select) as SelectExpression;
        if (s.from == undefined)
            return s;

        // Collect candidate completion joins and group them by (table, owner-FK).
        const candidates: { alias: Alias; sig: string }[] = [];
        collectCandidates(s.from, candidates);

        const firstBySig = new Map<string, Alias>();
        const dropped = new Map<string, Alias>(); // dropped alias key → kept alias
        for (const c of candidates) {
            const kept = firstBySig.get(c.sig);
            if (kept == undefined)
                firstBySig.set(c.sig, c.alias);
            else
                dropped.set(c.alias.toString(), kept);
        }
        if (dropped.size === 0)
            return s;

        const remap = new AliasRemapper(dropped);
        const from = rebuildFrom(s.from, dropped, remap);
        return new SelectExpression(
            s.alias, s.isDistinct,
            s.top == undefined ? undefined : remap.visit(s.top),
            s.columns.map(c => new ColumnDeclaration(c.name, remap.visit(c.expression))),
            from,
            s.where == undefined ? undefined : remap.visit(s.where),
            s.orderBy.map(o => new OrderExpression(o.orderType, remap.visit(o.expression))),
            s.groupBy.map(g => remap.visit(g)),
            s.selectOptions,
            s.offset == undefined ? undefined : remap.visit(s.offset),
        );
    }
}

// The FK/owner column of an `owner.fk == joined.pk` completion condition (the side NOT on the joined
// table's alias), or undefined if the condition isn't that shape.
function ownerOf(condition: Expression, joinedAlias: Alias): Expression | undefined {
    if (!(condition instanceof BinaryExpression) || condition.kind !== "==")
        return undefined;
    const l = condition.left, r = condition.right;
    if (l instanceof ColumnExpression && l.alias.equals(joinedAlias))
        return r;
    if (r instanceof ColumnExpression && r.alias.equals(joinedAlias))
        return l;
    return undefined;
}

function collectCandidates(source: SourceExpression, out: { alias: Alias; sig: string }[]): void {
    if (!(source instanceof JoinExpression))
        return;
    collectCandidates(source.left, out);
    if (source.joinType === "SingleRowLeftOuterJoin" && source.right instanceof TableExpression && source.condition != undefined) {
        const alias = source.right.alias;
        const owner = ownerOf(source.condition, alias);
        if (owner != undefined)
            out.push({ alias, sig: source.right.table.name.name + "|" + owner.toString() });
    }
}

// Rebuild the join chain, dropping the merged joins and remapping the conditions of the kept ones
// (a later join's FK may live on a dropped table).
function rebuildFrom(source: SourceExpression, dropped: Map<string, Alias>, remap: AliasRemapper): SourceExpression {
    if (!(source instanceof JoinExpression))
        return source;
    const left = rebuildFrom(source.left, dropped, remap);
    if (source.right instanceof TableExpression && dropped.has(source.right.alias.toString()))
        return left; // this join was merged into an identical earlier one
    const condition = source.condition == undefined ? undefined : remap.visit(source.condition);
    if (left === source.left && condition === source.condition)
        return source;
    return new JoinExpression(source.joinType, left, source.right, condition);
}

// Rewrites ColumnExpressions on a dropped join alias to the kept alias.
class AliasRemapper extends DbExpressionVisitor {
    constructor(private readonly map: Map<string, Alias>) { super(); }
    override visitColumn(column: ColumnExpression): Expression {
        const kept = this.map.get(column.alias.toString());
        return kept != undefined ? new ColumnExpression(column.type, kept, column.name) : column;
    }
}
