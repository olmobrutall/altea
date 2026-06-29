import {
    Expression, CallExpression, PropertyExpression, ParameterExpression,
    LambdaExpression, ConstantExpression, CastExpression, BinaryExpression,
} from "../expressions";
import {
    SelectExpression, ProjectionExpression, ColumnExpression, PrimaryKeyExpression,
    FieldBinding, EntityExpression, EmbeddedEntityExpression, MixinEntityExpression,
    SqlConstantExpression, TableExpression, OrderExpression, OrderType, UniqueFunction,
    AggregateExpression, AggregateSqlFunction, ColumnDeclaration, LikeExpression, InExpression,
    SourceExpression, SqlFunctionExpression, SelectOptions, FieldEntityArrayExpression, JoinExpression,
    LiteReferenceExpression,
} from "../expressions.sql";
import { AliasGenerator, Alias } from "../AliasGenerator";
import { projectColumns } from "./ColumnProjector";
import { QueryJoinExpander, TableRequest } from "./QueryJoinExpander";
import type { Schema } from "../../schema/schema";
import type { Table } from "../../schema/table";
import type { EntityField } from "../../schema/field";
import {
    FieldPrimaryKey, FieldValue, FieldReference, FieldEnum, FieldEmbedded, FieldEntityArray,
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

    // Entity completion (navigation → JOIN), ported from Signum's QueryBinder.
    // `requests` records, per source, the implicit joins a navigation needs;
    // `sourceStack` tracks the source a lambda body is being bound against (so a
    // completion attaches its join to the right SELECT); `entityReplacements`
    // dedupes the join when the same reference is navigated more than once.
    private readonly requests = new Map<SourceExpression, TableRequest[]>();
    private readonly sourceStack: SourceExpression[] = [];
    private readonly entityReplacements = new Map<EntityExpression, EntityExpression>();

    constructor(
        private readonly schema: Schema,
        private readonly isPostgres: boolean,
    ) {
        super();
        this.aliasGenerator = new AliasGenerator(isPostgres);
    }

    bindQuery(expr: Expression): ProjectionExpression {
        const result = this.visit(expr);
        if (!(result instanceof ProjectionExpression))
            throw new Error("Query did not bind to a ProjectionExpression: " + result.toString());
        // Splice in the implicit navigation joins recorded during binding.
        const expanded = QueryJoinExpander.expand(result, this.requests);
        if (!(expanded instanceof ProjectionExpression))
            throw new Error("Join expansion did not preserve the ProjectionExpression");
        return expanded;
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

            let source = this.visit(property.object);
            // A navigated collection (a.friends) realises into a correlated
            // sub-projection so the standard operators below apply to it directly.
            if (source instanceof FieldEntityArrayExpression)
                source = this.fieldEntityArrayProjection(source);
            if (!(source instanceof ProjectionExpression))
                return this.bindMethodCall(op, source, call.args);

            switch (op) {
                case "filter":
                    return this.bindWhere(source, call.args[0] as LambdaExpression);
                case "map":
                    return this.bindSelect(source, call.args[0] as LambdaExpression);
                case "flatMap":
                    return this.bindSelectMany(source, call.args[0] as LambdaExpression);
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
                case "reverse":
                    return this.bindReverse(source);
                case "last":
                    return this.bindLast(source, "First", call.args[0] as LambdaExpression | undefined);
                case "lastOrNull":
                    return this.bindLast(source, "FirstOrDefault", call.args[0] as LambdaExpression | undefined);
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
        // entity.toLite() → a Lite over that reference (Signum's BindToLite).
        if (methodName === "toLite" && source instanceof EntityExpression)
            return new LiteReferenceExpression(source.type, source, undefined);
        if (methodName === "toLite" && source instanceof LiteReferenceExpression)
            return source;

        // entity.is(x) / lite.is(x) → an id comparison, the server form of the
        // in-memory identity check. TODO: this single-column id equality only
        // covers typed references; polymorphic equality (ImplementedBy /
        // ImplementedByAll — which compare an id *and* a type, possibly across
        // several implementation columns) needs Signum's SmartEqualizer. Replace
        // `idOf` + this BinaryExpression with a SmartEqualizer call when that tier
        // lands.
        if (methodName === "is" && args.length === 1)
            return new BinaryExpression("==", this.idOf(source), this.idOf(this.visit(args[0])));

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

    // The id expression of an entity/lite/captured-reference, for `.is()` lowering.
    // Stopgap for typed references only — superseded by SmartEqualizer once
    // ImplementedBy/ImplementedByAll polymorphic equality is needed (see bindMethodCall).
    private idOf(e: Expression): Expression {
        if (e instanceof EntityExpression)
            return e.externalId.value;
        if (e instanceof LiteReferenceExpression)
            return e.reference.externalId.value;
        if (e instanceof PrimaryKeyExpression)
            return e.value;
        // A captured Entity/Lite constant → its id literal; otherwise assume the
        // value already is the id.
        if (e instanceof ConstantExpression) {
            const v = e.value as { id?: unknown } | null;
            return new ConstantExpression(v != null && typeof v === "object" && "id" in v ? v.id : e.value);
        }
        return e;
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

    // reverse() — Signum's BindReverse: wraps the source in a SELECT marked
    // SelectOptions.Reverse. The flag is resolved later by OrderByRewriter, which
    // inverts the gathered ORDER BY directions; this keeps the binder free of the
    // order-direction bookkeeping (no eager inversion here).
    private bindReverse(projection: ProjectionExpression): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, projection.select, undefined, [], [], SelectOptions.Reverse),
            pc.projector, undefined, projection.type);
    }

    // Last/LastOrDefault. Signum's OverloadingSimplifier rewrites them to
    // Reverse → (optional Where) → First/FirstOrDefault. The Reverse flag (not an
    // eager order inversion) is what OrderByRewriter consumes.
    private bindLast(source: ProjectionExpression, uniqueFunction: UniqueFunction, predicate: LambdaExpression | undefined): ProjectionExpression {
        const reversed = this.bindReverse(source);
        return this.bindUnique(reversed, uniqueFunction, predicate);
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
        // The source the lambda binds against — any navigation completed while
        // binding the body joins onto this select (see `completed`/`addRequest`).
        this.sourceStack.push(projection.select);
        try {
            return this.visit(lambda.body);
        } finally {
            this.sourceStack.pop();
            if (old == null)
                this.map.delete(param);
            else
                this.map.set(param, old);
        }
    }

    // ---- member access ----------------------------------------------------

    private bindMemberAccess(pe: PropertyExpression): Expression {
        const obj = this.visit(pe.object);
        const name = pe.propertyName;

        if (obj instanceof EntityExpression)
            return this.bindEntityMember(obj, name);

        // Navigating through a Lite: `.entity`/`.entityOrNull` unwrap to the
        // referenced entity, `.id` short-circuits to the FK column; any other
        // member navigates the entity behind the lite.
        if (obj instanceof LiteReferenceExpression) {
            if (name === "entity" || name === "entityOrNull")
                return obj.reference;
            if (name === "id")
                return obj.reference.externalId;
            return this.bindEntityMember(obj.reference, name);
        }

        if (obj instanceof EmbeddedEntityExpression)
            return this.findBinding(obj.bindings, name, obj.type);
        if (obj instanceof MixinEntityExpression)
            return this.findBinding(obj.bindings, name, obj.type);

        // string.length → SQL string-length function (Signum's string.Length).
        // LEN on SQL Server, length() on Postgres.
        if (name === "length" && obj.type === LiteralType.string)
            return new SqlFunctionExpression(LiteralType.number, undefined, this.isPostgres ? "length" : "LEN", [obj]);

        // Property on a plain constant (captured value) — keep as a source node.
        if (obj instanceof ConstantExpression)
            return new PropertyExpression(obj, name, pe.isOptionalChaining);

        throw new Error(`Cannot bind member '${name}' on ${obj.toString()}`);
    }

    // Binds `entity.<name>`: id short-circuits to the FK column (no JOIN), a
    // collection field becomes a lazy FieldEntityArrayExpression, anything else
    // completes the entity (navigation → JOIN) and reads the field binding.
    private bindEntityMember(entity: EntityExpression, name: string): Expression {
        if (name === "id")
            return entity.externalId;
        const ef = Object.values(entity.table.fields).find(f => f.fieldInfo.name === name);
        if (ef != null && ef.field instanceof FieldEntityArray)
            return this.makeFieldEntityArray(entity, ef.field);
        const completed = this.completed(entity);
        return this.findBinding(completed.bindings!, name, completed.type);
    }

    private findBinding(bindings: readonly FieldBinding[], name: string, ownerType: Type): Expression {
        const fb = bindings.find(b => b.fieldInfo.name === name);
        if (fb == null)
            throw new Error(`Field '${name}' not found on ${ownerType.toString()}`);
        return fb.binding;
    }

    // ---- table source -----------------------------------------------------

    // Entity completion (Signum's `Completed`): a lazy single-reference
    // EntityExpression (bindings == null, only its FK `externalId` is known) is
    // turned into a fully-bound entity at a fresh table alias, and a LEFT OUTER
    // JOIN to that table is registered against the current source. The join links
    // the owner's FK column to the referenced table's primary key. Idempotent and
    // deduped via `entityReplacements`.
    private completed(ee: EntityExpression): EntityExpression {
        if (ee.bindings != null && ee.tableAlias != null)
            return ee;

        const cached = this.entityReplacements.get(ee);
        if (cached != null)
            return cached;

        const table = ee.table;
        const newAlias = this.aliasGenerator.nextTableAlias(table.name.name);
        const completed = this.createEntityExpression(table, newAlias, ee.externalId);
        this.entityReplacements.set(ee, completed);

        const newId = new ColumnExpression(LiteralType.number, newAlias, table.primaryKey.column.name);
        const condition = new BinaryExpression("==", ee.externalId.value, newId);
        this.addRequest({ table: new TableExpression(newAlias, table), condition });

        return completed;
    }

    private addRequest(request: TableRequest): void {
        const source = this.sourceStack[this.sourceStack.length - 1];
        if (source == null)
            throw new Error("Entity completion requested with no current source on the stack");
        const list = this.requests.get(source);
        if (list != null)
            list.push(request);
        else
            this.requests.set(source, [request]);
    }

    private getTableProjection(ctor: new () => object): ProjectionExpression {
        return this.getTableProjectionForTable(this.schema.table(ctor as any), new ClassType(ctor));
    }

    private getTableProjectionForTable(table: Table, elementType: Type): ProjectionExpression {
        const tableAlias = this.aliasGenerator.nextTableAlias(table.name.name);
        const entity = this.createEntityExpression(table, tableAlias);

        const tableExpr = new TableExpression(tableAlias, table);
        const selectAlias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(entity, selectAlias);

        return new ProjectionExpression(
            new SelectExpression(selectAlias, false, undefined, pc.columns, tableExpr, undefined, [], []),
            pc.projector, undefined, new ArrayType(elementType));
    }

    // ---- collections (FieldEntityArray) -----------------------------------

    // A navigated collection → a transient FieldEntityArrayExpression carrying the
    // child table, the child's back-reference property, and the parent id (the
    // correlation key). Realised lazily by fieldEntityArrayProjection.
    private makeFieldEntityArray(owner: EntityExpression, field: FieldEntityArray): FieldEntityArrayExpression {
        const childTable = this.schema.table(field.childType as any);
        return new FieldEntityArrayExpression(new ClassType(field.childType as any), childTable, field.childFkProperty, owner.externalId.value);
    }

    // Realises a collection navigation into a correlated sub-projection:
    //   SELECT child.* FROM <childTable> WHERE child.<fk> = <ownerId>
    // The WHERE references the owner alias (the correlation); it becomes valid when
    // this select is spliced in as the right side of a CROSS APPLY (bindSelectMany)
    // or wrapped as a scalar/EXISTS subquery.
    private fieldEntityArrayProjection(fea: FieldEntityArrayExpression): ProjectionExpression {
        const childProj = this.getTableProjectionForTable(fea.childTable, fea.type);
        const childEntity = childProj.projector as EntityExpression;
        let fkBinding = childEntity.bindings?.find(b => b.fieldInfo.name === fea.fkProperty)?.binding;
        // The back-reference FK is usually a Lite<Owner>; unwrap to its reference.
        if (fkBinding instanceof LiteReferenceExpression)
            fkBinding = fkBinding.reference;
        if (!(fkBinding instanceof EntityExpression))
            throw new Error(`Collection FK '${fea.fkProperty}' did not bind to a reference on ${fea.childTable.name.name}`);

        const where = new BinaryExpression("==", fkBinding.externalId.value, fea.ownerId);
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(childProj.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, childProj.select, where, [], []),
            pc.projector, undefined, new ArrayType(fea.type));
    }

    private asProjection(e: Expression): ProjectionExpression {
        if (e instanceof ProjectionExpression)
            return e;
        if (e instanceof FieldEntityArrayExpression)
            return this.fieldEntityArrayProjection(e);
        throw new Error("Expected a collection/projection but got: " + e.toString());
    }

    // SelectMany (flatMap): bind the collection selector against the source, then
    // CROSS APPLY the (correlated) collection sub-projection onto the source.
    // Signum's BindSelectMany (single-selector form; result-selector / index /
    // DefaultIfEmpty overloads are not surfaced by altea's flatMap yet).
    private bindSelectMany(projection: ProjectionExpression, selector: LambdaExpression): ProjectionExpression {
        const coll = this.mapVisitExpand(selector, projection);
        const collProj = this.asProjection(coll);

        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = projectColumns(collProj.projector, alias);
        const join = new JoinExpression("CrossApply", projection.select, collProj.select, undefined);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, join, undefined, [], []),
            pc.projector, undefined, collProj.type);
    }

    // Builds the EntityExpression for a table: id → externalId, value/enum → a
    // column, embedded → inlined EmbeddedEntityExpression, single reference → a
    // lazy EntityExpression (completed on navigation, step 5). ImplementedBy*,
    // collections (FieldEntityArray) are skipped for now.
    private createEntityExpression(table: Table, alias: Alias, externalIdOverride?: PrimaryKeyExpression): EntityExpression {
        const idColumn = table.primaryKey.column;
        // Root tables read their id from their own alias; a completed reference
        // keeps the owner's FK column as its externalId (so projecting just the
        // id avoids the JOIN), while its fields read from the joined alias.
        const externalId = externalIdOverride
            ?? new PrimaryKeyExpression(new ColumnExpression(LiteralType.number, alias, idColumn.name));

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
            const refType = new ClassType(refTable.type as any);
            const externalId = new PrimaryKeyExpression(new ColumnExpression(LiteralType.number, alias, f.column.name));
            const entity = new EntityExpression(refType, refTable, externalId, undefined, undefined, undefined, false);
            // A Lite<T> field projects as a Lite, not a full entity; navigation
            // through it (.entity) unwraps to this same reference.
            return f.column.isLite ? new LiteReferenceExpression(refType, entity, undefined) : entity;
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

    // Maps a value field's declared type name to a SQL literal type. The entity
    // metadata uses capitalized JS type names ("String"/"Number"/"Boolean", as
    // emitted by the @field transformer). Temporal/enum/etc. stay null-typed until
    // those Types are modelled.
    private valueType(fi: FieldInfo): Type {
        switch (fi.typeName) {
            case "String": return LiteralType.string;
            case "Number": return LiteralType.number;
            case "Boolean": return LiteralType.boolean;
            default: return LiteralType.null; // temporal/enum/etc. — refined later
        }
    }
}
