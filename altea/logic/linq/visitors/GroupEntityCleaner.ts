import { Expression } from "../expressions";
import { EntityExpression, PrimaryKeyExpression } from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's GroupEntityCleaner
// (Engine/Linq/ExpressionVisitor/GroupEntityCleaner.cs), scoped to what altea
// models.
//
// When a group key is a whole entity (or a reference to one), grouping must be by
// its identity — its id column — not by every field the EntityExpression carries.
// This visitor strips an EntityExpression down to just its `externalId`, so the
// group key projects/groups by the id and the reader stubs the entity back from
// it. A Lite / ImplementedBy* key is reached through the base traversal, which
// recurses into the wrapped reference and cleans it the same way.
//
// Not ported (no altea API yet): the `Type`/GetType key path (VisitType →
// TypeImplementedByAll) and the entity-coalesce/conditional combine cases.
export class GroupEntityCleaner extends DbExpressionVisitor {
    static clean(source: Expression): Expression {
        return new GroupEntityCleaner().visit(source);
    }

    override visitEntity(entity: EntityExpression): Expression {
        const externalId = this.visit(entity.externalId) as PrimaryKeyExpression;
        // Drop bindings/mixins/tableAlias — group by id only.
        return new EntityExpression(
            entity.type, entity.table, externalId, undefined, undefined, undefined,
            entity.avoidExpandOnRetrieving);
    }
}
