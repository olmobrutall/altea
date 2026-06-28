import {
    Expression, CallExpression, PropertyExpression, ParameterExpression,
    LambdaExpression, ConstantExpression,
} from "../expressions";
import {
    SelectExpression, ProjectionExpression, ColumnExpression, PrimaryKeyExpression,
    FieldBinding, EntityExpression, EmbeddedEntityExpression, MixinEntityExpression,
    SqlConstantExpression, TableExpression,
} from "../expressions.sql";
import { AliasGenerator, Alias } from "../AliasGenerator";
import { projectColumns } from "./ColumnProjector";
import type { Schema } from "../../schema/schema";
import type { Table } from "../../schema/table";
import type { EntityField } from "../../schema/field";
import {
    FieldPrimaryKey, FieldValue, FieldReference, FieldEnum, FieldEmbedded,
} from "../../schema/field";
import type { FieldInfo } from "../../../entities/reflection";
import { resolveType } from "../../../entities/registration";
import { ArrayType, ClassType, LiteralType, Type } from "../../../entities/types";
import { ExpressionVisitor } from "./ExpressionVisitor";

// Adapted port of Signum's QueryBinder. Input is altea's source Expression AST
// (a CallExpression chain over `table(T)`); output is a DbExpression tree
// (ProjectionExpression). This is the SKELETON: it binds the table source plus
// `filter` (Where) and `map` (Select). Other operators and full navigation/JOIN
// expansion land in later steps.

export class QueryBinder extends ExpressionVisitor {
    private readonly aliasGenerator: AliasGenerator;
    private readonly map = new Map<ParameterExpression, Expression>();

    constructor(
        private readonly schema: Schema,
        isPostgres: boolean,
    ) {
        super();
        this.aliasGenerator = new AliasGenerator(isPostgres);
    }

    bindQuery(expr: Expression): ProjectionExpression {
        const result = this.visit(expr);
        if (!(result instanceof ProjectionExpression))
            throw new Error("Query did not bind to a ProjectionExpression: " + result.toString());
        return result;
    }

    override visitCall(call: CallExpression): Expression {
        const func = call.func;

        // table(T) source: a constant call on the marked `table` function.
        if (func instanceof ConstantExpression && (func.value as { __isQuerySource?: boolean })?.__isQuerySource) {
            const ctor = (call.args[0] as ConstantExpression).value as new () => object;
            return this.getTableProjection(ctor);
        }

        // Query operator: <source>.<op>(...args)
        if (func instanceof PropertyExpression) {
            const op = func.propertyName;
            const source = this.visit(func.object);
            if (!(source instanceof ProjectionExpression))
                throw new Error(`Operator '${op}' applied to a non-query: ${source.toString()}`);

            switch (op) {
                case "filter":
                    return this.bindWhere(source, call.args[0] as LambdaExpression);
                case "map":
                    return this.bindSelect(source, call.args[0] as LambdaExpression);
                default:
                    throw new Error(`Query operator '${op}' is not implemented in the binder skeleton yet`);
            }
        }

        throw new Error("Unexpected call in query: " + call.toString());
    }

    // ---- operators --------------------------------------------------------

