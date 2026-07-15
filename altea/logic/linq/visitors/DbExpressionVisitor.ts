import { Expression } from "../expressions";
import {
    DbExpression,
    SourceExpression, TableExpression, SelectExpression, JoinExpression, SetOperatorExpression,
    ColumnExpression, ColumnDeclaration, OrderExpression,
    AggregateExpression, AggregateRequestsExpression, RowNumberExpression, SqlFunctionExpression, SqlConstantExpression, SqlLiteralExpression, SqlCastExpression, ToDayOfWeekExpression,
    CaseExpression, When, LikeExpression, IntervalExpression,
    ScalarExpression, ExistsExpression, InExpression,
    IsNullExpression, IsNotNullExpression,
    ProjectionExpression, ChildProjectionExpression, FieldEntityArrayExpression,
    LiteReferenceExpression, LiteValueExpression, type LiteReferenceTarget, PrimaryKeyExpression, FieldBinding,
    EntityExpression, EmbeddedEntityExpression, MixinEntityExpression,
    ImplementedByExpression, ImplementedByAllExpression, TypeImplementedByAllExpression,
    TypeEntityExpression, TypeImplementedByExpression,
    SourceWithAliasExpression, CommandExpression, ColumnAssignment,
    DeleteExpression, UpdateExpression, InsertSelectExpression, CommandAggregateExpression,
    SqlArrayIndexExpression, SqlTableValuedFunctionExpression,
} from "../expressions.sql";
import { ExpressionVisitor } from "./ExpressionVisitor";

// Port of Signum's DbExpressionVisitor. Identity-preserving: every visit returns
// the same node reference when nothing changed, so optimiser passes can cheaply
// detect "no-op" subtrees. `visit` dispatches DbExpression nodes through their
// `accept` (double-dispatch) and falls back to the generic source-level
// `visitChildren` for the plain Expression nodes (Binary/Constant/Property/…)
// that appear inside WHERE/projector expressions.
export class DbExpressionVisitor extends ExpressionVisitor {

    protected visitSource(source: SourceExpression): SourceExpression {
        return this.visit(source) as SourceExpression;
    }

    visitTable(table: TableExpression): Expression {
        // Recurse into the system-time scope's per-row expression, if any (only AsOfExpression
        // carries one), so alias-remapping passes reach it (Signum's VisitSystemTime).
        const st = table.systemTime?.mapExpression(e => this.visit(e as Expression));
        if (st !== table.systemTime)
            return new TableExpression(table.alias, table.table, table.withHint, st);
        return table;
    }

    visitColumn(column: ColumnExpression): Expression {
        return column;
    }

    visitSelect(select: SelectExpression): Expression {
        const top = this.visit(select.top);
        const from = select.from == null ? undefined : this.visitSource(select.from);
        const where = this.visit(select.where);
        const columns = this.visitArray(select.columns, c => this.visitColumnDeclaration(c));
        const orderBy = this.visitArray(select.orderBy, o => this.visitOrderBy(o));
        const groupBy = this.visitArray(select.groupBy, g => this.visit(g));
        const offset = this.visit(select.offset);

        if (top !== select.top || from !== select.from || where !== select.where ||
            columns !== select.columns || orderBy !== select.orderBy || groupBy !== select.groupBy ||
            offset !== select.offset)
            return new SelectExpression(select.alias, select.isDistinct, top, columns, from, where, orderBy, groupBy, select.selectOptions, offset);

        return select;
    }

    visitJoin(join: JoinExpression): Expression {
        const left = this.visitSource(join.left);
        const right = this.visitSource(join.right);
        const condition = this.visit(join.condition);
        if (left !== join.left || right !== join.right || condition !== join.condition)
            return new JoinExpression(join.joinType, left, right, condition);
        return join;
    }

    visitSetOperator(setOp: SetOperatorExpression): Expression {
        const left = this.visitSource(setOp.left) as SourceWithAliasExpression;
        const right = this.visitSource(setOp.right) as SourceWithAliasExpression;
        if (left !== setOp.left || right !== setOp.right)
            return new SetOperatorExpression(setOp.operator, left, right, setOp.alias);
        return setOp;
    }

