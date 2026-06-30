import { Expression } from "../expressions";
import {
    EntityExpression, PrimaryKeyExpression,
    TypeEntityExpression, TypeImplementedByExpression, TypeImplementedByAllExpression,
    CaseExpression, When, IsNotNullExpression, SqlConstantExpression,
} from "../expressions.sql";
import { DbExpressionVisitor } from "./DbExpressionVisitor";
import { TypeLogic } from "../../typeLogic";
import { ClassType, LiteralType } from "../../../entities/types";

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
// Grouping by a runtime type (`groupBy(f => f.GetType())`) must group by the type
// *discriminator*, not the entity ids. A typed TypeEntity / TypeImplementedBy key
// is reduced to a TypeImplementedByAll over a CASE that yields the TypeEntity int
// id (the same discriminator @implementedByAll stores), so the GROUP BY and
// the materialised key agree. A TypeImplementedByAll key already is that
// discriminator column, so the base traversal handles it.
// Not ported (no altea API yet): the entity-coalesce/conditional combine cases.
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

    override visitTypeEntity(t: TypeEntityExpression): Expression {
        const ctor = t.typeValue instanceof ClassType ? t.typeValue.constructorFunction : undefined;
        if (ctor == null) return t;
        const disc = new CaseExpression(
            [new When(new IsNotNullExpression(t.externalId.value), new SqlConstantExpression(TypeLogic.typeToId(ctor), LiteralType.number))],
            new SqlConstantExpression(null, LiteralType.null));
        return new TypeImplementedByAllExpression(disc);
    }

    override visitTypeImplementedBy(t: TypeImplementedByExpression): Expression {
        const whens = [...t.typeImplementations].map(([ctor, id]) =>
            new When(new IsNotNullExpression(id.value), new SqlConstantExpression(TypeLogic.typeToId(ctor), LiteralType.number)));
        const disc = new CaseExpression(whens, new SqlConstantExpression(null, LiteralType.null));
        return new TypeImplementedByAllExpression(disc);
    }
}
