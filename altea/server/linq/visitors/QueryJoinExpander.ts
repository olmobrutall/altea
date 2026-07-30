import { Expression } from "../expressions";
import {
    SourceExpression, SelectExpression, JoinExpression, TableExpression,
    ProjectionExpression, SourceWithAliasExpression, UpdateExpression,
    InsertSelectExpression, ColumnDeclaration,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";
import { AliasGenerator } from "../aliasGenerator";

// Port of Signum's QueryJoinExpander (the second half of entity completion). The
// QueryBinder records, per source, the implicit joins that a navigation needs
// (see `QueryBinder.completed`); this pass walks the bound tree and, after
// visiting each source, splices those joins in around it.
//
// Three request kinds are modelled: TableRequest (a single-row LEFT OUTER JOIN to a
// referenced table — single-reference navigation), UnionRequest (the @implementedBy
// UNION combine strategy — a UNION ALL sub-select joined once), and UniqueRequest (a
// CROSS/OUTER APPLY of a single-row subquery — a `first()/single(...)` used inside a
// projector or predicate, whose element stays navigable).

// A pending join: LEFT OUTER JOIN `table` ON `condition`. The condition links the
// owner's FK column to the joined table's primary key (built in the binder).
export interface TableRequest {
    readonly table: TableExpression;
    readonly condition: Expression;
}

// A pending UNION-combine join: the binder's UnionAllRequest knows how to splice
// itself in around a source (build the per-implementation UNION ALL sub-select and
// the SingleRow LEFT OUTER JOIN). Kept behind this interface so QueryJoinExpander
// stays independent of the binder internals that build it.
export interface UnionRequest {
    readonly union: { buildJoin(source: SourceExpression): SourceExpression };
}

// A pending correlated APPLY (Signum's UniqueRequest): a `first()/single(...)` used
// inside a projector/predicate becomes a CROSS APPLY (First/Single) or OUTER APPLY
// (FirstOrDefault/SingleOrDefault) of the single-row `select`, whose (navigable)
// projector was returned to the binding site in place of the terminal.
export interface UniqueRequest {
    readonly select: SelectExpression;
    readonly outerApply: boolean;
}

export type ExpansionRequest = TableRequest | UnionRequest | UniqueRequest;

function isUnionRequest(r: ExpansionRequest): r is UnionRequest {
    return (r as UnionRequest).union != null;
}

function isUniqueRequest(r: ExpansionRequest): r is UniqueRequest {
    return (r as UniqueRequest).select != null;
}

export class QueryJoinExpander extends DbExpressionVisitor {
    constructor(
        private readonly requests: ReadonlyMap<SourceExpression, readonly ExpansionRequest[]>,
        private readonly aliasGenerator?: AliasGenerator,
    ) {
        super();
    }

    static expand(expression: Expression, requests: ReadonlyMap<SourceExpression, readonly ExpansionRequest[]>, aliasGenerator?: AliasGenerator): Expression {
        if (requests.size === 0)
            return expression;
        return new QueryJoinExpander(requests, aliasGenerator).visit(expression);
    }

    // A command's source (Signum's VisitUpdate/VisitInsertSelect): when join expansion
    // turns the source into a JoinExpression, the UPDATE/INSERT source slot needs a
    // SourceWithAliasExpression, so wrap the join in a fresh (empty-column) SELECT — the
    // QueryRebinder fills its columns and UnusedColumnRemover prunes them. Without this the
    // base visitor casts the join to SourceWithAlias and emits an unbindable command.
    override visitUpdate(update: UpdateExpression): Expression {
        const source = this.visitSource(update.source);
        const where = this.visit(update.where);
        const assignments = this.visitArray(update.assignments, a => this.visitColumnAssignment(a));
        if (source === update.source && where === update.where && assignments === update.assignments)
            return update;
        const select = source instanceof SourceWithAliasExpression ? source : this.wrapSelect(source);
        return new UpdateExpression(update.table, select, where, assignments, update.returnRowCount);
    }

    override visitInsertSelect(insert: InsertSelectExpression): Expression {
        const source = this.visitSource(insert.source);
        const assignments = this.visitArray(insert.assignments, a => this.visitColumnAssignment(a));
        if (source === insert.source && assignments === insert.assignments)
            return insert;
        const select = source instanceof SourceWithAliasExpression ? source : this.wrapSelect(source);
        return new InsertSelectExpression(insert.table, select, assignments, insert.returnRowCount);
    }

    // Signum's WrapSelect: an empty-column pass-through SELECT over `source`; the columns
    // are backfilled by the later Rebinder pass and pruned by UnusedColumnRemover.
    private wrapSelect(source: SourceExpression): SelectExpression {
        if (this.aliasGenerator == null)
            throw new Error("QueryJoinExpander needs an alias generator to wrap a command source in a SELECT");
        const alias = this.aliasGenerator.nextSelectAlias();
        return new SelectExpression(alias, false, undefined, [] as ColumnDeclaration[], source, undefined, [], []);
    }

    // Match Signum: visit the projection's select through visitSource so a
    // request registered against the outermost source is still honoured.
    override visitProjection(proj: ProjectionExpression): Expression {
        const source = this.visitSource(proj.select);
        const projector = this.visit(proj.projector);
        if (source === proj.select && projector === proj.projector)
            return proj;
        if (source instanceof SelectExpression)
            return new ProjectionExpression(source, projector, proj.uniqueFunction, proj.type);
        // A request on the very top source would make it a Join; the binder never
        // produces that today, so treat it as unreachable rather than re-wrapping.
        throw new Error("Join expansion produced a non-Select projection source");
    }

    protected override visitSource(source: SourceExpression): SourceExpression {
        const reqs = this.requests.get(source);
        const result = super.visitSource(source);
        if (reqs == null || reqs.length === 0)
            return result;
        return this.applyExpansions(result, reqs);
    }

    private applyExpansions(source: SourceExpression, expansions: readonly ExpansionRequest[]): SourceExpression {
        let result = source;
        for (const r of expansions) {
            if (isUnionRequest(r)) {
                result = r.union.buildJoin(result);
            } else if (isUniqueRequest(r)) {
                // Signum's UniqueRequest branch: VisitSource(ur.Select) so nested
                // expansions inside the subquery are spliced, then CROSS/OUTER APPLY it.
                const newSelect = this.visitSource(r.select);
                result = new JoinExpression(r.outerApply ? "OuterApply" : "CrossApply", result, newSelect, undefined);
            } else {
                result = new JoinExpression("SingleRowLeftOuterJoin", result, r.table, r.condition);
            }
        }
        return result;
    }
}