    visitAggregate(aggregate: AggregateExpression): Expression {
        const args = this.visitArray(aggregate.arguments, a => this.visit(a));
        const orderBy = aggregate.orderBy == null ? undefined : this.visitArray(aggregate.orderBy, o => this.visitOrderBy(o));
        if (args !== aggregate.arguments || orderBy !== aggregate.orderBy)
            return new AggregateExpression(aggregate.type, aggregate.aggregateFunction, args, orderBy);
        return aggregate;
    }

    visitRowNumber(rowNumber: RowNumberExpression): Expression {
        const orderBy = this.visitArray(rowNumber.orderBy, o => this.visitOrderBy(o));
        return rowNumber.updateRowNumber(orderBy);
    }

    visitAggregateRequest(request: AggregateRequestsExpression): Expression {
        const aggregate = this.visit(request.aggregate) as AggregateExpression;
        if (aggregate !== request.aggregate)
            return new AggregateRequestsExpression(request.groupByAlias, aggregate);
        return request;
    }

    visitSqlFunction(fn: SqlFunctionExpression): Expression {
        const obj = this.visit(fn.object);
        const args = this.visitArray(fn.arguments, a => this.visit(a));
        if (obj !== fn.object || args !== fn.arguments)
            return new SqlFunctionExpression(fn.type, obj, fn.sqlFunction, args);
        return fn;
    }

    visitSqlConstant(sce: SqlConstantExpression): Expression {
        return sce;
    }

    visitArrayIndex(e: SqlArrayIndexExpression): Expression {
        const array = this.visit(e.array);
        const index = this.visit(e.index);
        if (array !== e.array || index !== e.index)
            return new SqlArrayIndexExpression(e.type, array, index);
        return e;
    }

    visitTableValuedFunction(e: SqlTableValuedFunctionExpression): Expression {
        const args = this.visitArray(e.arguments, a => this.visit(a));
        if (args !== e.arguments)
            return new SqlTableValuedFunctionExpression(e.alias, e.functionName, e.columnName, args);
        return e;
    }

    visitSqlCast(cast: SqlCastExpression): Expression {
        const exp = this.visit(cast.expression);
        if (exp !== cast.expression)
            return new SqlCastExpression(cast.type, exp, cast.sqlType);
        return cast;
    }

    visitToDayOfWeek(e: ToDayOfWeekExpression): Expression {
        const exp = this.visit(e.expression);
        if (exp !== e.expression)
            return new ToDayOfWeekExpression(exp);
        return e;
    }

    visitSqlLiteral(sle: SqlLiteralExpression): Expression {
        return sle;
    }

    visitCase(cex: CaseExpression): Expression {
        const whens = this.visitArray(cex.whens, w => this.visitWhen(w));
        const def = this.visit(cex.defaultValue);
        if (whens !== cex.whens || def !== cex.defaultValue)
            return new CaseExpression(whens, def);
        return cex;
    }

    visitWhen(when: When): When {
        const condition = this.visit(when.condition);
        const value = this.visit(when.value);
        if (condition !== when.condition || value !== when.value)
            return new When(condition, value);
        return when;
    }

    visitLike(like: LikeExpression): Expression {
        const exp = this.visit(like.expression);
        const pattern = this.visit(like.pattern);
        if (exp !== like.expression || pattern !== like.pattern)
            return new LikeExpression(exp, pattern);
        return like;
    }

    visitScalar(scalar: ScalarExpression): Expression {
        const select = this.visit(scalar.select!) as SelectExpression;
        if (select !== scalar.select)
            return new ScalarExpression(scalar.type, select);
        return scalar;
    }

    visitInterval(interval: IntervalExpression): Expression {
        const min = interval.min == null ? undefined : this.visit(interval.min);
        const max = interval.max == null ? undefined : this.visit(interval.max);
        const range = interval.postgresRange == null ? undefined : this.visit(interval.postgresRange);
        if (min !== interval.min || max !== interval.max || range !== interval.postgresRange)
            return new IntervalExpression(interval.boundType, min, max, range);
        return interval;
    }

    visitExists(exists: ExistsExpression): Expression {
        const select = this.visit(exists.select!) as SelectExpression;
        if (select !== exists.select)
            return new ExistsExpression(select);
        return exists;
    }

    visitIn(inExp: InExpression): Expression {
        const expression = this.visit(inExp.expression);
        const select = inExp.select == null ? undefined : this.visit(inExp.select) as SelectExpression;
        if (expression !== inExp.expression || select !== inExp.select) {
            return select != null
                ? new InExpression(expression, select, undefined)
                : InExpression.fromValues(expression, inExp.values!);
        }
        return inExp;
    }

