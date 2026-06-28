import {
    Expression, CallExpression, PropertyExpression, ParameterExpression,
    LambdaExpression, ConstantExpression, CastExpression,
} from "../expressions";
import {
    SelectExpression, ProjectionExpression, ColumnExpression, PrimaryKeyExpression,
    FieldBinding, EntityExpression, EmbeddedEntityExpression, MixinEntityExpression,
    SqlConstantExpression, TableExpression, OrderExpression, OrderType, UniqueFunction,
    AggregateExpression, AggregateSqlFunction, ColumnDeclaration, LikeExpression, InExpression,
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
    private thenBys: OrderExpression[] | undefined;

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
        if (func instanceof PropertyExpression || func.kind === ".") {
            const property = func as PropertyExpression;
            const op = property.propertyName;
            if (op === "thenBy")
                return this.bindThenBy(property.object, call.args[0] as LambdaExpression, "Ascending");
            if (op === "thenByDescending")
                return this.bindThenBy(property.object, call.args[0] as LambdaExpression, "Descending");

            const source = this.visit(property.object);
            if (!(source instanceof ProjectionExpression))
                return this.bindMethodCall(op, source, call.args);

            switch (op) {
                case "filter":
                    return this.bindWhere(source, call.args[0] as LambdaExpression);
                case "map":
                    return this.bindSelect(source, call.args[0] as LambdaExpression);
                case "orderBy":
                    return this.bindOrderBy(source, call.args[0] as LambdaExpression, "Ascending");
                case "orderByDescending":
                    return this.bindOrderBy(source, call.args[0] as LambdaExpression, "Descending");
                case "top":
                    return this.bindTop(source, call.args[0]);
                case "distinct":
                    return this.bindDistinct(source);
                case "first":
                    return this.bindUnique(source, "First", call.args[0] as LambdaExpression | undefined);
                case "firstOrNull":
                    return this.bindUnique(source, "FirstOrDefault", call.args[0] as LambdaExpression | undefined);
                case "single":
                    return this.bindUnique(source, "Single", call.args[0] as LambdaExpression | undefined);
                case "singleOrNull":
                    return this.bindUnique(source, "SingleOrDefault", call.args[0] as LambdaExpression | undefined);
                case "count":
                    return this.bindAggregate(source, "Count", call.args[0] as LambdaExpression | undefined);
                case "min":
                    return this.bindAggregate(source, "Min", call.args[0] as LambdaExpression | undefined);
                case "max":
                    return this.bindAggregate(source, "Max", call.args[0] as LambdaExpression | undefined);
                case "sum":
                    return this.bindAggregate(source, "Sum", call.args[0] as LambdaExpression | undefined);
                case "avg":
                    return this.bindAggregate(source, "Average", call.args[0] as LambdaExpression | undefined);
                default:
                    throw new Error(`Query operator '${op}' is not implemented in the binder skeleton yet`);
            }
        }

        if ((func instanceof CastExpression || func.kind === "as") && call.args.length === 0)
            return this.visit(func);

        throw new Error("Unexpected call in query: " + call.toString());
    }

    private bindMethodCall(methodName: string, source: Expression, args: readonly Expression[]): Expression {
        const visitedArgs = args.map(a => this.visit(a));

        if (methodName === "contains" && source instanceof ConstantExpression && Array.isArray(source.value) && visitedArgs.length === 1)
            return InExpression.fromValues(visitedArgs[0], source.value);

        if (methodName === "contains" && visitedArgs.length === 1)
            return new LikeExpression(source, this.likePattern("%", visitedArgs[0], "%"));

        if (methodName === "startsWith" && visitedArgs.length === 1)
            return new LikeExpression(source, this.likePattern("", visitedArgs[0], "%"));

        if (methodName === "endsWith" && visitedArgs.length === 1)
            return new LikeExpression(source, this.likePattern("%", visitedArgs[0], ""));

        throw new Error(`Method '${methodName}' is not implemented in the binder skeleton yet`);
    }

    private likePattern(prefix: string, expression: Expression, suffix: string): Expression {
        if (expression instanceof ConstantExpression && typeof expression.value === "string")
            return new ConstantExpression(`${prefix}${expression.value}${suffix}`);

        throw new Error("Non-constant LIKE patterns are not implemented yet");
    }

    override visitParameter(parameter: ParameterExpression): Expression {
        return this.map.get(parameter) ?? parameter;
    }

    override visitProperty(property: PropertyExpression): Expression {
        return this.bindMemberAccess(property);
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

    private bindOrderBy(projection: ProjectionExpression, selector: LambdaExpression, orderType: OrderType): ProjectionExpression {
        return this.bindOrderByCore(projection, selector, orderType, false);
    }

    private bindThenBy(source: Expression, selector: LambdaExpression, orderType: OrderType): Expression {
        this.thenBys ??= [];
        this.thenBys.push(new OrderExpression(orderType, selector));
        return this.visit(source);
    }

    private bindOrderByCore(projection: ProjectionExpression, selector: LambdaExpression, orderType: OrderType, append: boolean): ProjectionExpression {
        const myThenBys = this.thenBys;
        this.thenBys = undefined;

        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(projection.projector, alias);
        const orderBy = append ? [...projection.select.orderBy] : [];
        orderBy.push(new OrderExpression(orderType, this.mapVisitExpand(selector, projection)));

        if (myThenBys != null) {
            for (let i = myThenBys.length - 1; i >= 0; i--) {
                const thenBy = myThenBys[i];
                orderBy.push(new OrderExpression(thenBy.orderType, this.mapVisitExpand(thenBy.expression as LambdaExpression, projection)));
            }
        }

        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, projection.select, undefined, orderBy, []),
            pc.projector, projection.uniqueFunction, projection.type);
    }

    private bindTop(projection: ProjectionExpression, top: Expression): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, top, pc.columns, projection.select, undefined, [], []),
            pc.projector, projection.uniqueFunction, projection.type);
    }

    private bindDistinct(projection: ProjectionExpression): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, true, undefined, pc.columns, projection.select, undefined, [], []),
            pc.projector, undefined, projection.type);
    }

    private bindUnique(projection: ProjectionExpression, uniqueFunction: UniqueFunction, predicate: LambdaExpression | undefined): ProjectionExpression {
        if (predicate != null)
            projection = this.bindWhere(projection, predicate);

        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, uniqueFunction === "First" || uniqueFunction === "FirstOrDefault" ? new ConstantExpression(1) : undefined, pc.columns, projection.select, undefined, [], []),
            pc.projector, uniqueFunction, projection.type);
    }

    private bindAggregate(projection: ProjectionExpression, aggregateFunction: AggregateSqlFunction, selector: LambdaExpression | undefined): ProjectionExpression {
        if (aggregateFunction === "Count" && selector != null) {
            projection = this.bindWhere(projection, selector);
            selector = undefined;
        }

        const argument = selector == null ? projection.projector : this.mapVisitExpand(selector, projection);
        const aggregate = aggregateFunction === "Count"
            ? new AggregateExpression(LiteralType.number, aggregateFunction, [], undefined)
            : new AggregateExpression(argument.type, aggregateFunction, [argument], undefined);

        const alias = this.aliasGenerator.nextSelectAlias();
        const name = "c0";
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, [new ColumnDeclaration(name, aggregate)], projection.select, undefined, [], []),
            new ColumnExpression(aggregate.type, alias, name),
            "Single",
            aggregate.type);
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
