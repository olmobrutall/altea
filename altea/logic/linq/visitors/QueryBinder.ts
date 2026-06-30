import {
    Expression, CallExpression, PropertyExpression, ParameterExpression,
    LambdaExpression, ConstantExpression, CastExpression, BinaryExpression,
    ConditionalExpression, ObjectExpression, UnaryExpression,
} from "../expressions";
import {
    SelectExpression, ProjectionExpression, ColumnExpression, PrimaryKeyExpression,
    FieldBinding, EntityExpression, EmbeddedEntityExpression, MixinEntityExpression,
    SqlConstantExpression, TableExpression, OrderExpression, OrderType, UniqueFunction,
    AggregateExpression, AggregateRequestsExpression, AggregateSqlFunction, ColumnDeclaration, InExpression,
    SourceExpression, SqlFunctionExpression, SelectOptions, FieldEntityArrayExpression, JoinExpression, JoinType,
    LiteReferenceExpression, LiteReferenceTarget, ScalarExpression, ExistsExpression,
    ImplementedByExpression, ImplementedByAllExpression, TypeImplementedByAllExpression,
    CaseExpression, When, IsNotNullExpression,
    CommandExpression, CommandAggregateExpression, ColumnAssignment,
    DeleteExpression, UpdateExpression, InsertSelectExpression,
} from "../expressions.sql";
import { AssignAdapterExpander } from "./AssignAdapterExpander";
import { AliasGenerator, Alias } from "../AliasGenerator";
import { projectColumns as projectColumnsImpl, ProjectedColumns } from "./ColumnProjector";
import { fullNominate as fullNominateImpl } from "../dbExpressionNominator";
import { QueryJoinExpander, TableRequest } from "./QueryJoinExpander";
import { GroupEntityCleaner } from "./GroupEntityCleaner";
import { SmartEqualizer } from "../smartEqualizer";
import type { Schema } from "../../schema/schema";
import type { Table } from "../../schema/table";
import type { EntityField } from "../../schema/field";
import {
    FieldPrimaryKey, FieldValue, FieldReference, FieldEnum, FieldEmbedded, FieldEntityArray,
    FieldImplementedBy, FieldImplementedByAll,
} from "../../schema/field";
import type { FieldInfo } from "../../../entities/reflection";
import { resolveType } from "../../../entities/registration";
import { Entity } from "../../../entities/entity";
import { ArrayType, ClassType, LiteType, LiteralType, TemporalType, Type } from "../../../entities/types";
import { ExpressionVisitor } from "./ExpressionVisitor";

// Adapted port of Signum's QueryBinder. Input is altea's source Expression AST
// (a CallExpression chain over `table(T)`); output is a DbExpression tree
// (ProjectionExpression). This is the SKELETON: it binds the table source plus
// `filter` (Where) and `map` (Select). Other operators and full navigation/JOIN
// expansion land in later steps.

// A bound expression that denotes an entity reference (typed, polymorphic, or a
// Lite over any of those) — the cases SmartEqualizer knows how to compare.
function isReferenceish(e: Expression): boolean {
    return e instanceof EntityExpression || e instanceof ImplementedByExpression
        || e instanceof ImplementedByAllExpression || e instanceof LiteReferenceExpression;
}

// Relational-join operator → SQL join type. leftJoin preserves the outer (left)
// source, rightJoin the inner (right), fullJoin both.
const JOIN_TYPES: { [op: string]: JoinType | undefined } = {
    innerJoin: "InnerJoin",
    leftJoin: "LeftOuterJoin",
    rightJoin: "RightOuterJoin",
    fullJoin: "FullOuterJoin",
};