    visitIsNull(isNull: IsNullExpression): Expression {
        const exp = this.visit(isNull.expression);
        if (exp !== isNull.expression)
            return new IsNullExpression(exp);
        return isNull;
    }

    visitIsNotNull(isNotNull: IsNotNullExpression): Expression {
        const exp = this.visit(isNotNull.expression);
        if (exp !== isNotNull.expression)
            return new IsNotNullExpression(exp);
        return isNotNull;
    }

    visitProjection(proj: ProjectionExpression): Expression {
        const select = this.visit(proj.select) as SelectExpression;
        const projector = this.visit(proj.projector);
        if (select !== proj.select || projector !== proj.projector)
            return new ProjectionExpression(select, projector, proj.uniqueFunction, proj.type);
        return proj;
    }

    visitLiteReference(lite: LiteReferenceExpression): Expression {
        const reference = this.visit(lite.reference) as LiteReferenceTarget;
        const toStr = this.visit(lite.toStr);
        if (reference !== lite.reference || toStr !== lite.toStr)
            return new LiteReferenceExpression(lite.type, reference, toStr, lite.expandLite);
        return lite;
    }

    visitLiteValue(lite: LiteValueExpression): Expression {
        const typeId = this.visit(lite.typeId);
        const id = this.visit(lite.id);
        const toStr = this.visit(lite.toStr);
        let models = lite.models;
        if (lite.models != null) {
            let changed = false;
            const next = new Map<Function, Expression>();
            for (const [ctor, model] of lite.models) {
                const v = this.visit(model);
                if (v !== model) changed = true;
                next.set(ctor, v);
            }
            if (changed) models = next;
        }
        if (typeId !== lite.typeId || id !== lite.id || toStr !== lite.toStr || models !== lite.models)
            return new LiteValueExpression(lite.type, typeId, id, toStr, models);
        return lite;
    }

    visitImplementedBy(ib: ImplementedByExpression): Expression {
        let changed = false;
        const implementations = new Map<Function, EntityExpression>();
        for (const [ctor, ee] of ib.implementations) {
            const visited = this.visit(ee) as EntityExpression;
            if (visited !== ee) changed = true;
            implementations.set(ctor, visited);
        }
        return changed ? new ImplementedByExpression(ib.type, ib.strategy, implementations) : ib;
    }

    visitImplementedByAll(iba: ImplementedByAllExpression): Expression {
        let changed = false;
        const ids = new Map<string, Expression>();
        for (const [pk, e] of iba.ids) {
            const v = this.visit(e);
            if (v !== e) changed = true;
            ids.set(pk, v);
        }
        const typeId = this.visit(iba.typeId) as TypeImplementedByAllExpression;
        if (changed || typeId !== iba.typeId)
            return new ImplementedByAllExpression(iba.type, ids, typeId);
        return iba;
    }

    visitTypeImplementedByAll(t: TypeImplementedByAllExpression): Expression {
        const typeColumn = this.visit(t.typeColumn);
        if (typeColumn !== t.typeColumn)
            return new TypeImplementedByAllExpression(typeColumn);
        return t;
    }

    visitTypeEntity(t: TypeEntityExpression): Expression {
        const externalId = this.visit(t.externalId) as PrimaryKeyExpression;
        if (externalId !== t.externalId)
            return new TypeEntityExpression(externalId, t.typeValue);
        return t;
    }

    visitTypeImplementedBy(t: TypeImplementedByExpression): Expression {
        let changed = false;
        const map = new Map<Function, PrimaryKeyExpression>();
        for (const [ctor, id] of t.typeImplementations) {
            const visited = this.visit(id) as PrimaryKeyExpression;
            if (visited !== id) changed = true;
            map.set(ctor, visited);
        }
        return changed ? new TypeImplementedByExpression(map) : t;
    }

    visitFieldEntityArray(fea: FieldEntityArrayExpression): Expression {
        const ownerId = this.visit(fea.ownerId);
        if (ownerId !== fea.ownerId)
            return new FieldEntityArrayExpression(fea.type, fea.childTable, fea.fkProperty, ownerId);
        return fea;
    }

