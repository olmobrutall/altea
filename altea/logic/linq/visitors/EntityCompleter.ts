import { Expression } from "../expressions";
import {
    ProjectionExpression, SelectExpression, LiteReferenceExpression, EntityExpression,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";
import type { QueryBinder } from "./QueryBinder";

// Port of Signum's EntityCompleter — the pass that, over the bound projector,
// fills the eager model (`toStr`) of projected lites. The decisive structural piece
// (which a naive in-place fill misses) is `visitProjection`: it ALWAYS wraps the
// projection in a fresh enclosing select whose FROM is the original select, then
// re-projects. So a lite's completion join — registered against the original (inner)
// select — is spliced by QueryJoinExpander as a SIBLING of that inner select under
// the new outer select, never turning the top projection itself into a join. The
// completed `toStr` column then lives at an alias visible to the outer select.
//
// Scope vs. Signum: conservative. `visitEntity` is a no-op (altea keeps single entity
// references lazy/stubbed on retrieve and does not eager-complete them here), so only
// *directly-projected* lites get an eager model; lites buried inside a materialised
// entity's bindings keep an empty/lazy model. ExpandLite hints and IBA-lite models are
// not wired yet (entityToStringOf returns undefined for those → the lite is unchanged).
export class EntityCompleter extends DbExpressionVisitor {
    constructor(private readonly binder: QueryBinder) {
        super();
    }

    static complete(expr: Expression, binder: QueryBinder): Expression {
        return new EntityCompleter(binder).visit(expr);
    }

    override visitEntity(ee: EntityExpression): Expression {
        return ee;
    }

    override visitLiteReference(lite: LiteReferenceExpression): Expression {
        if (lite.toStr != null)
            return lite;
        const model = this.binder.liteModelExpression(lite.reference);
        return model == null ? lite : new LiteReferenceExpression(lite.type, lite.reference, model);
    }

    override visitProjection(proj: ProjectionExpression): Expression {
        const projector = this.binder.runWithSource(proj.select, () => this.visit(proj.projector));
        if (projector === proj.projector)
            return proj;

        const alias = this.binder.aliases.nextSelectAlias();
        const pc = this.binder.splitColumns(projector, alias);
        const select = new SelectExpression(alias, false, undefined, pc.columns, proj.select, undefined, [], []);
        return new ProjectionExpression(select, pc.projector, proj.uniqueFunction, proj.type);
    }
}
