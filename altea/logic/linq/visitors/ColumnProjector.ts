import { Expression } from "../expressions";
import { ColumnExpression, ColumnDeclaration, ProjectionExpression, ChildProjectionExpression } from "../expressions.sql";
import { Alias } from "../AliasGenerator";
import { DbExpressionVisitor } from "./DbExpressionVisitor";
import { nominate } from "../dbExpressionNominator";
import { ColumnGenerator } from "../ColumnGenerator";

// Port of Signum's ColumnProjector (+ ColumnGenerator / ProjectedColumns). Splits
// a projector expression into (a) the SELECT-list column declarations that must
// run on the server and (b) a rewritten projector that reads those columns back
// from the new select alias. Unlike Signum we always materialise trivial columns
// (no projectTrivialColumns optimisation yet) — simpler and correct; the
// UnusedColumnRemover/RedundantSubqueryRemover passes prune later.

export interface ProjectedColumns {
    readonly projector: Expression;
    readonly columns: readonly ColumnDeclaration[];
}


class ColumnProjector extends DbExpressionVisitor {
    private readonly generator = new ColumnGenerator();
    private readonly map = new Map<ColumnExpression, ColumnExpression>();

    constructor(
        private readonly candidates: Set<Expression>,
        private readonly newAlias: Alias,
    ) {
        super();
    }

    get columns(): readonly ColumnDeclaration[] {
        return this.generator.declarations;
    }

    override visit(e: Expression): Expression;
    override visit(e: Expression | undefined): Expression | undefined;
    override visit(e: Expression | undefined): Expression | undefined {
        if (e == null)
            return undefined;

        // A nested (child) projection is its own scope — its columns reference its
        // own aliases. Keep it opaque here; ChildProjectionFlattener extracts it.
        if (e instanceof ProjectionExpression || e instanceof ChildProjectionExpression)
            return e;

        if (this.candidates.has(e)) {
            if (e instanceof ColumnExpression) {
                const existing = this.map.get(e);
                if (existing != null)
                    return existing;
                const mapped = this.generator.mapColumn(e).getReference(this.newAlias);
                this.map.set(e, mapped);
                return mapped;
            }
            // A computed server expression → declare it and reference it back.
            return this.generator.newColumn(e).getReference(this.newAlias);
        }

        return super.visit(e);
    }
}

export function projectColumns(projector: Expression, newAlias: Alias): ProjectedColumns {
    const candidates = nominate(projector);
    const cp = new ColumnProjector(candidates, newAlias);
    const proj = cp.visit(projector);
    return { projector: proj, columns: cp.columns };
}