    visitChildProjection(child: ChildProjectionExpression): Expression {
        const proj = this.visit(child.projection) as ProjectionExpression;
        const key = this.visit(child.outerKey);
        if (proj !== child.projection || key !== child.outerKey)
            return new ChildProjectionExpression(proj, key, child.isLazyMList, child.type, child.token);
        return child;
    }

    visitPrimaryKey(pk: PrimaryKeyExpression): Expression {
        const value = this.visit(pk.value);
        if (value !== pk.value)
            return new PrimaryKeyExpression(value);
        return pk;
    }

    visitEntity(ee: EntityExpression): Expression {
        const externalId = this.visit(ee.externalId) as PrimaryKeyExpression;
        const bindings = ee.bindings == null ? undefined : this.visitArray(ee.bindings, b => this.visitFieldBinding(b));
        const mixins = ee.mixins == null ? undefined : this.visitArray(ee.mixins, m => this.visitMixinEntity(m));
        if (externalId !== ee.externalId || bindings !== ee.bindings || mixins !== ee.mixins)
            return new EntityExpression(ee.type, ee.table, externalId, ee.tableAlias, bindings, mixins, ee.avoidExpandOnRetrieving);
        return ee;
    }

    visitEmbeddedEntity(eee: EmbeddedEntityExpression): Expression {
        const hasValue = this.visit(eee.hasValue);
        const bindings = this.visitArray(eee.bindings, b => this.visitFieldBinding(b));
        const mixins = eee.mixins == null ? undefined : this.visitArray(eee.mixins, m => this.visitMixinEntity(m));
        if (hasValue !== eee.hasValue || bindings !== eee.bindings || mixins !== eee.mixins)
            return new EmbeddedEntityExpression(eee.type, hasValue, bindings, mixins);
        return eee;
    }

    visitMixinEntity(me: MixinEntityExpression): MixinEntityExpression {
        const bindings = this.visitArray(me.bindings, b => this.visitFieldBinding(b));
        if (bindings !== me.bindings)
            return new MixinEntityExpression(me.type, bindings, me.mainEntityAlias);
        return me;
    }

    visitFieldBinding(fb: FieldBinding): FieldBinding {
        const binding = this.visit(fb.binding);
        if (binding !== fb.binding)
            return new FieldBinding(fb.fieldInfo, binding);
        return fb;
    }

    visitColumnDeclaration(cd: ColumnDeclaration): ColumnDeclaration {
        const e = this.visit(cd.expression);
        if (e !== cd.expression)
            return new ColumnDeclaration(cd.name, e);
        return cd;
    }

    visitOrderBy(o: OrderExpression): OrderExpression {
        const e = this.visit(o.expression);
        if (e !== o.expression)
            return new OrderExpression(o.orderType, e);
        return o;
    }

    // ---- command nodes (bulk DML) ----------------------------------------

    visitDelete(delete_: DeleteExpression): Expression {
        const source = this.visitSource(delete_.source) as SourceWithAliasExpression;
        const where = this.visit(delete_.where);
        if (source !== delete_.source || where !== delete_.where)
            return new DeleteExpression(delete_.table, source, where, delete_.returnRowCount, delete_.alias);
        return delete_;
    }

    visitUpdate(update: UpdateExpression): Expression {
        const source = this.visitSource(update.source) as SourceWithAliasExpression;
        const where = this.visit(update.where);
        const assignments = this.visitArray(update.assignments, a => this.visitColumnAssignment(a));
        if (source !== update.source || where !== update.where || assignments !== update.assignments)
            return new UpdateExpression(update.table, source, where, assignments, update.returnRowCount);
        return update;
    }

    visitInsertSelect(insert: InsertSelectExpression): Expression {
        const source = this.visitSource(insert.source) as SourceWithAliasExpression;
        const assignments = this.visitArray(insert.assignments, a => this.visitColumnAssignment(a));
        if (source !== insert.source || assignments !== insert.assignments)
            return new InsertSelectExpression(insert.table, source, assignments, insert.returnRowCount);
        return insert;
    }

    visitColumnAssignment(c: ColumnAssignment): ColumnAssignment {
        const exp = this.visit(c.expression);
        if (exp !== c.expression)
            return new ColumnAssignment(c.column, exp);
        return c;
    }

    visitCommandAggregate(ca: CommandAggregateExpression): Expression {
        const commands = this.visitArray(ca.commands, c => this.visit(c) as CommandExpression);
        if (commands !== ca.commands)
            return new CommandAggregateExpression(commands);
        return ca;
    }
}