    private bindWhere(projection: ProjectionExpression, predicate: LambdaExpression): ProjectionExpression {
        const where = this.mapVisitExpand(predicate, projection);
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, projection.select, where, [], []),
            pc.projector, undefined, projection.type);
    }

    private bindSelect(projection: ProjectionExpression, selector: LambdaExpression): ProjectionExpression {
        const expression = this.mapVisitExpand(selector, projection);
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(expression, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, projection.select, undefined, [], []),
            pc.projector, undefined, new ArrayType(expression.type));
    }

    // Binds a lambda body with its single parameter mapped to the source's
    // projector (Signum's MapVisitExpand).
    private mapVisitExpand(lambda: LambdaExpression, projection: ProjectionExpression): Expression {
        const param = lambda.parameters[0];
        const old = this.map.get(param);
        this.map.set(param, projection.projector);
        const result = this.visit(lambda.body);
        if (old == null)
            this.map.delete(param);
        else
            this.map.set(param, old);
        return result;
    }

    // ---- member access ----------------------------------------------------

    private bindMemberAccess(pe: PropertyExpression): Expression {
        const obj = this.visit(pe.object);
        const name = pe.propertyName;

        if (obj instanceof EntityExpression) {
            if (name === "id")
                return obj.externalId;
            if (obj.bindings == null)
                throw new Error(`Navigation through '${name}' requires entity completion (JOIN) — not in the binder skeleton yet`);
            return this.findBinding(obj.bindings, name, obj.type);
        }
        if (obj instanceof EmbeddedEntityExpression)
            return this.findBinding(obj.bindings, name, obj.type);
        if (obj instanceof MixinEntityExpression)
            return this.findBinding(obj.bindings, name, obj.type);

        // Property on a plain constant (captured value) — keep as a source node.
        if (obj instanceof ConstantExpression)
            return new PropertyExpression(obj, name, pe.isOptionalChaining);

        throw new Error(`Cannot bind member '${name}' on ${obj.toString()}`);
    }

    private findBinding(bindings: readonly FieldBinding[], name: string, ownerType: Type): Expression {
        const fb = bindings.find(b => b.fieldInfo.name === name);
        if (fb == null)
            throw new Error(`Field '${name}' not found on ${ownerType.toString()}`);
        return fb.binding;
    }

    // ---- table source -----------------------------------------------------

    private getTableProjection(ctor: new () => object): ProjectionExpression {
        const table = this.schema.table(ctor as any);
        const tableAlias = this.aliasGenerator.nextTableAlias(table.name.name);
        const entity = this.createEntityExpression(table, tableAlias);

        const tableExpr = new TableExpression(tableAlias, table);
        const selectAlias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(entity, selectAlias);

        return new ProjectionExpression(
            new SelectExpression(selectAlias, false, undefined, pc.columns, tableExpr, undefined, [], []),
            pc.projector, undefined, new ArrayType(new ClassType(ctor)));
    }

    // Builds the EntityExpression for a table: id → externalId, value/enum → a
    // column, embedded → inlined EmbeddedEntityExpression, single reference → a
    // lazy EntityExpression (completed on navigation, step 5). ImplementedBy*,
    // collections (FieldEntityArray) are skipped for now.
    private createEntityExpression(table: Table, alias: Alias): EntityExpression {
        const idColumn = table.primaryKey.column;
        const externalId = new PrimaryKeyExpression(new ColumnExpression(LiteralType.number, alias, idColumn.name));

        const bindings: FieldBinding[] = [];
        for (const ef of Object.values(table.fields)) {
            if (ef.field instanceof FieldPrimaryKey)
                continue;
            const binding = this.bindField(ef, alias);
            if (binding != null)
                bindings.push(new FieldBinding(ef.fieldInfo, binding));
        }

        const mixins: MixinEntityExpression[] = [];
        for (const fm of Object.values(table.mixins)) {
            const mixinBindings: FieldBinding[] = [];
            for (const ef of Object.values(fm.fields)) {
                const binding = this.bindField(ef, alias);
                if (binding != null)
                    mixinBindings.push(new FieldBinding(ef.fieldInfo, binding));
            }
            // The mixin's own type is not directly available here; reuse the
            // owner type as a placeholder (mixin typing refined later).
            mixins.push(new MixinEntityExpression(new ClassType(table.type as any), mixinBindings, alias));
        }

        return new EntityExpression(
            new ClassType(table.type as any), table, externalId, alias, bindings,
            mixins.length ? mixins : undefined, false);
    }

    private bindField(ef: EntityField, alias: Alias): Expression | undefined {
        const f = ef.field;

        // FieldEnum extends FieldReference — check before FieldReference. Stored
        // as its numeric value, so treat like a value column.
        if (f instanceof FieldEnum)
            return new ColumnExpression(LiteralType.number, alias, f.column.name);

        if (f instanceof FieldValue) // includes FieldTicks
            return new ColumnExpression(this.valueType(ef.fieldInfo), alias, f.column.name);

        if (f instanceof FieldReference) {
            // Lazy single reference: an EntityExpression whose id is the FK column;
            // bindings stay undefined until a navigation completes it.
            const refTable = f.column.referenceTable!;
            const externalId = new PrimaryKeyExpression(new ColumnExpression(LiteralType.number, alias, f.column.name));
            return new EntityExpression(new ClassType(refTable.type as any), refTable, externalId, undefined, undefined, undefined, false);
        }

        if (f instanceof FieldEmbedded) {
            const hasValue: Expression = f.hasValue != null
                ? new ColumnExpression(LiteralType.boolean, alias, f.hasValue.name)
                : new SqlConstantExpression(true, LiteralType.boolean);
            const subBindings: FieldBinding[] = [];
            for (const sub of Object.values(f.embeddedFields)) {
                const b = this.bindField(sub, alias);
                if (b != null)
                    subBindings.push(new FieldBinding(sub.fieldInfo, b));
            }
            // Resolve the embedded's ctor from the field's type name so the reader
            // can construct it.
            const embCtor = resolveType(ef.fieldInfo.typeName);
            const embType: Type = embCtor != null ? new ClassType(embCtor) : LiteralType.null;
            return new EmbeddedEntityExpression(embType, hasValue, subBindings, undefined);
        }

        // FieldImplementedBy / FieldImplementedByAll / FieldEntityArray: deferred.
        return undefined;
    }

    private valueType(fi: FieldInfo): Type {
        switch (fi.typeName) {
            case "string": return LiteralType.string;
            case "number": return LiteralType.number;
            case "boolean": return LiteralType.boolean;
            default: return LiteralType.null; // temporal/enum/etc. — refined later
        }
    }
}
