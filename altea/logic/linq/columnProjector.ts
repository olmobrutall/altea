import { Expression } from "../expressions";
import { ColumnExpression, ColumnDeclaration } from "../expressions.sql";
import { Alias } from "./aliasGenerator";
import { DbExpressionVisitor } from "./dbExpressionVisitor";
import { nominate } from "./dbExpressionNominator";

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

class ColumnGenerator {
    private readonly columns = new Map<string, ColumnDeclaration>();
    private iColumn = 0;

    get declarations(): ColumnDeclaration[] {
        return [...this.columns.values()];
    }

    private getUniqueColumnName(name: string): string {
        let candidate = name;
        let suffix = 1;
        while (this.columns.has(candidate.toLowerCase()))
            candidate = name + (suffix++);
        return candidate;
    }

    private getNextColumnName(): string {
        return this.getUniqueColumnName("c" + (this.iColumn++));
    }

    mapColumn(ce: ColumnExpression): ColumnDeclaration {
        const name = this.getUniqueColumnName(ce.name ?? "c");
        const cd = new ColumnDeclaration(name, ce);
        this.columns.set(name.toLowerCase(), cd);
        return cd;
    }

    newColumn(exp: Expression): ColumnDeclaration {
        const name = this.getNextColumnName();
        const cd = new ColumnDeclaration(name, exp);
        this.columns.set(name.toLowerCase(), cd);
        return cd;
    }
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
