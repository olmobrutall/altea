import { Expression } from "../expressions";
import {
    ProjectionExpression, SelectExpression, LiteReferenceExpression, LiteValueExpression, EntityExpression,
    ImplementedByExpression, FieldBinding, MixinEntityExpression, PrimaryKeyExpression, FieldEntityArrayExpression,
} from "../expressions.sql";
import type { Table } from "../../schema/table";
import { DbExpressionVisitor } from "./DbExpressionVisitor";
import type { QueryBinder } from "./QueryBinder";
import { isCachedType } from "../../cache";
import type { Entity } from "../../../entities/entity";

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
        // Cycle / opt-out / cached: keep a lazy stub (no bindings), like Signum. A cache-
        // controlled type (isCached, Signum's EntityCompleter.IsCached) is likewise left
        // un-expanded — the cache fills the reference, so it must not be joined in SQL.
        // `avoidExpandOnRetrieving` rides on the reference EntityExpression (set from the
        // FK field's flag in bindField).
        if (this.previousTables.includes(ee.table) || ee.avoidExpandOnRetrieving || this.isCached(ee))
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

    // Signum's EntityCompleter.IsCached: the entity's type is cache-controlled (and enabled),
    // so its references stay id-only stubs instead of being expanded/joined in the query.
    private isCached(ee: EntityExpression): boolean {
        const ctor = ee.table.type;
        return typeof ctor === "function" && isCachedType(ctor as new () => Entity);
    }

    override visitLiteReference(lite: LiteReferenceExpression): Expression {
        // Signum's EntityCompleter.VisitLiteReference: reduce the lite to a
        // LiteValueExpression carrying only its identity (typeId + id) and display
        // string, DROPPING the wrapped entity's field bindings. Computing the toStr
        // model against the still-intact reference is what completes it (its ToStr
        // column / navigation join); after that the bindings are no longer referenced,
        // so a lite over a fully-retrieved root entity projects just id + type + toStr
        // rather than every column of the entity.
        const reference = lite.reference;
        const typeId = this.binder.liteTypeId(reference);
        const id = this.binder.liteId(reference);
        // ExpandLite hint (Signum's ExpandLite): ModelNull / ModelLazy don't eager-load the
        // display model (no toStr column selected — lazy is loaded later, null stays null); the
        // default (ModelEager / EntityEager / unset) computes it. (Full-entity-in-lite for
        // EntityEager isn't modelled yet, so it behaves like ModelEager.)
        if (lite.expandLite === "ModelNull" || lite.expandLite === "ModelLazy")
            return new LiteValueExpression(lite.type, typeId, id, undefined, undefined);
        // An @implementedBy reference keeps a per-implementation model map (Signum's
        // GetModels) instead of one combined CASE, so the polymorphic display string is
        // dispatched by type in the reader — never a CASE in the projector.
        if (reference instanceof ImplementedByExpression && lite.toStr == null) {
            const models = this.binder.liteImplementationModels(reference);
            return new LiteValueExpression(lite.type, typeId, id, undefined, models);
        }
        const toStr = lite.toStr ?? this.binder.liteModelExpression(reference);
        return new LiteValueExpression(lite.type, typeId, id, toStr ?? undefined);
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
