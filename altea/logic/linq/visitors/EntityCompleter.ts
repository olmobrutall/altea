import { Expression } from "../expressions";
import {
    ProjectionExpression, SelectExpression, LiteReferenceExpression, EntityExpression,
    FieldBinding, MixinEntityExpression, PrimaryKeyExpression, FieldEntityArrayExpression,
} from "../expressions.sql";
import type { Table } from "../../schema/table";
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
// `visitEntity` eager-completes a retrieved entity's references (Signum's VisitEntity):
// each single reference is joined (`binder.completeEntity`) and its bindings recursed
// into, so the whole graph loads in one query instead of lazily per navigation. A
// `previousTypes` stack (by table identity) breaks reference cycles — a self/back
// reference already on the stack stays a lazy stub, exactly like Signum. Lites break
// cycles naturally (they are not expanded to entities). `avoidExpandOnRetrieving`
// entities are also left as stubs.
//
// `visitFieldEntityArray` eager-completes a retrieved entity's collections (Signum's
// VisitMList): each FieldEntityArray marker is realised into a correlated child
// projection and recursed into, so `entity.friends` / `.colaborators` / … load with the
// entity (as one extra query per level, spliced by ChildProjectionFlattener) rather than
// lazily. In altea, an entity array always implies an eager UI table, so eagerness is the
// rule; the same cycle guard bounds the cascade.
export class EntityCompleter extends DbExpressionVisitor {
    private readonly previousTables: Table[] = [];

    constructor(private readonly binder: QueryBinder) {
        super();
    }

    static complete(expr: Expression, binder: QueryBinder): Expression {
        return new EntityCompleter(binder).visit(expr);
    }

    override visitEntity(ee: EntityExpression): Expression {
        // Cycle / opt-out: keep a lazy stub (no bindings), like Signum. `avoidExpandOnRetrieving`
        // rides on the reference EntityExpression (set from the FK field's flag in bindField).
        if (this.previousTables.includes(ee.table) || ee.avoidExpandOnRetrieving)
            return new EntityExpression(ee.type, ee.table, ee.externalId, undefined, undefined, undefined, ee.avoidExpandOnRetrieving);

        const completed = this.binder.completeEntity(ee);
        this.previousTables.push(completed.table);
        try {
            const externalId = this.visit(completed.externalId) as PrimaryKeyExpression;
            const bindings = completed.bindings?.map(b => new FieldBinding(b.fieldInfo, this.visit(b.binding)));
            const mixins = completed.mixins?.map(m => this.visitMixinEntity(m) as MixinEntityExpression);
            return new EntityExpression(completed.type, completed.table, externalId, completed.tableAlias, bindings, mixins, completed.avoidExpandOnRetrieving);
        } finally {
            this.previousTables.pop();
        }
    }

    override visitLiteReference(lite: LiteReferenceExpression): Expression {
        if (lite.toStr != null)
            return lite;
        const model = this.binder.liteModelExpression(lite.reference);
        return model == null ? lite : new LiteReferenceExpression(lite.type, lite.reference, model);
    }

    // Eager-load a collection binding (Signum's VisitMList): realise the marker into a
    // correlated child projection and recurse, so the element entities' own references and
    // collections expand too. The result is a nested ProjectionExpression in the entity
    // binding, which ChildProjectionFlattener later turns into one child query per level.
    // Cycles are broken by visitEntity's `previousTables` guard when the element expands.
    override visitFieldEntityArray(fea: FieldEntityArrayExpression): Expression {
        const projection = this.binder.fieldEntityArrayProjection(fea);
        return this.visit(projection);
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