// A plain `{...}` object (Object/null prototype) — as opposed to a class instance
// (Entity/Lite/Embedded). Used to detect an all-constant bulk-DML setter literal the
// ExpressionSimplifier folded whole into a single constant.
function isPlainObject(v: unknown): boolean {
    if (v == null || typeof v !== "object")
        return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

// Signum's GroupByInfo: recorded per group's element-subquery alias. When an
// aggregate is bound over that subquery (`g.elements.sum()`), the aggregate is
// computed over `projector` (the element expression) against `source` (the source
// being grouped) and deferred to the GROUP BY select identified by `groupAlias`.
class GroupByInfo {
    constructor(
        readonly groupAlias: Alias,
        readonly projector: Expression,
        readonly source: SourceExpression,
    ) { }
}

// A constant/sql-constant group key is trivial — it must not appear in GROUP BY
// (grouping by a literal is meaningless and SQL Server rejects it).
function isTrivialGroupKey(e: Expression): boolean {
    if (e instanceof ConstantExpression || e instanceof SqlConstantExpression)
        return true;
    if (e instanceof CastExpression)
        return isTrivialGroupKey(e.expression);
    return false;
}

// Signum's ToNotNullPredicate: a Count(predicate) counts the rows where the
// predicate holds. `x != null` / `null != x` becomes simply `x` (count non-null);
// any other predicate becomes `pred ? "placeholder" : null` (a value that is
// non-null exactly when the predicate is true), so COUNT(arg) counts the matches.
function toNotNullPredicate(predicate: LambdaExpression): LambdaExpression {
    const body = predicate.body;
    if (body instanceof BinaryExpression && (body.kind === "!=" || body.kind === "!==")) {
        const exp = isNullLiteral(body.left) ? body.right
            : isNullLiteral(body.right) ? body.left
                : undefined;
        if (exp != null)
            return new LambdaExpression(predicate.parameters, exp);
    }
    const conditional = new ConditionalExpression(body, new ConstantExpression("placeholder"), new ConstantExpression(null));
    return new LambdaExpression(predicate.parameters, conditional);
}

function isNullLiteral(e: Expression): boolean {
    return e instanceof ConstantExpression && e.value == null;
}

export class QueryBinder extends ExpressionVisitor {
    private readonly aliasGenerator: AliasGenerator;
    private readonly map = new Map<ParameterExpression, Expression>();
    private thenBys: OrderExpression[] | undefined;

    // The outermost expression being bound (Signum's `root`). An aggregate call
    // that *is* the root materialises as a one-row ProjectionExpression; a nested
    // one becomes a scalar subquery / a deferred group AggregateRequest.
    private root: Expression | undefined;

    // Signum's groupByMap: element-subquery alias → the info needed to lower an
    // aggregate over that group into a GROUP BY column (via AggregateRewriter).
    private readonly groupByMap = new Map<Alias, GroupByInfo>();

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

    // The alias sequence used during binding — handed to ChildProjectionFlattener
    // so the selects it introduces don't collide with the ones already allocated.
    get aliases(): AliasGenerator {
        return this.aliasGenerator;
    }

    bindQuery(expr: Expression): ProjectionExpression {
        this.root = expr;
        const result = this.visit(expr);
        if (!(result instanceof ProjectionExpression))
            throw new Error("Query did not bind to a ProjectionExpression: " + result.toString());
        // Splice in the implicit navigation joins recorded during binding.
        const expanded = QueryJoinExpander.expand(result, this.requests);
        if (!(expanded instanceof ProjectionExpression))
            throw new Error("Join expansion did not preserve the ProjectionExpression");
        return expanded;
    }

    // Bulk DML entry — binds an executeUpdate/executeDelete/executeInsert terminal
    // call to a CommandExpression (Signum's BindUpdate/BindDelete/BindInsert).
    bindCommand(expr: Expression): CommandExpression {
        this.root = expr;
        const call = expr as CallExpression;
        const prop = call.func as PropertyExpression;
        const op = prop.propertyName;

        let command: CommandExpression;
        switch (op) {
            case "executeDelete":
                command = this.bindDelete(prop.object);
                break;
            case "executeUpdate":
                command = this.bindUpdate(prop.object, undefined, call.args[0] as LambdaExpression);
                break;
            case "executeUpdatePart":
                command = this.bindUpdate(prop.object, call.args[0] as LambdaExpression, call.args[1] as LambdaExpression);
                break;
            case "executeInsert":
                command = this.bindInsert(prop.object, call.args[0], call.args[1] as LambdaExpression);
                break;
            default:
                throw new Error(`Command operator '${op}' is not implemented in the binder`);
        }

        // Splice the implicit navigation joins (filter / setter-value navigations)
        // recorded during binding into the command's source selects.
        return QueryJoinExpander.expand(command, this.requests) as CommandExpression;
    }

    private bindSourceProjection(sourceExpr: Expression): ProjectionExpression {
        let result = this.visit(sourceExpr);
        if (result instanceof FieldEntityArrayExpression)
            result = this.fieldEntityArrayProjection(result);
        if (!(result instanceof ProjectionExpression))
            throw new Error("Command source did not bind to a projection: " + result.toString());
        return result;
    }

    private bindDelete(sourceExpr: Expression): CommandExpression {
        const pr = this.bindSourceProjection(sourceExpr);
        const proj = pr.projector;
        if (!(proj instanceof EntityExpression))
            throw new Error("Delete not supported for projector: " + proj.toString());

        const commands: CommandExpression[] = [];

        // Owned child rows (FieldEntityArray, altea's analogue of Signum's MList
        // tables) must be deleted first to satisfy their back-reference FK — Signum's
        // BindDelete prepends a DeleteExpression per MList table.
        for (const ef of Object.values(proj.table.fields)) {
            if (ef.field instanceof FieldEntityArray && ef.field.cascade) {
                const childTable = this.schema.table(ef.field.childType as any);
                const backField = childTable.fields[ef.field.childFkProperty]?.field;
                if (!(backField instanceof FieldReference))
                    continue;
                const backId = new ColumnExpression(LiteralType.number, this.aliasGenerator.table(childTable.name), backField.column.name);
                const childWhere = new BinaryExpression("==", backId, this.unwrapPk(proj.externalId));
                commands.push(new DeleteExpression(childTable, pr.select, childWhere, false, undefined));
            }
        }

        const idCol = new ColumnExpression(LiteralType.number, this.aliasGenerator.table(proj.table.name), proj.table.primaryKey.column.name);
        const where = new BinaryExpression("==", idCol, this.unwrapPk(proj.externalId));
        commands.push(new DeleteExpression(proj.table, pr.select, where, true, undefined));
        return new CommandAggregateExpression(commands);
    }

    private bindUpdate(sourceExpr: Expression, partSelector: LambdaExpression | undefined, setter: LambdaExpression): CommandExpression {
        const pr = this.bindSourceProjection(sourceExpr);
        const entity = partSelector == null ? pr.projector : this.mapVisitExpand(partSelector, pr);
        if (!(entity instanceof EntityExpression))
            throw new Error("Update target is not an entity: " + entity.toString());

        const table = entity.table;
        const tableAlias = this.aliasGenerator.table(table.name);
        const toUpdate = this.createEntityExpression(table, tableAlias);

        // Columns come from the target table (toUpdate); the setter's values are read
        // from the source row — the navigated part itself when updating a part.
        const valueSource = partSelector == null ? pr.projector : entity;
        const assignments = this.buildAssignments(toUpdate, setter, pr.select, valueSource);

        const idCol = new ColumnExpression(LiteralType.number, tableAlias, table.primaryKey.column.name);
        const where = new BinaryExpression("==", idCol, this.unwrapPk(entity.externalId));
        return new CommandAggregateExpression([new UpdateExpression(table, pr.select, where, assignments, true)]);
    }

    private bindInsert(sourceExpr: Expression, targetCtorExpr: Expression, selector: LambdaExpression): CommandExpression {
        const pr = this.bindSourceProjection(sourceExpr);
        const targetCtor = (targetCtorExpr as ConstantExpression).value as new () => object;
        const table = this.schema.table(targetCtor as any);
        const toInsert = this.createEntityExpression(table, this.aliasGenerator.table(table.name));

        const assignments = this.buildAssignments(toInsert, selector, pr.select, pr.projector);

        // Signum auto-fills the optimistic-concurrency column with 0 on INSERT when
        // the projection didn't set it.
        if (table.ticks != null && !assignments.some(a => a.column === table.ticks!.column.name))
            assignments.push(new ColumnAssignment(table.ticks.column.name, new SqlConstantExpression(0, LiteralType.number)));

        return new CommandAggregateExpression([new InsertSelectExpression(table, pr.select, assignments, true)]);
    }

    // Binds a `{ field: valueExpr, … }` object-literal setter, producing one
    // ColumnAssignment per leaf column: each property's column comes from `target`,
    // its value from `valueSource` (the setter param). Three body shapes:
    //   • ObjectExpression — the normal case (some value references the param).
    //   • ConstantExpression(plain object) — an all-constant literal the simplifier
    //     folded whole (e.g. `{ author: michael, label: null }`); each value is a
    //     constant the AssignAdapterExpander reshapes.
    //   • ParameterExpression — the identity insert `a => a` over an already-shaped
    //     .map projector (its bound properties are reused verbatim).
    private buildAssignments(target: EntityExpression, selector: LambdaExpression, sourceSelect: SourceExpression, valueSource: Expression): ColumnAssignment[] {
        const assignments: ColumnAssignment[] = [];
        const param = selector.parameters[0];
        const old = this.map.get(param);
        this.map.set(param, valueSource);
        this.sourceStack.push(sourceSelect);
        try {
            const body = selector.body;
            let entries: [string, Expression][];
            if (body instanceof ParameterExpression && valueSource instanceof ObjectExpression)
                entries = Object.entries(valueSource.properties); // identity: already bound
            else if (body instanceof ObjectExpression)
                entries = Object.entries(body.properties).map(([k, v]) => [k, this.visit(v)]);
            else if (body instanceof ConstantExpression && isPlainObject(body.value))
                entries = Object.entries(body.value as Record<string, unknown>).map(([k, v]) => [k, new ConstantExpression(v)]);
            else
                throw new Error("Bulk-DML setter must be an object literal (or the identity parameter)");

            for (const [name, value] of entries) {
                const colExpr = this.bindMember(target, name, false);
                assignments.push(...this.adaptAssign(colExpr, value));
            }
        } finally {
            this.sourceStack.pop();
            if (old === undefined) this.map.delete(param); else this.map.set(param, old);
        }
        return assignments;
    }

    private adaptAssign(colExpr: Expression, value: Expression): ColumnAssignment[] {
        return this.assign(colExpr, AssignAdapterExpander.adapt(value, colExpr));
    }

    // Port of Signum's Assign: pairs a target column-shape with an equally-shaped
    // value, emitting one ColumnAssignment per leaf column.
    private assign(col: Expression, value: Expression): ColumnAssignment[] {
        if (col instanceof ColumnExpression)
            return [this.assignColumn(col, value)];

        if (col instanceof PrimaryKeyExpression)
            return [this.assignColumn(this.unwrapPk(col), this.unwrapPk(value))];

        if (col instanceof LiteReferenceExpression)
            return this.assign(col.reference, value instanceof LiteReferenceExpression ? value.reference : value);

        if (col instanceof EmbeddedEntityExpression && value instanceof EmbeddedEntityExpression) {
            const result: ColumnAssignment[] = [];
            // Only a nullable embedded carries a real HasValue column to set.
            if (col.hasValue instanceof ColumnExpression)
                result.push(this.assignColumn(col.hasValue, value.hasValue));
            for (const b of col.bindings) {
                const v = value.bindings.find(x => x.fieldInfo === b.fieldInfo || x.fieldInfo.name === b.fieldInfo.name);
                if (v == null) throw new Error("Missing embedded binding for " + b.fieldInfo.name);
                result.push(...this.adaptAssign(b.binding, v.binding));
            }
            return result;
        }

        if (col instanceof EntityExpression && value instanceof EntityExpression)
            return [this.assignColumn(col.externalId.value, value.externalId.value)];

        if (col instanceof ImplementedByExpression && value instanceof ImplementedByExpression)
            return [...col.implementations].map(([ctor, ee]) =>
                this.assignColumn(ee.externalId.value, value.implementations.get(ctor)!.externalId.value));

        if (col instanceof ImplementedByAllExpression && value instanceof ImplementedByAllExpression)
            return [
                this.assignColumn(col.id, value.id),
                this.assignColumn(col.typeId.typeColumn, value.typeId.typeColumn),
            ];

        throw new Error(`Cannot assign ${col} from ${value}`);
    }

    private assignColumn(col: Expression, value: Expression): ColumnAssignment {
        const c = this.unwrapPk(col);
        if (!(c instanceof ColumnExpression))
            throw new Error(`${c} does not represent a column`);
        return new ColumnAssignment(c.name!, this.fullNominate(value));
    }

    private unwrapPk(e: Expression): Expression {
        return e instanceof PrimaryKeyExpression ? e.value : e;
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
            // The relational joins need the raw sources (the inner source travels as
            // args[0]) and bind two result-selector params; the operator name fixes
            // the SQL join type.
            const joinType = JOIN_TYPES[op];
            if (joinType != null)
                return this.bindJoin(joinType, property.object, call.args[0], call.args[1] as LambdaExpression, call.args[2] as LambdaExpression, call.args[3] as LambdaExpression);
            if (op === "groupJoin")
                return this.bindGroupJoin(property.object, call.args[0], call.args[1] as LambdaExpression, call.args[2] as LambdaExpression, call.args[3] as LambdaExpression);

            let source = this.visit(property.object);
            // A navigated collection (a.friends) realises into a correlated
            // sub-projection so the standard operators below apply to it directly.
            if (source instanceof FieldEntityArrayExpression)
                source = this.fieldEntityArrayProjection(source);
            if (!(source instanceof ProjectionExpression))
                return this.bindMethodCall(op, source, call.args, call.type);

            switch (op) {
                case "filter":
                    return this.bindWhere(source, call.args[0] as LambdaExpression);
                case "map":
                    return this.bindSelect(source, call.args[0] as LambdaExpression);
                case "flatMap":
                    return this.bindSelectMany(source, call.args[0] as LambdaExpression);
                case "groupBy":
                    return this.bindGroupBy(source, property.object, call.args[0] as LambdaExpression, call.args[1] as LambdaExpression | undefined);
                case "toArray":
                    // Materialises the (sub-)query as a list. At the root it's a
                    // no-op; nested in a projector it stays a ProjectionExpression
                    // for ChildProjectionFlattener to extract as eager-loaded rows.
                    return source;
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
                    return this.bindAggregate(source, "Count", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "min":
                    return this.bindAggregate(source, "Min", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "max":
                    return this.bindAggregate(source, "Max", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "sum":
                    return this.bindAggregate(source, "Sum", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "avg":
                    return this.bindAggregate(source, "Average", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "some":
                    return this.bindAnyAll(source, call.args[0] as LambdaExpression | undefined, false, call === this.root);
                case "every":
                    return this.bindAnyAll(source, call.args[0] as LambdaExpression | undefined, true, call === this.root);
                case "contains":
                    return this.bindContains(source, call.args[0], call === this.root);
                case "join":
                    return this.bindToString(source, call.args[0], call === this.root);
                default:
                    throw new Error(`Query operator '${op}' is not implemented in the binder skeleton yet`);
            }
        }

        if ((func instanceof CastExpression || func.kind === "as") && call.args.length === 0)
            return this.visit(func);

        throw new Error("Unexpected call in query: " + call.toString());
    }

    private bindMethodCall(methodName: string, source: Expression, args: readonly Expression[], resultType: Type): Expression {
        // entity.toLite() → a Lite over that reference (Signum's BindToLite). Works
        // over a typed reference or a polymorphic IB/IBA one.
        if (methodName === "toLite" && (source instanceof EntityExpression || source instanceof ImplementedByExpression || source instanceof ImplementedByAllExpression))
            return new LiteReferenceExpression(new LiteType(source.type), source, undefined);
        if (methodName === "toLite" && source instanceof LiteReferenceExpression)
            return source;
        // toLite() on a captured constant entity → a constant Lite (Signum's Clean
        // partial-evaluates this; altea's simplifier doesn't fold method calls). The
        // bulk-DML AssignAdapterExpander then shapes the constant lite to its column.
        if (methodName === "toLite" && source instanceof ConstantExpression && source.value instanceof Entity)
            return new ConstantExpression((source.value as Entity).toLite());

        // entity.is(x) / lite.is(x) → the server form of the in-memory identity
        // check, lowered by SmartEqualizer (handles typed refs, IB, IBA, captured
        // constants and null — comparing id and, for polymorphic refs, type).
        if (methodName === "is" && args.length === 1)
            return SmartEqualizer.polymorphicEqual(source, this.visit(args[0]));

        // some/every over a captured in-memory collection (Signum's BindAnyAll
        // constant-source branch): expand to `pred(v0) OR/AND pred(v1) …`, binding
        // the predicate's parameter to each captured element. (A query/subquery
        // source takes the EXISTS path in the operator switch, not here.)
        if ((methodName === "some" || methodName === "every") && source instanceof ConstantExpression && Array.isArray(source.value)) {
            const isAll = methodName === "every";
            const values = source.value as unknown[];
            if (args.length === 0)
                return new ConstantExpression(isAll ? true : values.length > 0);
            const lambda = args[0] as LambdaExpression;
            const terms = values.map(v => this.bindWithParam(lambda, new ConstantExpression(v)));
            return this.foldBoolean(terms, isAll);
        }

        const visitedArgs = args.map(a => this.visit(a));

        if (methodName === "contains" && source instanceof ConstantExpression && Array.isArray(source.value) && visitedArgs.length === 1) {
            // A captured collection of entities/lites → id-comparison membership
            // (Signum's EntityIn); a collection of values → `item IN (…)`.
            return isReferenceish(visitedArgs[0])
                ? SmartEqualizer.entityIn(visitedArgs[0], source.value)
                : InExpression.fromValues(visitedArgs[0], source.value);
        }

        // Any other instance method (string functions: contains/startsWith/endsWith/
        // like/indexOf/toLowerCase/…/substring, and unimplemented ones) is left as a
        // residual call with its receiver and args already bound. The nominator's
        // HardCodedMethods (visitCall) lowers it to SQL — matching C#, where QueryBinder
        // leaves non-operator MethodCallExpressions for DbExpressionNominator to translate.
        return new CallExpression(new PropertyExpression(source, methodName, false), visitedArgs, resultType);
    }

    override visitParameter(parameter: ParameterExpression): Expression {
        return this.map.get(parameter) ?? parameter;
    }

    override visitProperty(property: PropertyExpression): Expression {
        return this.bindMemberAccess(property);
    }

    // `instanceof` and reference equality (`==`/`!=`) lower through SmartEqualizer;
    // everything else keeps the default child-rewrite traversal.
    override visitBinary(b: BinaryExpression): Expression {
        if (b.kind === "instanceof") {
            const expr = this.visit(b.left);
            const ctor = this.constantCtor(b.right);
            return SmartEqualizer.entityIsInstance(expr, ctor);
        }

        if (b.kind === "==" || b.kind === "===" || b.kind === "!=" || b.kind === "!==") {
            const left = this.visit(b.left);
            const right = this.visit(b.right);
            if (isReferenceish(left) || isReferenceish(right)) {
                const eq = SmartEqualizer.polymorphicEqual(left, right);
                return (b.kind === "!=" || b.kind === "!==") ? SmartEqualizer.not(eq) : eq;
            }
            return b.updateBinary(left, right);
        }

        return super.visitBinary(b);
    }

    // `x as T`: narrow a polymorphic reference to one implementation. For IB, pick
    // the matching implementation entity; for IBA, build a typed reference reusing
    // the id column (the join only matches rows of that type). Value casts and
    // already-concrete references are SQL no-ops — drop the cast.
    override visitCast(cast: CastExpression): Expression {
        const expr = this.visit(cast.expression);
        const targetCtor = cast.type instanceof ClassType ? cast.type.constructorFunction : undefined;

        if (targetCtor != null) {
            if (expr instanceof ImplementedByExpression) {
                const impl = expr.implementations.get(targetCtor);
                if (impl != null)
                    return impl;
            }
            if (expr instanceof ImplementedByAllExpression) {
                const refTable = this.schema.table(targetCtor as any);
                return new EntityExpression(new ClassType(targetCtor), refTable, new PrimaryKeyExpression(expr.id), undefined, undefined, undefined, false);
            }
        }

        return expr;
    }

    // The constructor behind the right operand of `instanceof` (a captured ctor).
    private constantCtor(e: Expression): Function {
        const v = this.visit(e);
        if (v instanceof ConstantExpression && typeof v.value === "function")
            return v.value as Function;
        throw new Error("instanceof right operand is not a constructor: " + e.toString());
    }

    // ---- operators --------------------------------------------------------

    // Column projection and translation both depend on the dialect; thread it through
    // so the nominator can pick CHARINDEX vs strpos, etc.
    private projectColumns(projector: Expression, alias: Alias): ProjectedColumns {
        return projectColumnsImpl(projector, alias, this.isPostgres);
    }

    // Translate the residual SQL-function method calls in a predicate / order key /
    // aggregate argument (the binder leaves them for the nominator — Signum's
    // FullNominate). Projector expressions are translated by projectColumns instead.
    private fullNominate(e: Expression): Expression {
        return fullNominateImpl(e, this.isPostgres);
    }

    private bindWhere(projection: ProjectionExpression, predicate: LambdaExpression): ProjectionExpression {
        const where = this.fullNominate(this.mapVisitExpand(predicate, projection));
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, projection.select, where, [], []),
            pc.projector, undefined, projection.type);
    }

    private bindSelect(projection: ProjectionExpression, selector: LambdaExpression): ProjectionExpression {
        const expression = this.mapVisitExpand(selector, projection);
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(expression, alias);
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
        const pc = this.projectColumns(projection.projector, alias);
        const orderBy = append ? [...projection.select.orderBy] : [];
        orderBy.push(new OrderExpression(orderType, this.fullNominate(this.mapVisitExpand(selector, projection))));

        if (myThenBys != null) {
            for (let i = myThenBys.length - 1; i >= 0; i--) {
                const thenBy = myThenBys[i];
                orderBy.push(new OrderExpression(thenBy.orderType, this.fullNominate(this.mapVisitExpand(thenBy.expression as LambdaExpression, projection))));
            }
        }

        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, projection.select, undefined, orderBy, []),
            pc.projector, projection.uniqueFunction, projection.type);
    }

    private bindTop(projection: ProjectionExpression, top: Expression): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, top, pc.columns, projection.select, undefined, [], []),
            pc.projector, projection.uniqueFunction, projection.type);
    }

    private bindDistinct(projection: ProjectionExpression): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, true, undefined, pc.columns, projection.select, undefined, [], []),
            pc.projector, undefined, projection.type);
    }

    private bindUnique(projection: ProjectionExpression, uniqueFunction: UniqueFunction, predicate: LambdaExpression | undefined): ProjectionExpression {
        if (predicate != null)
            projection = this.bindWhere(projection, predicate);

        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projection.projector, alias);
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
        const pc = this.projectColumns(projection.projector, alias);
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

    // Port of Signum's BindAggregate. Two shapes:
    //  (a) **over a group** — when the source is a grouping's element subquery
    //      (its alias is in `groupByMap`), the aggregate is *deferred*: it returns
    //      an AggregateRequestsExpression that AggregateRewriter later hoists into
    //      the GROUP BY select as a column. The argument is computed over the
    //      group's element projector/source, not the subquery's columns.
    //  (b) **standalone** — a fresh `SELECT <agg> FROM <source>`. At the root it
    //      materialises as a one-row ProjectionExpression; nested it becomes a
    //      ScalarExpression (a correlated scalar subquery).
    // The distinct-fast disassembly (Count over Select.Distinct → COUNT(DISTINCT))
    // is not ported; those route through (b) as a correct COUNT(*)-over-subquery.
    private bindAggregate(projection: ProjectionExpression, aggregateFunction: AggregateSqlFunction, selector: LambdaExpression | undefined, isRoot: boolean): Expression {
        const info = this.groupByMap.get(projection.select.alias);
        if (info != null) {
            const exp: Expression | undefined =
                aggregateFunction === "Count" && selector == null ? undefined :       // Count(*)
                aggregateFunction === "Count" ? this.mapVisitExpandCore(toNotNullPredicate(selector!), info.projector, info.source) :
                selector != null ? this.mapVisitExpandCore(selector, info.projector, info.source) : // Sum(x), Avg(x), …
                info.projector;                                                        // Sum() over an element-selected group

            const arg = exp == null ? undefined : this.aggregateArgument(exp);
            const aggregate = new AggregateExpression(
                aggregateFunction === "Count" ? LiteralType.number : (arg?.type ?? LiteralType.number),
                aggregateFunction,
                arg == null ? [] : [arg],
                undefined);
            return new AggregateRequestsExpression(info.groupAlias, aggregate);
        }

        // Complicated subquery / root. Count(predicate) → WHERE then Count(*).
        if (aggregateFunction === "Count" && selector != null) {
            projection = this.bindWhere(projection, selector);
            selector = undefined;
        }

        const argument = selector == null ? projection.projector : this.fullNominate(this.mapVisitExpand(selector, projection));
        const aggregate = aggregateFunction === "Count"
            ? new AggregateExpression(LiteralType.number, aggregateFunction, [], undefined)
            : (() => { const a = this.aggregateArgument(argument); return new AggregateExpression(a.type, aggregateFunction, [a], undefined); })();
        // NB: Signum coalesces a non-nullable Sum over no rows to 0, but altea's port
        // dropped the `(int?)` cast that distinguishes RootSumZero (→0) from
        // RootSumNull (→null) — the queries are identical here, so neither coalesce
        // nor its absence can satisfy both. Left un-coalesced (matches RootSumNull).

        const alias = this.aliasGenerator.nextSelectAlias();
        const name = "c0";
        const select = new SelectExpression(alias, false, undefined, [new ColumnDeclaration(name, aggregate)], projection.select, undefined, [], []);
        if (isRoot)
            return new ProjectionExpression(select, new ColumnExpression(aggregate.type, alias, name), "Single", aggregate.type);
        return new ScalarExpression(aggregate.type, select);
    }

    // String aggregate — port of Signum's BindToString (`IEnumerable.ToString(sep)` →
    // SQL STRING_AGG). The source projector is the already-mapped scalar to concatenate
    // (altea's `join(sep)` has no selector — a prior `.map` did the projection); the
    // separator must be a constant string. Aggregating an entity's display string needs
    // the separate entity-ToString tier, so a non-scalar projector is rejected. Like
    // Signum, no ORDER BY is placed inside the aggregate.
    private bindToString(projection: ProjectionExpression, separatorExpr: Expression, isRoot: boolean): Expression {
        const separator = this.visit(separatorExpr);
        if (!(separator instanceof ConstantExpression) || typeof separator.value !== "string")
            throw new Error("The 'separator' of a string aggregate (join) must be a constant string");

        const nominated = this.fullNominate(projection.projector);
        if (isReferenceish(nominated) || nominated instanceof EmbeddedEntityExpression)
            throw new Error("A string aggregate (join) over an entity needs the entity-ToString tier (not implemented yet); project a scalar with .map(...) first");

        const aggregate = new AggregateExpression(
            LiteralType.string, "string_agg",
            [nominated, new SqlConstantExpression(separator.value, LiteralType.string)],
            undefined);

        const alias = this.aliasGenerator.nextSelectAlias();
        const select = new SelectExpression(alias, false, undefined, [new ColumnDeclaration("c0", aggregate)], projection.select, undefined, [], []);
        if (isRoot)
            return new ProjectionExpression(select, new ColumnExpression(LiteralType.string, alias, "c0"), "Single", LiteralType.string);
        return new ScalarExpression(LiteralType.string, select);
    }

    // The SQL-valued argument of an aggregate: a reference (typed, polymorphic, or
    // a Lite over any) must be reduced to its id column (Signum's UnwrapPrimaryKey
    // + FullNominate); a PrimaryKey wrapper unwraps to its value. Values pass through.
    private aggregateArgument(exp: Expression): Expression {
        if (exp instanceof LiteReferenceExpression)
            return this.aggregateArgument(exp.reference);
        if (exp instanceof EntityExpression || exp instanceof ImplementedByExpression || exp instanceof ImplementedByAllExpression) {
            const id = this.idOfReference(exp);
            return id instanceof PrimaryKeyExpression ? id.value : id;
        }
        if (exp instanceof PrimaryKeyExpression)
            return exp.value;
        return exp;
    }

    // Any/All — port of Signum's BindAnyAll. `some` → EXISTS(source[ WHERE pred]);
    // `every` → NOT EXISTS(source WHERE !pred) (All(p) ≡ !Any(!p)). At the root the
    // boolean is wrapped in a one-row projection; nested it stays an ExistsExpression.
    private bindAnyAll(projection: ProjectionExpression, predicate: LambdaExpression | undefined, isAll: boolean, isRoot: boolean): Expression {
        if (isAll && predicate != null)
            predicate = new LambdaExpression(predicate.parameters, new UnaryExpression("!", predicate.body));

        const filtered = predicate != null ? this.bindWhere(projection, predicate) : projection;

        let result: Expression = new ExistsExpression(filtered.select);
        if (isAll)
            result = SmartEqualizer.not(result);

        return isRoot ? this.getUniqueProjection(result, "SingleOrDefault") : result;
    }

    // Contains — port of Signum's BindContains over a (sub-)query source. A value
    // collection → `item IN (SELECT col …)`; a reference collection → `EXISTS(…
    // WHERE element == item)` lowered by SmartEqualizer (the constant-array form is
    // handled separately in bindMethodCall → IN).
    private bindContains(projection: ProjectionExpression, item: Expression, isRoot: boolean): Expression {
        const newItem = this.visit(item);
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projection.projector, alias);

        let result: Expression;
        if (isReferenceish(projection.projector)) {
            const where = SmartEqualizer.polymorphicEqual(projection.projector, newItem);
            result = new ExistsExpression(new SelectExpression(alias, false, undefined, pc.columns, projection.select, where, [], []));
        } else {
            result = new InExpression(newItem, new SelectExpression(alias, false, undefined, pc.columns, projection.select, undefined, [], []), undefined);
        }

        return isRoot ? this.getUniqueProjection(result, "SingleOrDefault") : result;
    }

    // Wrap a boolean expression as a one-row projection (Signum's GetUniqueProjection)
    // — `SELECT <expr> AS value` with no FROM, read back as a single scalar.
    private getUniqueProjection(expr: Expression, uniqueFunction: UniqueFunction): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        const select = new SelectExpression(alias, false, undefined, [new ColumnDeclaration("value", expr)], undefined, undefined, [], []);
        return new ProjectionExpression(select, new ColumnExpression(expr.type, alias, "value"), uniqueFunction, expr.type);
    }

    // Binds a lambda body with its single parameter mapped to a fixed expression
    // (no source navigation) — used to expand a predicate over each captured element.
    private bindWithParam(lambda: LambdaExpression, value: Expression): Expression {
        const param = lambda.parameters[0];
        const old = this.map.get(param);
        this.map.set(param, value);
        try {
            return this.visit(lambda.body);
        } finally {
            if (old === undefined)
                this.map.delete(param);
            else
                this.map.set(param, old);
        }
    }

    // AND/OR-fold a list of boolean terms; empty folds to the identity (All→true,
    // Any→false).
    private foldBoolean(terms: Expression[], isAll: boolean): Expression {
        if (terms.length === 0)
            return new ConstantExpression(isAll);
        return terms.reduce((a, b) => new BinaryExpression(isAll ? "&&" : "||", a, b));
    }

    // Binds a lambda body with its single parameter mapped to the source's
    // projector (Signum's MapVisitExpand).
    private mapVisitExpand(lambda: LambdaExpression, projection: ProjectionExpression): Expression {
        return this.mapVisitExpandCore(lambda, projection.projector, projection.select);
    }

    // The general form: bind a lambda body with its parameter mapped to `projector`
    // and navigations attached to `source` (used by the group-aggregate path, where
    // the projector/source come from GroupByInfo, not a single projection).
    private mapVisitExpandCore(lambda: LambdaExpression, projector: Expression, source: SourceExpression): Expression {
        const param = lambda.parameters[0];
        const old = this.map.get(param);
        this.map.set(param, projector);
        // The source the lambda binds against — any navigation completed while
        // binding the body joins onto this select (see `completed`/`addRequest`).
        this.sourceStack.push(source);
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
        return this.bindMember(this.visit(pe.object), pe.propertyName, pe.isOptionalChaining);
    }

    // Dispatches `<bound obj>.<name>` on an already-bound expression. Split out from
    // bindMemberAccess so it can be reused to navigate a member on the projector of a
    // single-result sub-query (see the uniqueFunction branch below).
    private bindMember(obj: Expression, name: string, isOptionalChaining: boolean): Expression {
        if (obj instanceof EntityExpression)
            return this.bindEntityMember(obj, name);

        if (obj instanceof ImplementedByExpression)
            return this.bindImplementedByMember(obj, name);

        if (obj instanceof ImplementedByAllExpression)
            return this.bindImplementedByAllMember(obj, name);

        // Navigating through a Lite: `.entity`/`.entityOrNull` unwrap to the
        // referenced entity (typed or polymorphic), `.id` short-circuits to the FK
        // column; any other member navigates the reference behind the lite.
        if (obj instanceof LiteReferenceExpression) {
            if (name === "entity" || name === "entityOrNull")
                return obj.reference;
            if (name === "id")
                return this.idOfReference(obj.reference);
            return this.bindReferenceMember(obj.reference, name);
        }

        if (obj instanceof EmbeddedEntityExpression)
            return this.findBinding(obj.bindings, name, obj.type);
        if (obj instanceof MixinEntityExpression)
            return this.findBinding(obj.bindings, name, obj.type);

        // A grouping (and any anonymous result) is an ObjectExpression projector;
        // `g.key` / `g.elements` (and `{ … }.field`) read its members.
        if (obj instanceof ObjectExpression) {
            const member = obj.properties[name];
            if (member != null)
                return member;
            throw new Error(`Property '${name}' not found on object projector`);
        }

        // A member of a single-result sub-query (`coll.orderBy(…).first().name`):
        // navigate the member on the (single) projector and re-wrap as a scalar
        // subquery `(SELECT <member> FROM <the single-row select>)`. The `.length`
        // case below is the collection-count form (uniqueFunction == null).
        if (obj instanceof ProjectionExpression && obj.uniqueFunction != null && name !== "$v") {
            const member = this.bindMember(obj.projector, name, isOptionalChaining);
            const alias = this.aliasGenerator.nextSelectAlias();
            const pc = this.projectColumns(member, alias);
            const select = new SelectExpression(alias, false, undefined, pc.columns, obj.select, undefined, [], []);
            return new ScalarExpression(member.type, select);
        }

        // `.length` of a (sub-)query collection → COUNT (e.g. `g.elements.length`,
        // `album.songs.length`). string.length is the unrelated SQL-function case
        // handled below.
        if (name === "length" && (obj instanceof ProjectionExpression || obj instanceof FieldEntityArrayExpression))
            return this.bindAggregate(this.asProjection(obj), "Count", undefined, false);

        // promise.$v — the await marker (SQL has no async). Unwraps an awaited
        // sub-query: a single-result projection becomes a scalar subquery; anything
        // already a value passes through.
        if (name === "$v")
            return obj instanceof ProjectionExpression ? new ScalarExpression(obj.type, obj.select) : obj;

        // string.length → SQL string-length function (Signum's string.Length).
        // LEN on SQL Server, length() on Postgres.
        if (name === "length" && obj.type === LiteralType.string)
            return new SqlFunctionExpression(LiteralType.number, undefined, this.isPostgres ? "length" : "LEN", [obj]);

        // Date/time member access (`creationTime.year`, `.dayOfWeek`, …) on a temporal
        // column is a SQL-function translation, so — like the string/math methods — the
        // binder leaves it residual and the DbExpressionNominator lowers it (Signum
        // handles date MemberExpressions in the nominator, not the binder).
        if (obj.type instanceof TemporalType)
            return new PropertyExpression(obj, name, isOptionalChaining);

        // Property on a plain constant (captured value) — keep as a source node.
        if (obj instanceof ConstantExpression)
            return new PropertyExpression(obj, name, isOptionalChaining);

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

    // Member access behind a Lite, dispatched on the wrapped reference kind.
    private bindReferenceMember(ref: LiteReferenceTarget, name: string): Expression {
        if (ref instanceof EntityExpression)
            return this.bindEntityMember(ref, name);
        if (ref instanceof ImplementedByExpression)
            return this.bindImplementedByMember(ref, name);
        return this.bindImplementedByAllMember(ref, name);
    }

    // `.id` of a (possibly polymorphic) reference, without a join.
    private idOfReference(ref: LiteReferenceTarget): Expression {
        if (ref instanceof EntityExpression)
            return ref.externalId;
        if (ref instanceof ImplementedByAllExpression)
            return new PrimaryKeyExpression(ref.id);
        // IB has one id column per implementation; `.id` of an IB lite is the first
        // non-null implementation id (Signum coalesces them).
        return this.dispatchIb(ref, ee => ee.externalId.value);
    }

    // Signum's DispatchIb: navigate a member on each implementation and combine the
    // results with a CASE over which implementation column is populated. With a
    // single implementation it short-circuits to that one.
    private bindImplementedByMember(ib: ImplementedByExpression, name: string): Expression {
        if (name === "id")
            return this.idOfReference(ib);
        return this.dispatchIb(ib, ee => this.bindEntityMember(ee, name));
    }

    private dispatchIb(ib: ImplementedByExpression, selector: (ee: EntityExpression) => Expression): Expression {
        const impls = [...ib.implementations.values()];
        if (impls.length === 0)
            return new SqlConstantExpression(null, LiteralType.null);
        if (impls.length === 1)
            return selector(impls[0]);

        const whens: When[] = impls.map(ee =>
            new When(new IsNotNullExpression(ee.externalId.value), selector(ee)));
        return new CaseExpression(whens, undefined);
    }

    // @implementedByAll exposes only `.id` on queries (Signum throws for any other
    // member — the concrete fields are reachable only through a cast).
    private bindImplementedByAllMember(iba: ImplementedByAllExpression, name: string): Expression {
        if (name === "id")
            return new PrimaryKeyExpression(iba.id);
        throw new Error(`Member '${name}' of @implementedByAll is not accessible on queries (cast to a concrete type first)`);
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
        const pc = this.projectColumns(entity, selectAlias);

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
        const pc = this.projectColumns(childProj.projector, alias);
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
        const pc = this.projectColumns(collProj.projector, alias);
        const join = new JoinExpression("CrossApply", projection.select, collProj.select, undefined);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, join, undefined, [], []),
            pc.projector, undefined, collProj.type);
    }

    // Join — port of Signum's BindJoin. The join type is explicit (the binder is
    // called from innerJoin/leftJoin/rightJoin/fullJoin), so there's no DefaultIfEmpty
    // marker to detect: leftJoin preserves the outer (left) side, rightJoin the inner
    // (right), fullJoin both. The result selector takes two parameters (outer, inner)
    // and binds against the join, so navigations in it splice on via QueryJoinExpander.
    private bindJoin(joinType: JoinType, outerSourceRaw: Expression, innerSourceRaw: Expression, outerKey: LambdaExpression, innerKey: LambdaExpression, resultSelector: LambdaExpression): ProjectionExpression {
        const outerProj = this.visit(outerSourceRaw) as ProjectionExpression;
        const innerProj = this.visit(innerSourceRaw) as ProjectionExpression;

        const outerKeyExpr = this.mapVisitExpand(outerKey, outerProj);
        const innerKeyExpr = this.mapVisitExpand(innerKey, innerProj);
        const condition = SmartEqualizer.polymorphicEqual(outerKeyExpr, innerKeyExpr);

        const alias = this.aliasGenerator.nextSelectAlias();
        const join = new JoinExpression(joinType, outerProj.select, innerProj.select, condition);

        // Bind the result selector with both params mapped and the join as the
        // current source (Signum's SetCurrentSource(join)).
        const p0 = resultSelector.parameters[0];
        const p1 = resultSelector.parameters[1];
        const old0 = this.map.get(p0);
        const old1 = this.map.get(p1);
        this.map.set(p0, outerProj.projector);
        this.map.set(p1, innerProj.projector);
        this.sourceStack.push(join);
        let resultExpr: Expression;
        try {
            resultExpr = this.visit(resultSelector.body);
        } finally {
            this.sourceStack.pop();
            if (old0 === undefined) this.map.delete(p0); else this.map.set(p0, old0);
            if (old1 === undefined) this.map.delete(p1); else this.map.set(p1, old1);
        }

        const pc = this.projectColumns(resultExpr, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, join, undefined, [], []),
            pc.projector, undefined, new ArrayType(resultExpr.type));
    }

    // GroupJoin — Signum lowers `groupJoin(inner, ok, ik, (o, g) => r)` to
    // `join(outer, inner.groupBy(ik), ok, gr => gr.key, (o, gr) => r)` where the
    // result's `g` is the grouping's matching elements. We build the same shape by
    // reusing bindGroupBy (→ a `{ key, elements }` grouping) and joining the outer
    // to it on `outerKey == group.key`; the result selector's group param binds to
    // the grouping's `elements` (so `g.count()` / `g.toArray()` work as usual). A
    // group join always preserves the outer row (its group is empty when unmatched),
    // i.e. a LEFT OUTER join to the grouping — matching C#'s GroupJoin semantics.
    private bindGroupJoin(outerSourceRaw: Expression, innerSourceRaw: Expression, outerKey: LambdaExpression, innerKey: LambdaExpression, resultSelector: LambdaExpression): ProjectionExpression {
        const outerProj = this.visit(outerSourceRaw) as ProjectionExpression;
        const innerProj = this.visit(innerSourceRaw) as ProjectionExpression;

        const grouped = this.bindGroupBy(innerProj, innerSourceRaw, innerKey, undefined);
        const groupingProjector = grouped.projector as ObjectExpression;
        const groupKey = groupingProjector.properties["key"];
        const groupElements = groupingProjector.properties["elements"];

        const outerKeyExpr = this.mapVisitExpand(outerKey, outerProj);
        const condition = SmartEqualizer.polymorphicEqual(outerKeyExpr, groupKey);

        const joinType: JoinType = "LeftOuterJoin";
        const alias = this.aliasGenerator.nextSelectAlias();
        const join = new JoinExpression(joinType, outerProj.select, grouped.select, condition);

        const p0 = resultSelector.parameters[0];
        const p1 = resultSelector.parameters[1];
        const old0 = this.map.get(p0);
        const old1 = this.map.get(p1);
        this.map.set(p0, outerProj.projector);
        this.map.set(p1, groupElements);
        this.sourceStack.push(join);
        let resultExpr: Expression;
        try {
            resultExpr = this.visit(resultSelector.body);
        } finally {
            this.sourceStack.pop();
            if (old0 === undefined) this.map.delete(p0); else this.map.set(p0, old0);
            if (old1 === undefined) this.map.delete(p1); else this.map.set(p1, old1);
        }

        const pc = this.projectColumns(resultExpr, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, join, undefined, [], []),
            pc.projector, undefined, new ArrayType(resultExpr.type));
    }

    // GroupBy — faithful port of Signum's BindGroupBy. Produces a GROUP BY select
    // and a `{ key, elements }` projector (altea's analogue of Signum's Grouping):
    //  - `key` projects/groups by the (entity-cleaned) key columns;
    //  - `elements` is a correlated subquery of the grouped element rows, which the
    //    reader eager-loads (ChildProjectionFlattener) when projected raw, and which
    //    serves as the handle (its alias → groupByMap) that lets an aggregate over
    //    the group (`g.elements.sum()`) defer into the GROUP BY select.
    // `sourceExpr` is the (unvisited) source — visited a second time to build an
    // independent element subquery, exactly as Signum visits the source twice.
    private bindGroupBy(projection: ProjectionExpression, sourceExpr: Expression, keySelector: LambdaExpression, elementSelector: LambdaExpression | undefined): ProjectionExpression {
        const subqueryProjection = this.visit(sourceExpr) as ProjectionExpression;

        const alias = this.aliasGenerator.nextSelectAlias();

        const key = GroupEntityCleaner.clean(this.mapVisitExpand(keySelector, projection));
        const keyPC = this.projectColumns(key, alias);

        const select = projection.select;
        // (Signum's "key contains an aggregate" intermediate-select branch is not
        //  ported — no non-skipped test groups by an aggregate.)

        const elemExpr = elementSelector != null
            ? this.mapVisitExpand(elementSelector, projection)
            : projection.projector;

        const subqueryKey = GroupEntityCleaner.clean(this.mapVisitExpand(keySelector, subqueryProjection));
        const subqueryKeyPC = this.projectColumns(subqueryKey, this.aliasGenerator.raw("basura"));
        const subqueryElemExpr = elementSelector != null
            ? this.mapVisitExpand(elementSelector, subqueryProjection)
            : subqueryProjection.projector;

        // Correlate the element subquery's key to the group's key (null-safe), so
        // each group's elements are the matching source rows.
        let subqueryCorrelation: Expression | undefined = undefined;
        if (keyPC.columns.length > 0) {
            const terms = keyPC.columns.map((c1, i) =>
                SmartEqualizer.equalNullableGroupBy(
                    new ColumnExpression(c1.expression.type, alias, c1.name),
                    subqueryKeyPC.columns[i].expression));
            subqueryCorrelation = terms.reduce((a, b) => new BinaryExpression("&&", a, b));
        }

        const elementAlias = this.aliasGenerator.nextSelectAlias();
        const elementPC = this.projectColumns(subqueryElemExpr, elementAlias);
        const elementSubquery = new ProjectionExpression(
            new SelectExpression(elementAlias, false, undefined, elementPC.columns, subqueryProjection.select, subqueryCorrelation, [], []),
            elementPC.projector, undefined, new ArrayType(elementPC.projector.type));

        const resultProjector = new ObjectExpression({ key: keyPC.projector, elements: elementSubquery });

        this.groupByMap.set(elementAlias, new GroupByInfo(alias, elemExpr, select));

        const groupByExprs = keyPC.columns.map(c => c.expression).filter(e => !isTrivialGroupKey(e));

        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, keyPC.columns, select, undefined, [], groupByExprs),
            resultProjector, undefined, new ArrayType(resultProjector.type));
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

        if (f instanceof FieldImplementedBy) {
            // One lazy EntityExpression per implementation, keyed by its ctor; its
            // externalId is that implementation's (nullable) FK column. Navigation
            // / cast picks one; the reader reads whichever id column is non-null.
            const implementations = new Map<Function, EntityExpression>();
            for (const col of f.implementationColumns) {
                const implTable = col.referenceTable!;
                const implCtor = implTable.type as unknown as Function;
                const externalId = new PrimaryKeyExpression(new ColumnExpression(LiteralType.number, alias, col.name));
                implementations.set(implCtor, new EntityExpression(new ClassType(implCtor), implTable, externalId, undefined, undefined, undefined, false));
            }
            const ib = new ImplementedByExpression(new ClassType(this.refCleanCtor(ef.fieldInfo)), "Case", implementations);
            return f.isLite ? new LiteReferenceExpression(new LiteType(ib.type), ib, undefined) : ib;
        }

        if (f instanceof FieldImplementedByAll) {
            const id = new ColumnExpression(LiteralType.number, alias, f.idColumn.name);
            const typeId = new TypeImplementedByAllExpression(new ColumnExpression(LiteralType.string, alias, f.typeColumn.name));
            const iba = new ImplementedByAllExpression(new ClassType(this.refCleanCtor(ef.fieldInfo)), id, typeId);
            return f.isLite ? new LiteReferenceExpression(new LiteType(iba.type), iba, undefined) : iba;
        }

        // FieldEntityArray: navigation-only (no column); handled in bindEntityMember.
        return undefined;
    }

    // The declared (base) constructor of a polymorphic reference field — e.g.
    // `Entity` for `author: Entity`. Used only for the IB/IBA expression's nominal
    // `.type`; the reader materialises the concrete implementation, never this.
    private refCleanCtor(fi: FieldInfo): Function {
        const ctor = resolveType(fi.typeName);
        if (ctor == null)
            throw new Error(`Cannot resolve base type '${fi.typeName}' of polymorphic field '${fi.name}'`);
        return ctor;
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
            case "PlainDateTime": return new TemporalType("dateTime");
            case "PlainDate": return new TemporalType("date");
            case "Duration": return new TemporalType("duration");
            default: return LiteralType.null; // enum/etc. — refined later
        }
    }
}
