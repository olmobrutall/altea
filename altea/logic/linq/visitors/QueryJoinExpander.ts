import { Expression } from "../expressions";
import {
    SourceExpression, SelectExpression, JoinExpression, TableExpression,
    ProjectionExpression,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's QueryJoinExpander (the second half of entity completion). The
// QueryBinder records, per source, the implicit joins that a navigation needs
// (see `QueryBinder.completed`); this pass walks the bound tree and, after
// visiting each source, splices those joins in around it.
//
// Two request kinds are modelled: TableRequest (a single-row LEFT OUTER JOIN to a
// referenced table — single-reference navigation) and UnionRequest (the @implementedBy
// UNION combine strategy — a UNION ALL sub-select joined once). UniqueRequest (apply)
// is folded into the collection tiers elsewhere.

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

export type ExpansionRequest = TableRequest | UnionRequest;

function isUnionRequest(r: ExpansionRequest): r is UnionRequest {
    return (r as UnionRequest).union != null;
}

export class QueryJoinExpander extends DbExpressionVisitor {
    constructor(private readonly requests: ReadonlyMap<SourceExpression, readonly ExpansionRequest[]>) {
        super();
    }

    static expand(expression: Expression, requests: ReadonlyMap<SourceExpression, readonly ExpansionRequest[]>): Expression {
        if (requests.size === 0)
            return expression;
        return new QueryJoinExpander(requests).visit(expression);
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
        for (const r of expansions)
            result = isUnionRequest(r)
                ? r.union.buildJoin(result)
                : new JoinExpression("SingleRowLeftOuterJoin", result, r.table, r.condition);
        return result;
    }
}
