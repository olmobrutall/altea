import {
    Expression, CallExpression, PropertyExpression, IndexExpression, ParameterExpression,
    LambdaExpression, ConstantExpression, CastExpression, BinaryExpression,
    ConditionalExpression, ObjectExpression, UnaryExpression, viewColumns,
} from "../expressions";
import {
    SelectExpression, ProjectionExpression, ColumnExpression, PrimaryKeyExpression,
    FieldBinding, EntityExpression, EmbeddedEntityExpression, MixinEntityExpression,
    SqlConstantExpression, TableExpression, OrderExpression, OrderType, UniqueFunction,
    AggregateExpression, AggregateRequestsExpression, AggregateSqlFunction, RowNumberExpression, ColumnDeclaration, InExpression,
    SourceExpression, SqlFunctionExpression, SqlCastExpression, SelectOptions, FieldEntityArrayExpression, JoinExpression, JoinType,
    LiteReferenceExpression, LiteReferenceTarget, ScalarExpression, ExistsExpression,
    ImplementedByExpression, ImplementedByAllExpression, TypeImplementedByAllExpression,
    TypeEntityExpression, TypeImplementedByExpression, CombineStrategy,
    CaseExpression, When, IsNotNullExpression, IsNullExpression, SetOperatorExpression, SourceWithAliasExpression,
    CommandExpression, CommandAggregateExpression, ColumnAssignment,
    DeleteExpression, UpdateExpression, InsertSelectExpression,
    SqlArrayIndexExpression, SqlTableValuedFunctionExpression,
} from "../expressions.sql";
import { AssignAdapterExpander } from "./AssignAdapterExpander";
import { AliasGenerator, Alias } from "../AliasGenerator";
import { projectColumns as projectColumnsImpl, ProjectedColumns } from "./ColumnProjector";
import { ColumnGenerator } from "../ColumnGenerator";
import { fullNominate as fullNominateImpl, nominate } from "../dbExpressionNominator";
import { QueryJoinExpander, TableRequest, ExpansionRequest, UniqueRequest } from "./QueryJoinExpander";
import { AliasReplacer, DeclaredAliasGatherer, UniqueRequestKey } from "./AliasReplacer";
import { EntityCompleter } from "./EntityCompleter";
import { GroupEntityCleaner } from "./GroupEntityCleaner";
import { SmartEqualizer } from "../smartEqualizer";
import { TypeLogic } from "../../typeLogic";
import { ExpandLite, ExpandEntity } from "../../query";
import type { ExpandLiteHint } from "../expressions.sql";

// Map the altea ExpandLite enum (its member order differs from Signum's) to the neutral
// string hint carried on LiteReferenceExpression.
function expandLiteHintOf(v: ExpandLite): ExpandLiteHint {
    switch (v) {
        case ExpandLite.EntityEager: return "EntityEager";
        case ExpandLite.ModelEager: return "ModelEager";
        case ExpandLite.ModelLazy: return "ModelLazy";
        case ExpandLite.ModelNull: return "ModelNull";
        default: throw new Error("Unknown ExpandLite hint: " + v);
    }
}
import type { Schema } from "../../schema/schema";
import type { Table } from "../../schema/table";
import type { EntityField } from "../../schema/field";
import {
    FieldPrimaryKey, FieldValue, FieldReference, FieldEnum, FieldEmbedded, FieldEntityArray,
    FieldImplementedBy, FieldImplementedByAll,
} from "../../schema/field";
import type { FieldInfo } from "../../../entities/reflection";
import { resolveType, resolveEnum } from "../../../entities/registration";
import { Entity, View } from "../../../entities/entity";
import { TypeEntity } from "../../../entities/typeEntity";
import { toInt, toLong, inSql } from "../../../entities/basics";
import { Lite } from "../../../entities/lite";
import { niceName } from "../../../entities/utils/localization";
import { ArrayType, ClassType, EnumType, LiteType, LiteralType, ObjectType, TemporalType, Type } from "../../../entities/types";
import { ExpressionVisitor } from "./ExpressionVisitor";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

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

// A View subclass constructor — the target of an in-query `Ctor.create({ … })` projection.
function isViewCtor(value: unknown): value is Function {
    return typeof value === "function" && (value === View || (value as Function).prototype instanceof View);
}

// A `receiver.<name>(...)` call in the source AST (a CallExpression on a named
// PropertyExpression) — used to inspect a flatMap selector body before binding.
function isMethodCall(e: Expression, name: string): boolean {
    return e instanceof CallExpression && e.func instanceof PropertyExpression && e.func.propertyName === name;
}

function isNoArgMethodCall(e: Expression, name: string): boolean {
    return isMethodCall(e, name) && (e as CallExpression).args.length === 0;
}

// A bound expression that denotes the runtime type of a reference (Signum's three
// Type* nodes) — the cases SmartEqualizer.typeEqual knows how to compare.
function isTypeExpression(e: Expression): boolean {
    return e instanceof TypeEntityExpression || e instanceof TypeImplementedByExpression
        || e instanceof TypeImplementedByAllExpression;
}

function ctorOfType(type: Type): Function {
    if (type instanceof ClassType)
        return type.constructorFunction;
    throw new Error("Expected a ClassType for an entity reference");
}

// The inner (referenced) type of a `Lite<T>` — the type to combine when the
// selector returns a Lite over each implementation.
function liteInner(type: Type): Type {
    return type instanceof LiteType ? type.entityType : type;
}

// Signum's ICombineStrategy: given the per-implementation values (keyed by
// implementation ctor) of a leaf/scalar sub-expression, produce the single SQL
// expression that reconstructs it across the implementations. The recursion in
// `combineImplementations` walks the reference structure and calls this only at
// the leaves. The Case strategy (SwitchStrategy) builds a CASE; the Union strategy
// (a UnionAllRequest, added later) projects the leaves into union columns.
interface ICombineStrategy {
    combineValues(implementations: ReadonlyMap<Function, Expression>, returnType: Type): Expression;
}

// Signum's SwitchStrategy: combine the per-implementation values with a CASE keyed
// on which implementation's FK column is non-null. Holds the original IB so every
// leaf uses the same WHEN conditions (the implementation id columns), regardless of
// how deep into the reference structure the recursion has gone.
class SwitchStrategy implements ICombineStrategy {
    constructor(private readonly ib: ImplementedByExpression) { }

    combineValues(implementations: ReadonlyMap<Function, Expression>, _returnType: Type): Expression {
        const whens: When[] = [];
        for (const [ctor, ee] of this.ib.implementations)
            whens.push(new When(new IsNotNullExpression(ee.externalId.value), implementations.get(ctor)!));
        return new CaseExpression(whens, undefined);
    }
}

// Map each value of a keyed map through `fn`, preserving the (implementation ctor)
// keys — the workhorse of `combineImplementations`' structural recursion.
function mapValues(map: ReadonlyMap<Function, Expression>, fn: (v: Expression) => Expression): Map<Function, Expression> {
    const out = new Map<Function, Expression>();
    for (const [k, v] of map)
        out.set(k, fn(v));
    return out;
}

// One implementation's contribution to a UNION combine (Signum's UnionEntity): the
// fully-projected entity at its own table alias, the inner SELECT's alias, and —
// filled by completedUnion — the union column carrying this implementation's id (the
// join key back to the owner's FK).
interface UnionEntity {
    readonly entity: EntityExpression;
    readonly tableExpr: TableExpression;
    readonly selectAlias: Alias;
    unionExternalId?: ColumnExpression;
}

// A leaf value about to become a union column: either ready to project as-is
// (`plain`) or needing per-implementation column extraction (`dirty` — Signum's
// DityExpression, projected via ColumnUnionProjector).
type Nominable =
    | { readonly kind: "plain"; readonly expr: Expression }
    | { readonly kind: "dirty"; readonly projector: Expression; readonly candidates: Set<Expression> };

// Signum's UnionAllRequest: the UNION combine strategy. Builds one inner SELECT per
// implementation, declaring exactly the columns the navigation needs (accumulated as
// `combineValues` runs), folds them into a UNION ALL, and joins the whole once to the
// owner on the per-implementation id columns. Implements ICombineStrategy so
// combineImplementations drives it at the leaves, and exposes buildJoin() so the
// QueryJoinExpander can splice it in.
class UnionAllRequest implements ICombineStrategy {
    private readonly declarations = new Map<string, Map<Function, Expression>>();
    private readonly usedNames = new Set<string>();
    private nextName = 0;

    constructor(
        readonly originalIb: ImplementedByExpression,
        readonly unionAlias: Alias,
        readonly implementations: ReadonlyMap<Function, UnionEntity>,
        private readonly isPostgres: boolean,
    ) { }

    private uniqueName(suggested: string): string {
        let candidate = suggested;
        let suffix = 1;
        while (this.usedNames.has(candidate.toLowerCase()))
            candidate = suggested + (suffix++);
        this.usedNames.add(candidate.toLowerCase());
        return candidate;
    }

    // Declare a union column whose value per implementation is `getColumn(ctor)`.
    // Returns the outer reference to it (unionAlias.name).
    addUnionColumn(type: Type, suggestedName: string, getColumn: (ctor: Function) => Expression): ColumnExpression {
        const name = this.uniqueName(suggestedName || ("c" + this.nextName++));
        const perImpl = new Map<Function, Expression>();
        for (const ctor of this.implementations.keys())
            perImpl.set(ctor, getColumn(ctor));
        this.declarations.set(name, perImpl);
        return new ColumnExpression(type, this.unionAlias, name);
    }

    // A union column carrying `expression` only for `implementation` (NULL elsewhere).
    addIndependentColumn(type: Type, suggestedName: string, implementation: Function, expression: Expression): ColumnExpression {
        const nullValue = new SqlConstantExpression(null, type);
        return this.addUnionColumn(type, suggestedName, ctor => ctor === implementation ? expression : nullValue);
    }

    // The SELECT-list declarations for one implementation's inner SELECT.
    getDeclarations(ctor: Function): ColumnDeclaration[] {
        return [...this.declarations].map(([name, perImpl]) => new ColumnDeclaration(name, perImpl.get(ctor)!));
    }

    // Whether a leaf can be projected directly (a column / fully server-side
    // expression) or needs per-implementation candidate extraction.
    private getNominable(exp: Expression): Nominable {
        if (exp instanceof ColumnExpression)
            return { kind: "plain", expr: exp };
        const { candidates, expression } = nominate(exp, this.isPostgres);
        if (candidates.has(expression))
            return { kind: "plain", expr: expression };
        return { kind: "dirty", projector: expression, candidates };
    }

    combineValues(implementations: ReadonlyMap<Function, Expression>, returnType: Type): Expression {
        const values = new Map<Function, Nominable>();
        for (const [ctor, exp] of implementations)
            values.set(ctor, this.getNominable(exp));

        // Every implementation projects a single server expression → one shared union
        // column whose value is that implementation's expression.
        if ([...values.values()].every(v => v.kind === "plain")) {
            const first = ([...values.values()][0] as { expr: Expression }).expr;
            return this.addUnionColumn(returnType, defaultColumnName(first),
                ctor => (values.get(ctor) as { expr: Expression }).expr);
        }

        // Otherwise combine with a CASE keyed on which implementation's union id is
        // set; each branch projects that implementation's leaf into its own column(s).
        const whens: When[] = [];
        for (const [ctor, v] of values) {
            const condition = new IsNotNullExpression(this.implementations.get(ctor)!.unionExternalId!);
            if (v.kind === "plain") {
                const col = this.addIndependentColumn(v.expr.type, defaultColumnName(v.expr), ctor, v.expr);
                whens.push(new When(condition, col));
            } else {
                const projector = ColumnUnionProjector.project(v.projector, v.candidates, this, ctor);
                whens.push(new When(condition, projector));
            }
        }
        return new CaseExpression(whens, undefined);
    }

    // Splice the UNION ALL sub-select in as a SingleRow LEFT OUTER JOIN on the owner's
    // FK columns (Signum's ApplyExpansions UnionAllRequest branch).
    buildJoin(source: SourceExpression): SourceExpression {
        const inner: SourceWithAliasExpression[] = [...this.implementations].map(([ctor, ue]) =>
            new SelectExpression(ue.selectAlias, false, undefined, this.getDeclarations(ctor), ue.tableExpr, undefined, [], []));
        const union = inner.reduce((a, b) => new SetOperatorExpression("UnionAll", a, b, this.unionAlias));

        const terms = [...this.implementations].map(([ctor, ue]) => {
            const uid = ue.unionExternalId!;
            const eid = this.originalIb.implementations.get(ctor)!.externalId.value;
            return new BinaryExpression("||",
                new BinaryExpression("==", uid, eid),
                new BinaryExpression("&&", new IsNullExpression(uid), new IsNullExpression(eid)));
        });
        const condition = terms.reduce((a, b) => new BinaryExpression("&&", a, b) as BinaryExpression);
        return new JoinExpression("SingleRowLeftOuterJoin", source, union, condition);
    }
}

// The implementation's short name for a union id column (Signum's CleanTypeName):
// the constructor name without a trailing "Entity".
function cleanTypeName(ctor: Function): string {
    return ctor.name.replace(/Entity$/, "");
}

// A suggested union-column name from a leaf expression — a source column keeps its
// name; anything else falls back to a generic "val".
function defaultColumnName(exp: Expression): string {
    if (exp instanceof ColumnExpression)
        return exp.name ?? "val";
    if (exp instanceof SqlCastExpression)
        return defaultColumnName(exp.expression);
    return "val";
}

// Signum's ColumnUnionProjector: rewrite a per-implementation leaf so its nominated
// candidate columns/expressions are projected into that implementation's union
// columns and read back from the union alias.
// Signum's UsedAliasGatherer.Externals: the distinct table aliases a (correlation)
// expression reads columns from. Used by GetCurrentSource to decide which stacked
// source a completion join must attach to.
class AliasGatherer extends DbExpressionVisitor {
    readonly aliases: Alias[] = [];

    static gather(e: Expression): Alias[] {
        const g = new AliasGatherer();
        g.visit(e);
        return g.aliases;
    }

    override visitColumn(c: ColumnExpression): Expression {
        if (!this.aliases.some(a => a.equals(c.alias)))
            this.aliases.push(c.alias);
        return c;
    }
}

// Signum's ContainsAggregateVisitor: does an expression contain a SQL aggregate anywhere
// (including inside a correlated subquery)? Used by bindGroupBy to detect a grouping key that
// SQL Server won't accept directly (it must be projected into an intermediate select first).
class ContainsAggregateVisitor extends DbExpressionVisitor {
    private found = false;

    static test(e: Expression): boolean {
        const visitor = new ContainsAggregateVisitor();
        visitor.visit(e);
        return visitor.found;
    }

    override visitAggregate(aggregate: AggregateExpression): Expression {
        this.found = true;
        return aggregate;
    }
}

// Signum's ColumnReplacerVisitor: rewrite every ColumnExpression that matches one of the
// replacements (keyed by alias|name) to its replacement. Used to re-point a group key's
// projector at the wrapping group-by select after the key was pushed into an intermediate.
class ColumnReplacerVisitor extends DbExpressionVisitor {
    constructor(private readonly replacements: Map<string, ColumnExpression>) { super(); }

    static replace(replacements: Map<string, ColumnExpression>, e: Expression): Expression {
        return new ColumnReplacerVisitor(replacements).visit(e);
    }

    override visitColumn(column: ColumnExpression): Expression {
        return this.replacements.get(columnKey(column)) ?? column;
    }
}

function columnKey(column: ColumnExpression): string {
    return `${column.alias}|${column.name}`;
}

class ColumnUnionProjector extends DbExpressionVisitor {
    private readonly map = new Map<ColumnExpression, ColumnExpression>();

    private constructor(
        private readonly candidates: Set<Expression>,
        private readonly request: UnionAllRequest,
        private readonly implementation: Function,
    ) { super(); }

    static project(projector: Expression, candidates: Set<Expression>, request: UnionAllRequest, implementation: Function): Expression {
        return new ColumnUnionProjector(candidates, request, implementation).visit(projector);
    }

    override visit(e: Expression): Expression;
    override visit(e: Expression | undefined): Expression | undefined;
    override visit(e: Expression | undefined): Expression | undefined {
        if (e == null)
            return undefined;
        if (this.candidates.has(e)) {
            if (e instanceof ColumnExpression) {
                const cached = this.map.get(e);
                if (cached != null)
                    return cached;
                const mapped = this.request.addIndependentColumn(e.type, e.name ?? "c", this.implementation, e);
                this.map.set(e, mapped);
                return mapped;
            }
            return this.request.addIndependentColumn(e.type, "v", this.implementation, e);
        }
        return super.visit(e);
    }
}

// The @implementedByAll type-discriminator constant for a ctor — the target's
// TypeEntity int id (Signum's TypeToId). Emitted as an inline SQL literal (not a
// bound parameter): these constants only appear as CASE branch values when
// combining a type discriminator, and an all-parameter CASE gives the DB no type
// to infer (Postgres would default the params to text and clash with the integer
// discriminator column). An inline integer literal types the branch unambiguously.
function typeConstant(ctor: Function): Expression {
    return new SqlConstantExpression(TypeLogic.typeToId(ctor), LiteralType.number);
}

// Relational-join operator → SQL join type. leftJoin preserves the outer (left)
// source, rightJoin the inner (right), fullJoin both. A Map (not a plain object) so a
// method named like an Object.prototype member — notably `toString` — doesn't
// spuriously resolve to an inherited property and get mis-dispatched as a join.
const JOIN_TYPES = new Map<string, JoinType>([
    ["innerJoin", "InnerJoin"],
    ["leftJoin", "LeftOuterJoin"],
    ["rightJoin", "RightOuterJoin"],
    ["fullJoin", "FullOuterJoin"],
]);

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
    private readonly requests = new Map<SourceExpression, ExpansionRequest[]>();
    private readonly sourceStack: SourceExpression[] = [];
    private readonly entityReplacements = new Map<EntityExpression, EntityExpression>();
    // Dedupe the UNION combine of an @implementedBy reference (Signum's
    // implementedByReplacements) — the same combineUnion() reference navigated more
    // than once reuses one UNION ALL join.
    private readonly unionReplacements = new Map<ImplementedByExpression, UnionAllRequest>();
    // Dedupe correlated APPLY subqueries (Signum's uniqueFunctionReplacements, keyed by
    // DbExpressionComparer). The same `first()/single(...)` subquery used more than once
    // (e.g. in a filter AND a map) must emit exactly one APPLY. We key by a canonical
    // signature: the subquery's OWN declared aliases renamed to positional names, so two
    // structurally-identical selects that differ only in their fresh aliases collide.
    // Value is the navigable projector returned to every binding site.
    private readonly uniqueFunctionReplacements = new Map<string, Expression>();

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

    // ---- EntityCompleter surface ------------------------------------------
    // A few binder operations EntityCompleter (a separate visitor) needs, mirroring
    // Signum where EntityCompleter calls back into the binder.

    // Run `fn` with `source` as the current completion source (Signum's
    // SetCurrentSource): joins requested while binding the projector attach to it.
    runWithSource<T>(source: SourceExpression, fn: () => T): T {
        this.sourceStack.push(source);
        try { return fn(); }
        finally { this.sourceStack.pop(); }
    }

    // The display-string (`toStr`) SQL expression for a lite's reference, completing it
    // (a LEFT-OUTER-JOIN request) so its ToStr column is reachable; undefined when the
    // reference has no translatable ToString (IBA / @quoted with no column).
    liteModelExpression(reference: Expression): Expression | undefined {
        return this.entityToStringOf(reference);
    }

    // Per-implementation display models for an @implementedBy lite (Signum's
    // EntityCompleter.GetModels dictionary): each concrete type's own ToString, completed
    // independently — NOT combined into a CASE. The reader dispatches on the runtime type
    // and evaluates the matching model client-side, so no CASE reaches the projector.
    liteImplementationModels(ib: ImplementedByExpression): Map<Function, Expression> {
        const models = new Map<Function, Expression>();
        for (const [ctor, ee] of ib.implementations) {
            const model = this.entityToString(ee);
            if (model != null)
                models.set(ctor, model);
        }
        return models;
    }

    // The id / type-discriminator of a lite's reference (Signum's binder.GetId /
    // binder.GetEntityType), exposed for EntityCompleter to build a LiteValueExpression.
    liteId(reference: LiteReferenceTarget): Expression {
        return this.idOfReference(reference);
    }

    liteTypeId(reference: LiteReferenceTarget): Expression {
        return this.getEntityType(reference);
    }

    // Split a projector into SELECT columns + a rebuilt projector (Signum's
    // ColumnProjector.ProjectColumns), used by EntityCompleter to re-project a wrapped
    // select.
    splitColumns(projector: Expression, alias: Alias): ProjectedColumns {
        return this.projectColumns(projector, alias);
    }

    // Public wrapper over `completed` for EntityCompleter (Signum calls binder.Completed
    // from EntityCompleter.VisitEntity to eager-expand a retrieved reference).
    completeEntity(ee: EntityExpression): EntityExpression {
        return this.completed(ee);
    }

    bindQuery(expr: Expression): ProjectionExpression {
        this.root = expr;
        const result = this.visit(expr);
        if (!(result instanceof ProjectionExpression))
            throw new Error("Query did not bind to a ProjectionExpression: " + result.toString());
        // EntityCompleter: fill projected lites' eager model (toStr), wrapping the
        // projection so its completion joins attach correctly (Signum runs this before
        // join expansion). Then splice in all implicit joins (navigation + completion).
        const completed = EntityCompleter.complete(result, this);
        const expanded = QueryJoinExpander.expand(completed, this.requests);
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
        // recorded during binding into the command's source selects. The alias generator
        // lets QueryJoinExpander wrap a join-expanded source back into a SELECT.
        return QueryJoinExpander.expand(command, this.requests, this.aliasGenerator) as CommandExpression;
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

        // Signum's BindUpdate: the assignment COLUMNS name the target table (toUpdate),
        // but the assignment VALUES are read from the ROOT source row (pr.projector) — the
        // update-part correlates the target to the source, so a value can reach any field
        // of the source projection, not just the navigated part. Setter navigations bind
        // against `pr.select` (Signum uses `pr.Select.From!`, but altea materialises a
        // projection's columns eagerly, so the projector's ids reference pr.select's own
        // alias — the completion join must attach there). QueryJoinExpander then wraps the
        // join-expanded source back into a SELECT so the UPDATE joins the target only via
        // `where` (the inner query stays a normal SELECT).
        const assignments = this.buildAssignments(toUpdate, setter, pr.select, pr.projector);

        const idCol = new ColumnExpression(LiteralType.number, tableAlias, table.primaryKey.column.name);
        const where = new BinaryExpression("==", idCol, this.unwrapPk(entity.externalId));
        return new CommandAggregateExpression([new UpdateExpression(table, pr.select, where, assignments, true)]);
    }

    private bindInsert(sourceExpr: Expression, targetCtorExpr: Expression, selector: LambdaExpression): CommandExpression {
        const pr = this.bindSourceProjection(sourceExpr);
        const targetCtor = (targetCtorExpr as ConstantExpression).value as new () => object;
        // The target is either an included entity (schema.table) or a view / temp-table
        // (schema.view — Signum's UnsafeInsertView). An entity not in `tables` resolves
        // through the ViewBuilder, so `INSERT INTO #MyTempView (...) SELECT ...` targets the
        // temp table with its FK columns.
        const table = this.schema.tryTable(targetCtor as any) ?? this.schema.view(targetCtor as any);
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
                const colExpr = this.setterColumn(target, name);
                assignments.push(...this.adaptAssign(colExpr, value));
            }
        } finally {
            this.sourceStack.pop();
            if (old === undefined) this.map.delete(param); else this.map.set(param, old);
        }
        return assignments;
    }

    // Resolves a bulk-DML setter key (`{ field: value }`) to its target column expression. A key
    // is either a direct entity field or a MIXIN field (Signum's `a.Mixin<X>().Field` — altea
    // flattens a mixin's columns into the owner table, so the mixin field is a valid top-level
    // setter key, e.g. `executeUpdate(a => ({ corrupt: true } as Partial<CorruptMixin & T>))`).
    private setterColumn(target: EntityExpression, name: string): Expression {
        if (target.bindings?.some(b => b.fieldInfo.name === name))
            return this.bindMember(target, name, false);
        for (const mixin of target.mixins ?? [])
            if (mixin.bindings.some(b => b.fieldInfo.name === name))
                return this.bindMember(mixin, name, false);
        // Not a direct or mixin field — bindMember throws a clear "field not found" error.
        return this.bindMember(target, name, false);
    }

    private adaptAssign(colExpr: Expression, value: Expression): ColumnAssignment[] {
        // A partial-embedded setter value (a nested `{ subField: expr, … }` object literal) is
        // paired sub-field by sub-field in `assign`; each leaf is adapted there, so the object as
        // a whole must NOT be run through AssignAdapterExpander (which reshapes leaf values only).
        if (value instanceof ObjectExpression)
            return this.assign(colExpr, value);
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

        // A PARTIAL embedded update: a nested `{ subField: expr, … }` object literal sets only the
        // named sub-fields (Signum's `.Set(a => a.BonusTrack.Name, …)`). HasValue is left untouched
        // (setting a sub-column of a currently-null embedded leaves it null, as in Signum).
        if (col instanceof EmbeddedEntityExpression && value instanceof ObjectExpression) {
            const result: ColumnAssignment[] = [];
            for (const [subName, subVal] of Object.entries(value.properties))
                result.push(...this.adaptAssign(this.bindMember(col, subName, false), subVal));
            return result;
        }

        if (col instanceof EntityExpression && value instanceof EntityExpression)
            return [this.assignColumn(col.externalId.value, value.externalId.value)];

        if (col instanceof ImplementedByExpression && value instanceof ImplementedByExpression)
            return [...col.implementations].map(([ctor, ee]) =>
                this.assignColumn(ee.externalId.value, value.implementations.get(ctor)!.externalId.value));

        if (col instanceof ImplementedByAllExpression && value instanceof ImplementedByAllExpression) {
            // Set the id column matching the value's PK type; NULL the others.
            const result = [...col.ids].map(([pk, colId]) =>
                this.assignColumn(colId, value.ids.get(pk) ?? new SqlConstantExpression(null, LiteralType.null)));
            result.push(this.assignColumn(col.typeId.typeColumn, value.typeId.typeColumn));
            return result;
        }

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

    // A single-result sub-query (`…single()`, e.g. from an inDB expansion) used as a
    // value operand becomes a scalar subquery.
    private asScalarValue(e: Expression): Expression {
        return e instanceof ProjectionExpression && e.uniqueFunction != null
            ? new ScalarExpression(e.projector.type, e.select)
            : e;
    }

    // `obj[index]` → a Postgres array subscript `(...)[i]` (arrays are 1-based). The old
    // arrayGet(arr, i) marker lowered here too; now real element access flows through
    // IndexExpression.
    override visitIndex(node: IndexExpression): Expression {
        return new SqlArrayIndexExpression(node.type, this.visit(node.object), this.visit(node.index));
    }

    override visitCall(call: CallExpression): Expression {
        const func = call.func;

        // table(T) / view(T) source: a constant call on a marked query-source function.
        // `__isViewSource` resolves the ctor through schema.view() (a ViewBuilder view
        // table); otherwise through schema.table() (an included entity table).
        if (func instanceof ConstantExpression && (func.value as { __isQuerySource?: boolean })?.__isQuerySource) {
            const ctor = (call.args[0] as ConstantExpression).value as new () => object;
            if ((func.value as { __isViewSource?: boolean }).__isViewSource)
                return this.getTableProjectionForTable(this.schema.view(ctor as any), new ClassType(ctor));
            return this.getTableProjection(ctor);
        }

        // Query-only SQL functions recognised by their brand:
        //   __sqlMethod (Signum's [SqlMethod]) → a table-/set-returning source when the result
        //     type is an array (generate_subscripts, dbo.MinimumTableValued), else a scalar SQL
        //     function (pg_get_expr, …). See bindSqlMethod.
        // Each is a free function (a ConstantExpression callee), like table()/view().
        if (func instanceof ConstantExpression) {
            const brand = func.value as { __sqlMethod?: string } | null;
            if (brand?.__sqlMethod != null)
                return this.bindSqlMethod(brand.__sqlMethod, call);
            // toInt/toLong (entities/basics) are compile-time int/long brands over a number;
            // in a query the brand is meaningless, so lower the call to its argument (identity).
            if (func.value === toInt || func.value === toLong)
                return this.visit(call.args[0]);
            // inSql(x) (Signum's LinqHints.InSql): leave it a CallExpression marker (no
            // dedicated node — Signum keeps the MethodCallExpression) with the argument bound;
            // the nominator recognises it, force-nominates the argument into SQL and strips the
            // marker (defeating the lazy projector). Just re-bind the argument here.
            if (func.value === inSql)
                return new CallExpression(func, [this.visit(call.args[0])], call.type);
        }


        // Query operator: <source>.<op>(...args)
        if (func instanceof PropertyExpression || func.kind === ".") {
            const property = func as PropertyExpression;
            const op = property.propertyName;
            // EntityContext.entityId(x) (Signum's EntityContext.EntityId): the primary key
            // of the entity/row `x` belongs to. A static helper call, recognised by the
            // brand on the captured receiver constant.
            if (op === "entityId" && property.object instanceof ConstantExpression
                && (property.object.value as { __isEntityContext?: boolean } | null)?.__isEntityContext)
                return this.bindEntityId(call.args[0]);
            // A SQL function exposed as a static method (Signum's [SqlMethod] on a static class,
            // e.g. `MinimumExtensions.MinimumTableValued(...)` / `PostgresFunctions.pg_get_expr(...)`):
            // the receiver is a captured constant class and the member function carries the brand.
            // Route it exactly like a branded free-function call (below).
            if (property.object instanceof ConstantExpression) {
                const member = (property.object.value as Record<string, unknown> | null)?.[op];
                if (typeof member === "function") {
                    const brand = member as { __sqlMethod?: string };
                    if (brand.__sqlMethod != null)
                        return this.bindSqlMethod(brand.__sqlMethod, call);
                    // Runtime type-tests (entity.ts): `Ctor.isInstance(entity)` /
                    // `Ctor.isLite(lite)`. The receiver constant IS the type to test against;
                    // entityIsInstance lowers both (it unwraps a lite reference first), so a
                    // lite never goes through an `instanceof` that would fail at runtime.
                    if (member === Entity.isInstance || member === Entity.isLite)
                        return SmartEqualizer.entityIsInstance(this.visit(call.args[0]), property.object.value as Function);
                }
            }
            if (op === "thenBy")
                return this.bindThenBy(property.object, call.args[0] as LambdaExpression, "Ascending");
            if (op === "thenByDescending")
                return this.bindThenBy(property.object, call.args[0] as LambdaExpression, "Descending");
            // The relational joins need the raw sources (the inner source travels as
            // args[0]) and bind two result-selector params; the operator name fixes
            // the SQL join type.
            const joinType = JOIN_TYPES.get(op);
            if (joinType != null)
                return this.bindJoin(joinType, property.object, call.args[0], call.args[1] as LambdaExpression, call.args[2] as LambdaExpression, call.args[3] as LambdaExpression);

            let source = this.visit(property.object);

            // `Ctor.create({ … })` where Ctor is a View subclass: build a typed instance per
            // row. Bind the object-literal argument and tag it with the constructor so the
            // projector materialises `Ctor.create({ … })` instead of a plain object literal.
            if (op === "create" && source instanceof ConstantExpression && isViewCtor(source.value)) {
                const arg = this.visit(call.args[0]);
                if (!(arg instanceof ObjectExpression))
                    throw new Error(`${(source.value as Function).name}.create(...) expects an object literal argument`);
                return new ObjectExpression(arg.properties, source.value as Function);
            }

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
                case "defaultIfEmpty":
                    // The only legal defaultIfEmpty is peeled off a flatMap collection selector
                    // by extractDefaultIfEmpty *before* binding, so it never reaches here —
                    // anything that does (root, chained, in a projection) is misuse.
                    throw new Error("defaultIfEmpty() is only valid as the tail of a flatMap collection selector.");
                case "groupBy":
                    return this.bindGroupBy(source, property.object, call.args[0] as LambdaExpression, call.args[1] as LambdaExpression | undefined);
                case "toArray":
                    // Materialises the (sub-)query as a list. At the root it's a
                    // no-op; nested in a projector it stays a ProjectionExpression
                    // for ChildProjectionFlattener to extract as eager-loaded rows.
                    // (Inside a projector the caller writes `.toArray().$v` — the $v
                    // marker just casts the Promise<T[]> element type to T[].)
                    return source;
                case "orderBy":
                    return this.bindOrderBy(source, call.args[0] as LambdaExpression, "Ascending");
                case "orderByDescending":
                    return this.bindOrderBy(source, call.args[0] as LambdaExpression, "Descending");
                case "top":
                    return this.bindTop(source, call.args[0]);
                case "skip":
                    return this.bindSkip(source, call.args[0]);
                case "distinct":
                    return this.bindDistinct(source);
                case "expandLite":
                    return this.bindExpandLite(source, call.args[0] as LambdaExpression, call.args[1] as ConstantExpression);
                case "expandEntity":
                    return this.bindExpandEntity(source, call.args[0] as LambdaExpression, call.args[1] as ConstantExpression);
                case "first":
                    return this.bindUnique(source, "First", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "firstOrNull":
                    return this.bindUnique(source, "FirstOrDefault", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "reverse":
                    return this.bindReverse(source);
                case "orderAlsoByKeys":
                    return this.bindOrderAlsoByKeys(source);
                case "last":
                    return this.bindLast(source, "First", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "lastOrNull":
                    return this.bindLast(source, "FirstOrDefault", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "single":
                    return this.bindUnique(source, "Single", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "singleOrNull":
                    return this.bindUnique(source, "SingleOrDefault", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "count": {
                    // Disassemble the UNBOUND source (Signum's DisassembleAggregate) so a
                    // `map(sel).filter(notNull).distinct().count()` shape lowers to
                    // COUNT(DISTINCT sel) instead of a correlated COUNT(*) subquery.
                    const dis = this.disassembleAggregate("Count", property.object, call.args[0] as LambdaExpression | undefined);
                    if (dis.distinct) {
                        let inner = this.visit(dis.source);
                        if (inner instanceof FieldEntityArrayExpression)
                            inner = this.fieldEntityArrayProjection(inner);
                        return this.bindAggregate(this.asProjection(inner), "Count", dis.selector, call === this.root, true);
                    }
                    return this.bindAggregate(source, "Count", call.args[0] as LambdaExpression | undefined, call === this.root);
                }
                case "min":
                    return this.bindAggregate(source, "Min", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "max":
                    return this.bindAggregate(source, "Max", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "sum":
                    return this.bindAggregate(source, "Sum", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "avg":
                    return this.bindAggregate(source, "Average", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "stdDev":
                    return this.bindAggregate(source, "StdDev", call.args[0] as LambdaExpression | undefined, call === this.root);
                case "stdDevP":
                    return this.bindAggregate(source, "StdDevP", call.args[0] as LambdaExpression | undefined, call === this.root);
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
        // Distribute an entity-value method over a conditional / coalesce receiver — the
        // method-call analogue of the bindMember distribution (Signum re-binds the call
        // per branch, as the IB dispatch below already does): `(t ? a : b).m()` →
        // `t ? a.m() : b.m()`; `(a ?? b).m()` → `(a != null) ? a.m() : b.m()`.
        if (source instanceof ConditionalExpression)
            return new ConditionalExpression(source.condition,
                this.bindMethodCall(methodName, source.whenTrue, args, resultType),
                this.bindMethodCall(methodName, source.whenFalse, args, resultType));
        if (source instanceof BinaryExpression && source.kind === "??")
            return new ConditionalExpression(this.notNull(source.left),
                this.bindMethodCall(methodName, source.left, args, resultType),
                this.bindMethodCall(methodName, source.right, args, resultType));
        // A method on a null literal is null (Signum's null-propagation) — a null branch
        // of the distribution above (e.g. `(t ? null : x).toLite()`).
        if (isNullLiteral(source))
            return new ConstantExpression(null);

        // ref.combineUnion() / .combineCase() (Signum's LinqHintEntities markers):
        // swap the polymorphic combine strategy of an @implementedBy reference. The
        // reference is otherwise unchanged; the strategy governs how a later member
        // navigation combines the implementations (a CASE vs a UNION ALL subquery).
        if (methodName === "combineUnion" || methodName === "combineCase") {
            const strategy = methodName === "combineUnion" ? "Union" : "Case";
            if (source instanceof ImplementedByExpression)
                return new ImplementedByExpression(source.type, strategy, source.implementations);
            // On a non-polymorphic reference the hint is a no-op (a single or typed
            // implementation has nothing to combine); mirror Signum leniently.
            return source;
        }

        // entity.mixin(X) → the matching MixinEntityExpression on the (completed) entity
        // (Signum's BindMixin). `.field` off it then reads the mixin's column via bindMember.
        if (methodName === "mixin" && source instanceof EntityExpression) {
            const mixinCtor = this.constantCtor(args[0]);
            const completed = source.mixins != null ? source : this.completed(source);
            const mixin = completed.mixins?.find(m => m.type instanceof ClassType && m.type.constructorFunction === mixinCtor);
            if (mixin == null)
                throw new Error(`Mixin '${mixinCtor.name}' is not declared on '${(source.type as ClassType).constructorFunction?.name}'`);
            return mixin;
        }

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

        // entity.toString() / lite.toString() (Signum's BindMethodCall ToString path):
        // an entity with a physical ToStr column → read it (completing the reference);
        // a lite → recurse onto its wrapped reference; an IB → a CASE over each
        // implementation's ToStr. A @quoted (expression) toString has no column — it
        // would be expanded inline (the @quoted-member tier, not built yet) — and the
        // IBA / enum / value cases fall through to the nominator's residual call.
        if (methodName === "toString" && args.length === 0) {
            const toStr = this.entityToStringOf(source);
            if (toStr != null)
                return toStr;
        }

        // entity.is(x) / lite.is(x) → the server form of the in-memory identity
        // check, lowered by SmartEqualizer (handles typed refs, IB, IBA, captured
        // constants and null — comparing id and, for polymorphic refs, type).
        if (methodName === "is" && args.length === 1)
            return SmartEqualizer.polymorphicEqual(source, this.visit(args[0]));

        // f.constructor.toTypeEntity() / lite.entityType.toTypeEntity() (Signum's
        // Type.ToTypeEntity()): the TypeEntity row for a runtime-type expression, referenced by
        // its type-id discriminator and materialised as a full TypeEntity entity.
        if (methodName === "toTypeEntity" && isTypeExpression(source))
            return this.toTypeEntityRef(source);
        // f.constructor.niceName() (Signum's Type.NiceName()): the localized display name — a
        // constant for a typed entity, a CASE of per-implementation constants for an
        // @implementedBy; an @implementedByAll has no static type, so it throws.
        if (methodName === "niceName" && isTypeExpression(source))
            return this.typeNiceName(source);

        // A `@quoted` expression-member (Signum's AutoExpressionField) called on an entity
        // reference. Direct calls on a concrete type are inlined by the quote transform;
        // this handles the shapes it can't resolve statically — a polymorphic reference.
        // Mirrors Signum's QueryBinder: an @implementedBy dispatches the call to each
        // implementation (re-binding `impl.method(args)`), a concrete entity expands its
        // `@quoted` body, and a lite recurses onto its wrapped reference.
        {
            const expanded = this.tryExpandQuotedMember(source, methodName, args, resultType);
            if (expanded != null)
                return expanded;
        }

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
            // A captured collection of types (`types.contains(x.constructor)`) → an OR of
            // type-equalities (Signum's TypeIn) — else the Type* node flattens to garbage and
            // the ctor is bound as a value. A captured collection of entities/lites →
            // id-comparison membership (Signum's EntityIn); a collection of values → `item IN (…)`.
            return isTypeExpression(visitedArgs[0])
                ? SmartEqualizer.typeIn(visitedArgs[0], source.value)
                : isReferenceish(visitedArgs[0])
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
            const left = this.asScalarValue(this.visit(b.left));
            const right = this.asScalarValue(this.visit(b.right));
            const negate = b.kind === "!=" || b.kind === "!==";
            // `f.GetType() == typeof(X)` — a Type expression vs a captured ctor (or
            // another Type expression) lowers through SmartEqualizer.typeEqual.
            if (isTypeExpression(left) || isTypeExpression(right)) {
                const eq = SmartEqualizer.typeEqual(left, right);
                return negate ? SmartEqualizer.not(eq) : eq;
            }
            if (isReferenceish(left) || isReferenceish(right)
                || left instanceof EmbeddedEntityExpression || right instanceof EmbeddedEntityExpression) {
                const eq = SmartEqualizer.polymorphicEqual(left, right);
                return negate ? SmartEqualizer.not(eq) : eq;
            }
            return b.updateBinary(left, right);
        }

        return super.visitBinary(b);
    }

    // `x as T`: narrow a polymorphic reference to one implementation. For IB, pick
    // the matching implementation entity; for IBA, build a typed reference reusing
    // the id column (the join only matches rows of that type). Value casts and
    // already-concrete references are SQL no-ops — drop the cast.
    // `x as T`: narrow a polymorphic reference to one implementation. For IB, pick the
    // matching implementation entity; for IBA, build a typed reference reusing the id
    // column (the join only matches rows of that type). Value casts and already-concrete
    // references are SQL no-ops. (Cast/OfType lower to `x as T` in the ExpressionSimplifier.)
    override visitCast(cast: CastExpression): Expression {
        const expr = this.visit(cast.expression);
        const targetCtor = cast.type instanceof ClassType ? cast.type.constructorFunction : undefined;

        if (targetCtor != null) {
            // Entity downcast: narrow a polymorphic reference to one implementation.
            if (expr instanceof ImplementedByExpression || expr instanceof ImplementedByAllExpression) {
                const narrowed = this.narrowReference(expr, targetCtor);
                if (narrowed != null)
                    return narrowed;
            }
            // Lite downcast (`x as Lite<T>`): narrow the lite's *reference* the same way,
            // then rewrap as a lite of T. Rows whose type isn't T get a null id (the
            // narrowed reference's externalId is null), so the lite reads as null —
            // matching a C# `(Lite<T>)` downcast. toStr/expandLite are recomputed by the
            // completer, so carry them through unchanged.
            if (expr instanceof LiteReferenceExpression
                && (expr.reference instanceof ImplementedByExpression || expr.reference instanceof ImplementedByAllExpression)) {
                const narrowed = this.narrowReference(expr.reference, targetCtor);
                if (narrowed != null)
                    return new LiteReferenceExpression(new LiteType(new ClassType(targetCtor)), narrowed, expr.toStr, expr.expandLite);
            }
            // Concrete-entity cast: a cast up/down/across the *same* inheritance line is a
            // no-op (the row is that table). A cast to a DISJOINT type — a sibling in a
            // per-type-table hierarchy, e.g. `(AmericanMusicAwardEntity)(GrammyAwardEntity)` —
            // can never match a row, so it yields a null-id entity of the target (the
            // projection then reads null, matching a C# hard cast to the wrong runtime type).
            if (expr instanceof EntityExpression && expr.type instanceof ClassType) {
                const sourceCtor = expr.type.constructorFunction;
                const disjoint = sourceCtor !== targetCtor
                    && !(sourceCtor.prototype instanceof targetCtor)
                    && !(targetCtor.prototype instanceof sourceCtor);
                const refTable = disjoint ? this.schema.tryTable(targetCtor as any) : undefined;
                if (refTable != null)
                    return new EntityExpression(new ClassType(targetCtor), refTable,
                        new PrimaryKeyExpression(new SqlConstantExpression(null, LiteralType.null)),
                        undefined, undefined, undefined, false);
            }
        }

        return expr;
    }

    // Narrow a polymorphic reference (IB / IBA) to a single concrete implementation
    // (Signum's cast lowering). IB → the matching implementation's EntityExpression, whose
    // own FK column is already null for non-matching rows (undefined when `targetCtor` isn't
    // one of the implementations → the cast stays a no-op). IBA → a typed EntityExpression
    // reading the shared id column, but guarded by the type discriminator so a row of another
    // type nulls out (a bare id read would join a same-id row of the target table).
    private narrowReference(ref: ImplementedByExpression | ImplementedByAllExpression, targetCtor: Function): EntityExpression | undefined {
        if (ref instanceof ImplementedByExpression)
            return ref.implementations.get(targetCtor);
        const refTable = this.schema.table(targetCtor as any);
        const rawId = ref.ids.get(this.pkTypeOf(targetCtor)) ?? [...ref.ids.values()][0];
        // CASE WHEN <type column> = typeof(targetCtor) THEN <id> ELSE NULL END
        const typeMatch = SmartEqualizer.entityIsInstance(ref, targetCtor);
        const id = new CaseExpression([new When(typeMatch, rawId)], undefined);
        return new EntityExpression(new ClassType(targetCtor), refTable, new PrimaryKeyExpression(id), undefined, undefined, undefined, false);
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
    private projectColumns(projector: Expression, alias: Alias, aggressive = false): ProjectedColumns {
        return projectColumnsImpl(projector, alias, this.isPostgres, aggressive);
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
        const { expression, projection: proj } = this.mapVisitExpandIndexed(selector, projection);
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(expression, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, proj.select, undefined, [], []),
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
        for (const key of this.orderExpressions(selector, projection))
            orderBy.push(new OrderExpression(orderType, key));

        if (myThenBys != null) {
            for (let i = myThenBys.length - 1; i >= 0; i--) {
                const thenBy = myThenBys[i];
                for (const key of this.orderExpressions(thenBy.expression as LambdaExpression, projection))
                    orderBy.push(new OrderExpression(thenBy.orderType, key));
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

    // `skip(n)` → an OFFSET on a wrapping select (Signum's BindSkip; modern dialects
    // express paging with OFFSET/FETCH and LIMIT/OFFSET rather than row-number). The
    // source's ORDER BY is floated onto this select by OrderByRewriter (OFFSET, like
    // TOP, makes an inner ORDER BY meaningful); a following `top` merges in via
    // RedundantSubqueryRemover so skip+take land as one OFFSET … FETCH select.
    private bindSkip(projection: ProjectionExpression, skip: Expression): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, projection.select, undefined, [], [], SelectOptions.None, skip),
            pc.projector, projection.uniqueFunction, projection.type);
    }

    private bindDistinct(projection: ProjectionExpression): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        // DISTINCT dedupes on the SELECTed columns, so the projector must be nominated
        // aggressively (its computed value becomes the columns) — otherwise a lazy projection
        // would DISTINCT on the raw leaf columns and dedupe the wrong thing.
        const pc = this.projectColumns(projection.projector, alias, /* aggressive */ true);
        return new ProjectionExpression(
            new SelectExpression(alias, true, undefined, pc.columns, projection.select, undefined, [], []),
            pc.projector, undefined, projection.type);
    }

    // Signum's BindExpandLite: tag the Lite the selector points at with the load hint, so
    // EntityCompleter decides its model (toStr) eager / lazy / null. Only the identity selector
    // (`a => a`) is supported — the projected value itself is the Lite.
    private bindExpandLite(projection: ProjectionExpression, selector: LambdaExpression, hint: ConstantExpression): ProjectionExpression {
        const expand = expandLiteHintOf(hint.value as ExpandLite);
        const projector = this.changeExpandTarget(projection.projector, selector, e => {
            if (!(e instanceof LiteReferenceExpression))
                throw new Error("expandLite: the selected value is not a Lite");
            return new LiteReferenceExpression(e.type, e.reference, e.toStr, expand);
        });
        return new ProjectionExpression(projection.select, projector, projection.uniqueFunction, projection.type);
    }

    // Signum's BindExpandEntity: EagerEntity retrieves the entity's columns (the default),
    // LazyEntity leaves an id-only stub — which altea already expresses as
    // avoidExpandOnRetrieving on the EntityExpression (see EntityCompleter.visitEntity).
    private bindExpandEntity(projection: ProjectionExpression, selector: LambdaExpression, hint: ConstantExpression): ProjectionExpression {
        const lazy = (hint.value as ExpandEntity) === ExpandEntity.LazyEntity;
        const withHint = (e: Expression): Expression => {
            if (e instanceof EntityExpression)
                return new EntityExpression(e.type, e.table, e.externalId, e.tableAlias, e.bindings, e.mixins, lazy);
            if (e instanceof ImplementedByExpression)
                return new ImplementedByExpression(e.type, e.strategy,
                    new Map([...e.implementations].map(([c, ee]) => [c, withHint(ee) as EntityExpression])));
            throw new Error("expandEntity: the selected value is not an entity");
        };
        const projector = this.changeExpandTarget(projection.projector, selector, withHint);
        return new ProjectionExpression(projection.select, projector, projection.uniqueFunction, projection.type);
    }

    // Apply `change` to the projector node the (identity) selector points at. Only `a => a`
    // (body === parameter) is supported for now; a member-path selector would need a
    // projector rewrite (Signum's ChangeProjector).
    private changeExpandTarget(projector: Expression, selector: LambdaExpression, change: (e: Expression) => Expression): Expression {
        if (selector.body === selector.parameters[0])
            return change(projector);
        throw new Error("expandLite/expandEntity currently supports only the identity selector (a => a)");
    }

    // Port of Signum's BindUniqueRow. A collection terminal (first/firstOrNull/single/
    // singleOrNull), optionally predicated, over a (sub-)projection.
    //  (a) make the subquery self-contained: splice its own implicit joins in
    //      (ExpandJoins, cleanRequests:false) then rename its declared aliases to fresh
    //      ones (AliasReplacer) so the same collection used twice yields two independent
    //      subqueries before dedup collapses structurally-equal ones.
    //  (b) build a single-row SELECT (TOP 1 for First/FirstOrDefault; no TOP for
    //      Single/SingleOrDefault) with the (optional) predicate as its WHERE.
    //  (c) scalar fast-path: a nested First/FirstOrDefault whose projector is a single
    //      column → a correlated scalar subquery `(SELECT TOP 1 val …)`.
    //  (d) at the root → a ProjectionExpression carrying uniqueFunction (materialised as
    //      one row by the executor).
    //  (e) nested non-scalar → register a UniqueRequest (CROSS/OUTER APPLY, deduped by
    //      canonical signature) and return the *navigable* projector so a following
    //      `.member` / `.toLite()` navigates it instead of collapsing to a scalar.
    private bindUnique(rawProjection: ProjectionExpression, uniqueFunction: UniqueFunction, predicate: LambdaExpression | undefined, isRoot: boolean): Expression {
        // (a) Self-contain the subquery: expand its own pending joins, then freshen aliases.
        const expanded = QueryJoinExpander.expand(rawProjection, this.requests) as ProjectionExpression;
        const projection = AliasReplacer.replace(expanded, this.aliasGenerator) as ProjectionExpression;

        const where = predicate == null ? undefined : this.fullNominate(this.mapVisitExpand(predicate, projection));

        const alias = this.aliasGenerator.nextSelectAlias();
        const top = uniqueFunction === "First" || uniqueFunction === "FirstOrDefault" ? new ConstantExpression(1) : undefined;
        const pc = this.projectColumns(projection.projector, alias);

        // (c) scalar fast-path (Signum: !isRoot && projector is ColumnExpression && First/FirstOrDefault):
        // a single-column projector becomes a correlated scalar subquery. `pc.columns` is the
        // one server-side declaration over `projection.select` (referencing the subquery's own
        // aliases); `pc.projector` reads it back at the new alias — but a scalar subquery IS its
        // value, so the SELECT list carries the declaration and the ScalarExpression wraps it.
        if (!isRoot && pc.projector instanceof ColumnExpression && pc.columns.length === 1 && (uniqueFunction === "First" || uniqueFunction === "FirstOrDefault")) {
            const decl = new ColumnDeclaration("val", pc.columns[0].expression);
            const select = new SelectExpression(alias, false, top, [decl], projection.select, where, [], []);
            return new ScalarExpression(pc.projector.type, select);
        }

        const newProjection = new ProjectionExpression(
            new SelectExpression(alias, false, top, pc.columns, projection.select, where, [], []),
            pc.projector, uniqueFunction, projection.type);

        // (d) root → the single-row projection itself.
        if (isRoot)
            return newProjection;

        // (e) nested non-scalar → dedup + register APPLY, return the navigable projector.
        const key = UniqueRequestKey.of(newProjection.select);
        const cached = this.uniqueFunctionReplacements.get(key);
        if (cached != null)
            return cached;

        const request: UniqueRequest = {
            select: newProjection.select,
            outerApply: uniqueFunction === "SingleOrDefault" || uniqueFunction === "FirstOrDefault",
        };
        const source = this.getCurrentSource(request);
        this.addRequest(request, source);
        this.uniqueFunctionReplacements.set(key, newProjection.projector);
        return newProjection.projector;
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

    // Signum's `OrderAlsoByKeys()` (used by TestPaginate / paging): mark the select so
    // OrderByRewriter appends the source entities' primary keys as ORDER BY tie-breakers,
    // giving a deterministic total order (a bare `orderBy(nonUniqueKey)` otherwise paginates
    // inconsistently — the DB returns tied rows in an unstable order). The flag is resolved by
    // OrderByRewriter's gatheredKeys machinery; the binder just sets it.
    private bindOrderAlsoByKeys(projection: ProjectionExpression): ProjectionExpression {
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projection.projector, alias);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, projection.select, undefined, [], [], SelectOptions.OrderAlsoByKeys),
            pc.projector, undefined, projection.type);
    }

    // Last/LastOrDefault. Signum's OverloadingSimplifier rewrites them to
    // Reverse → (optional Where) → First/FirstOrDefault. The Reverse flag (not an
    // eager order inversion) is what OrderByRewriter consumes.
    private bindLast(source: ProjectionExpression, uniqueFunction: UniqueFunction, predicate: LambdaExpression | undefined, isRoot: boolean): Expression {
        const reversed = this.bindReverse(source);
        return this.bindUnique(reversed, uniqueFunction, predicate, isRoot);
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
    // Peel a `X.<method>(args)` source call (undefined if `expr` isn't that shape).
    private extractCall(expr: Expression, method: string): { object: Expression, args: readonly Expression[] } | undefined {
        return expr instanceof CallExpression && expr.func instanceof PropertyExpression && expr.func.propertyName === method
            ? { object: expr.func.object, args: expr.args }
            : undefined;
    }

    // The value tested by a `x => <value> != null` lambda, else undefined.
    private notNullValue(lambda: LambdaExpression): Expression | undefined {
        const b = lambda.body;
        if (b instanceof BinaryExpression && (b.kind === "!=" || b.kind === "!=="))
            return isNullLiteral(b.right) ? b.left : isNullLiteral(b.left) ? b.right : undefined;
        return undefined;
    }

    // Structural equality of two member-access chains, treating the two lambdas'
    // parameters as equivalent (`a.name` from one lambda ≡ `b.name` from another).
    private sameValue(a: Expression, aParam: ParameterExpression, b: Expression, bParam: ParameterExpression): boolean {
        if (a instanceof ParameterExpression && b instanceof ParameterExpression)
            return (a === aParam && b === bParam) || a === b;
        if (a instanceof PropertyExpression && b instanceof PropertyExpression)
            return a.propertyName === b.propertyName && this.sameValue(a.object, aParam, b.object, bParam);
        return false;
    }

    // Port of Signum's DisassembleAggregate (the Count cases): recognise a
    // Select/Distinct/Where(notNull) combination under a Count so it lowers to
    // `COUNT(DISTINCT selector)` rather than a correlated `COUNT(*)` over a
    // `SELECT DISTINCT …` subquery. Returns the reduced (still unbound) inner source,
    // the value selector, and whether it is a distinct count.
    private disassembleAggregate(func: AggregateSqlFunction, source: Expression, selectorOrPredicate: LambdaExpression | undefined):
        { source: Expression, selector: LambdaExpression | undefined, distinct: boolean } {
        if (func !== "Count")
            return { source, selector: selectorOrPredicate, distinct: false };

        // Count(predicate) → filter(predicate).count(), so the notNull patterns can see it.
        const src = selectorOrPredicate == null ? source
            : new CallExpression(new PropertyExpression(source, "filter"), [selectorOrPredicate], source.type);

        // Select · Distinct · Where(notNull):  X.map(sel).distinct().filter(a => a != null)
        {
            const w = this.extractCall(src, "filter");
            const d = w && this.extractCall(w.object, "distinct");
            const s = d && this.extractCall(d.object, "map");
            if (w && d && s && s.args.length === 1) {
                const pred = w.args[0] as LambdaExpression, v = this.notNullValue(pred);
                if (v != null && v === pred.parameters[0])
                    return { source: s.object, selector: s.args[0] as LambdaExpression, distinct: true };
            }
        }
        // Select · Where(notNull) · Distinct:  X.map(sel).filter(a => a != null).distinct()
        {
            const d = this.extractCall(src, "distinct");
            const w = d && this.extractCall(d.object, "filter");
            const s = w && this.extractCall(w.object, "map");
            if (d && w && s && s.args.length === 1) {
                const pred = w.args[0] as LambdaExpression, v = this.notNullValue(pred);
                if (v != null && v === pred.parameters[0])
                    return { source: s.object, selector: s.args[0] as LambdaExpression, distinct: true };
            }
        }
        // Where(notNull) · Select · Distinct:  X.filter(a => a.x != null).map(a => a.x).distinct()
        {
            const d = this.extractCall(src, "distinct");
            const s = d && this.extractCall(d.object, "map");
            const w = s && this.extractCall(s.object, "filter");
            if (d && s && w && s.args.length === 1) {
                const sel = s.args[0] as LambdaExpression, pred = w.args[0] as LambdaExpression, v = this.notNullValue(pred);
                if (v != null && this.sameValue(v, pred.parameters[0], sel.body, sel.parameters[0]))
                    return { source: w.object, selector: sel, distinct: true };
            }
        }
        return { source: src, selector: undefined, distinct: false };
    }

    private bindAggregate(projection: ProjectionExpression, aggregateFunction: AggregateSqlFunction, selector: LambdaExpression | undefined, isRoot: boolean, distinct: boolean = false): Expression {
        const info = this.groupByMap.get(projection.select.alias);
        if (info != null) {
            const exp: Expression | undefined =
                aggregateFunction === "Count" && selector == null ? undefined :       // Count(*)
                aggregateFunction === "Count" && !distinct ? this.mapVisitExpandCore(toNotNullPredicate(selector!), info.projector, info.source) :
                selector != null ? this.mapVisitExpandCore(selector, info.projector, info.source) : // Sum(x), Avg(x), CountDistinct(x)
                info.projector;                                                        // Sum() over an element-selected group

            const arg = exp == null ? undefined : this.aggregateArgument(exp);
            const aggregate = new AggregateExpression(
                aggregateFunction === "Count" ? LiteralType.number : (arg?.type ?? LiteralType.number),
                distinct ? "CountDistinct" : aggregateFunction,
                arg == null ? [] : [arg],
                undefined);
            return new AggregateRequestsExpression(info.groupAlias, aggregate);
        }

        // Complicated subquery / root. Count(predicate) → WHERE then Count(*) (not for a
        // distinct count — its selector names the value to count distinctly).
        if (aggregateFunction === "Count" && selector != null && !distinct) {
            projection = this.bindWhere(projection, selector);
            selector = undefined;
        }

        const argument = selector == null ? projection.projector : this.fullNominate(this.mapVisitExpand(selector, projection));
        const aggregate = aggregateFunction === "Count" && !distinct
            ? new AggregateExpression(LiteralType.number, "Count", [], undefined)
            : aggregateFunction === "Count"
                ? new AggregateExpression(LiteralType.number, "CountDistinct", [this.aggregateArgument(argument)], undefined)
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

        // `query.join(sep)` over an entity/lite/IB aggregates its display string — the
        // same as `query.map(e => e.toString()).join(sep)`. Re-project the ToString as
        // a scalar column (like bindSelect) so the aggregate's FROM exposes it.
        let source = projection;
        const refToStr = this.entityToStringOf(projection.projector);
        if (refToStr != null) {
            const projAlias = this.aliasGenerator.nextSelectAlias();
            const pc = this.projectColumns(refToStr, projAlias);
            source = new ProjectionExpression(
                new SelectExpression(projAlias, false, undefined, pc.columns, projection.select, undefined, [], []),
                pc.projector, undefined, new ArrayType(LiteralType.string));
        }

        let nominated = this.fullNominate(source.projector);
        if (isReferenceish(nominated) || nominated instanceof EmbeddedEntityExpression)
            throw new Error("A string aggregate (join) over this projection (@implementedByAll / @quoted ToString) is not supported yet; project a scalar with .map(...) first");

        // STRING_AGG concatenates text — a non-string element (e.g. an int id) must be
        // cast (Postgres rejects string_agg(integer, …); SQL Server would coerce it but
        // we cast uniformly for a stable shape).
        if (nominated.type !== LiteralType.string)
            nominated = new SqlCastExpression(LiteralType.string, nominated, this.isPostgres ? "varchar" : "nvarchar(max)");

        const aggregate = new AggregateExpression(
            LiteralType.string, "string_agg",
            [nominated, new SqlConstantExpression(separator.value, LiteralType.string)],
            undefined);

        const alias = this.aliasGenerator.nextSelectAlias();
        const select = new SelectExpression(alias, false, undefined, [new ColumnDeclaration("c0", aggregate)], source.select, undefined, [], []);
        if (isRoot)
            return new ProjectionExpression(select, new ColumnExpression(LiteralType.string, alias, "c0"), "Single", LiteralType.string);
        return new ScalarExpression(LiteralType.string, select);
    }

    // The display-string SQL expression of an entity / lite / IB reference: an entity's
    // ToStr column, a lite's wrapped reference's ToString, or a CASE over an IB's
    // implementations. Returns undefined for shapes whose ToString isn't supported yet
    // (IBA, @quoted-expression, value/enum) so callers can fall back.
    private entityToStringOf(source: Expression): Expression | undefined {
        if (source instanceof LiteReferenceExpression)
            return this.entityToStringOf(source.reference);
        if (source instanceof EntityExpression)
            return this.entityToString(source);
        if (source instanceof ImplementedByExpression) {
            // The CASE needs every implementation's ToString to translate; if any
            // doesn't (e.g. an unsupported @quoted body), the polymorphic one isn't
            // available.
            const impls = [...source.implementations.values()];
            const parts = impls.map(ee => this.entityToString(ee));
            if (parts.some(p => p == null))
                return undefined;
            return this.dispatchIb(source, ee => this.entityToString(ee)!);
        }
        return undefined;
    }

    // The display-string SQL of a single entity reference (Signum's
    // `Completed(ee).GetBinding(ToStrField)` or the inline ToString expression): read
    // its physical ToStr column when it has one (hand-written non-@quoted toString),
    // else expand its `@quoted` toString inline. Undefined when neither is possible.
    private entityToString(ee: EntityExpression): Expression | undefined {
        return this.entityToStringColumn(ee) ?? this.expandQuotedToString(ee);
    }

    // Read the physical ToStr column (completing the reference — a join for a lazy FK,
    // a no-op for a root entity). Undefined when the entity has no column.
    private entityToStringColumn(ee: EntityExpression): Expression | undefined {
        const toStrColumn = ee.table.toStrColumn;
        if (toStrColumn == null)
            return undefined;
        const completed = this.completed(ee);
        return new ColumnExpression(LiteralType.string, completed.tableAlias!, toStrColumn.name);
    }

    // Expand the entity type's `@quoted` toString body against this entity expression
    // (Signum's expression-based ToString). Field accesses inside the body complete the
    // reference on demand; `this.id` stays the FK (no join) and `niceName(this)` folds
    // to a constant. Undefined when the toString isn't @quoted (→ a column was used).
    private expandQuotedToString(ee: EntityExpression): Expression | undefined {
        const ctor = ee.type instanceof ClassType ? ee.type.constructorFunction : undefined;
        const ts = (ctor as { prototype?: { toString?: unknown } } | undefined)?.prototype?.toString;
        if (typeof ts !== "function" || (ts as { __quoted?: unknown }).__quoted == null)
            return undefined;

        // Entity's inherited default `toString` (BaseToString): a persisted row reads
        // `<NiceName> <Id>`. Built directly (the generic body has an `isNew` branch and
        // `this.id.toString()` whose expression-layer typing is brittle here).
        if (ts === Entity.prototype.toString)
            return new BinaryExpression("+",
                new SqlConstantExpression(niceName(ctor!) + " ", LiteralType.string),
                new SqlCastExpression(LiteralType.string, this.unwrapPk(ee.externalId), this.isPostgres ? "varchar" : "nvarchar(max)"));

        // A subclass's own `@quoted` toString (Signum's [AutoExpressionField] ToString):
        // expand its captured body against `ee` (this = the entity), exactly like any
        // other @quoted member — e.g. `() => this.name` becomes the name column, so the
        // display string is computed inline and the entity needs no stored ToStr column.
        // A `@quoted` toString is expected to be translatable (that is the contract that
        // lets it replace a stored ToStr column); a body that isn't should be a plain
        // (non-`@quoted`) override with a ToStr column instead, like NoteWithDateEntity.
        const lambda = Expression.fromQuotedLambda(ts as never, [ee.type]);
        return this.bindQuotedBody(lambda, ee, []);
    }

    // A `@quoted` expression-member (Signum's AutoExpressionField) called on an entity
    // reference. Returns undefined when it isn't one (caller falls back to the residual
    // call). Concrete calls are already inlined by the quote transform; this covers the
    // shapes it couldn't resolve statically — chiefly a member navigated through a
    // polymorphic `combineUnion()`/`combineCase()` reference. Mirrors Signum's QueryBinder
    // (HasExpansions on a concrete EntityExpression; DispatchIb over an ImplementedBy).
    private tryExpandQuotedMember(source: Expression, methodName: string, args: readonly Expression[], resultType: Type): Expression | undefined {
        if (source instanceof LiteReferenceExpression)
            return this.tryExpandQuotedMember(source.reference, methodName, args, resultType);

        // Polymorphic: dispatch the call to each implementation (re-bind `impl.method(args)`)
        // and combine (CASE / UNION). Only when every implementation declares the member.
        if (source instanceof ImplementedByExpression) {
            const impls = [...source.implementations.values()];
            if (impls.length === 0 || !impls.every(ee => this.quotedMemberOf(ee, methodName) != null))
                return undefined;
            return this.dispatchIb(source, ee => this.bindMethodCall(methodName, ee, args, resultType));
        }

        // Concrete entity: expand its `@quoted` body (this = the entity, plus any args).
        if (source instanceof EntityExpression) {
            const method = this.quotedMemberOf(source, methodName);
            if (method == null)
                return undefined;
            const argTypes = args.map(a => this.visit(a).type ?? LiteralType.null);
            const lambda = Expression.fromQuotedLambda(method as never, [source.type, ...argTypes]);
            return this.bindQuotedBody(lambda, source, args);
        }

        return undefined;
    }

    // The `@quoted` method named `methodName` on the entity's runtime type, or undefined.
    private quotedMemberOf(ee: EntityExpression, methodName: string): Function | undefined {
        const ctor = ee.type instanceof ClassType ? ee.type.constructorFunction : undefined;
        const method = (ctor?.prototype as Record<string, unknown> | undefined)?.[methodName];
        return typeof method === "function" && (method as { __quoted?: unknown }).__quoted != null
            ? method as Function
            : undefined;
    }

    // Bind a `@quoted` member's captured lambda body: parameter 0 is the receiver
    // (`this` = `thisValue`); remaining parameters map to the (visited) call arguments.
    private bindQuotedBody(lambda: LambdaExpression, thisValue: Expression, args: readonly Expression[]): Expression {
        const params = lambda.parameters;
        const olds = params.map(p => this.map.get(p));
        this.map.set(params[0], thisValue);
        for (let i = 1; i < params.length; i++)
            this.map.set(params[i], this.visit(args[i - 1]));
        try {
            return this.visit(lambda.body);
        } finally {
            params.forEach((p, i) => olds[i] === undefined ? this.map.delete(p) : this.map.set(p, olds[i]!));
        }
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

    // Signum's WithIndex: wrap `projection` in a select carrying a 0-based row-index
    // column (`ROW_NUMBER() OVER(…) - 1`), and return that column so an indexed
    // selector's second parameter can bind to it. The RowNumber inherits the inner
    // select's orderBy (empty → the formatter falls back to a constant order).
    private withIndex(projection: ProjectionExpression): { projection: ProjectionExpression, index: ColumnExpression } {
        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projection.projector, alias);
        const rowNum = new BinaryExpression("-",
            new RowNumberExpression(this.indexOrderBy(projection)),
            new SqlConstantExpression(1, LiteralType.number));
        const cd = new ColumnDeclaration("_rowNum", rowNum);
        const index = new ColumnExpression(LiteralType.number, alias, "_rowNum");
        const select = new SelectExpression(alias, false, undefined, [cd, ...pc.columns],
            projection.select, undefined, [], [], SelectOptions.HasIndex);
        return { projection: new ProjectionExpression(select, pc.projector, projection.uniqueFunction, projection.type), index };
    }

    // The ORDER BY for a row-index window: the query's own ordering if it has one, else
    // the source entity's primary key (Signum fills the RowNumber from gathered orderings,
    // which resolve to the PK). A stable key makes `(x, i) => …` deterministic — a bare
    // `ORDER BY (SELECT 1)` (the formatter's last-resort fallback) does not.
    private indexOrderBy(projection: ProjectionExpression): OrderExpression[] {
        if (projection.select.orderBy.length)
            return [...projection.select.orderBy];
        const p = projection.projector;
        if (p instanceof EntityExpression)
            return [new OrderExpression("Ascending", p.externalId.value)];
        return [];
    }

    // mapVisitExpand for a possibly-indexed selector (`(x, i) => …`): when the lambda
    // has a second parameter, wrap the projection with a row-index column and bind that
    // parameter to it (Signum's MapVisitExpandWithIndex). Returns the bound body and the
    // projection its FROM should read from (the indexed one when an index was added).
    private mapVisitExpandIndexed(lambda: LambdaExpression, projection: ProjectionExpression): { expression: Expression, projection: ProjectionExpression } {
        if (lambda.parameters.length <= 1)
            return { expression: this.mapVisitExpand(lambda, projection), projection };

        const { projection: indexed, index } = this.withIndex(projection);
        const p1 = lambda.parameters[1];
        const old = this.map.get(p1);
        this.map.set(p1, index);
        try {
            return { expression: this.mapVisitExpand(lambda, indexed), projection: indexed };
        } finally {
            if (old == null) this.map.delete(p1);
            else this.map.set(p1, old);
        }
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
        // `coll.length` is a Count over the collection; disassemble the UNBOUND source
        // first so `map(sel).filter(notNull).distinct().length` lowers to COUNT(DISTINCT
        // sel) (same as `.count()`). A non-collection `.length` (string) doesn't match the
        // patterns, so it falls through unchanged.
        if (pe.propertyName === "length") {
            const dis = this.disassembleAggregate("Count", pe.object, undefined);
            if (dis.distinct) {
                let inner = this.visit(dis.source);
                if (inner instanceof FieldEntityArrayExpression)
                    inner = this.fieldEntityArrayProjection(inner);
                return this.bindAggregate(this.asProjection(inner), "Count", dis.selector, false, true);
            }
        }
        return this.bindMember(this.visit(pe.object), pe.propertyName, pe.isOptionalChaining);
    }

    // Dispatches `<bound obj>.<name>` on an already-bound expression. Split out from
    // bindMemberAccess so it can be reused to navigate a member on the projector of a
    // single-result sub-query (see the uniqueFunction branch below).
    private bindMember(obj: Expression, name: string, isOptionalChaining: boolean): Expression {
        // `.$v` (the Promise<T>→T await marker) carries no SQL meaning: binding `obj.$v` is
        // exactly binding `obj`. Handled first — before the entity/embedded dispatch — so a
        // navigable projector returned by a nested unique terminal (`view(T).single(…).$v`,
        // `coll.firstOrNull().$v`) passes straight through instead of being looked up as a
        // field. Turning a single-row sub-query into a scalar is the consuming context's job.
        if (name === "$v")
            return obj;

        // Distribute a member access over a conditional / coalesce so each branch binds
        // against its own source (Signum's BindMemberAccess Conditional/Coalesce cases):
        // `(t ? a : b).m` → `t ? a.m : b.m`; `(a ?? b).m` → `(a != null) ? a.m : b.m`.
        // Placed before the member-kind dispatch below so `.constructor`/`.name`/field
        // access all distribute uniformly into the branches.
        if (obj instanceof ConditionalExpression)
            return new ConditionalExpression(
                obj.condition,
                this.bindMember(obj.whenTrue, name, isOptionalChaining),
                this.bindMember(obj.whenFalse, name, isOptionalChaining));

        if (obj instanceof BinaryExpression && obj.kind === "??")
            return new ConditionalExpression(
                this.notNull(obj.left),
                this.bindMember(obj.left, name, isOptionalChaining),
                this.bindMember(obj.right, name, isOptionalChaining));

        // A member of a null literal is null (Signum's `source.IsNull()` guard) — arises
        // after distributing over a conditional/coalesce whose branch is a null literal.
        if (isNullLiteral(obj))
            return new ConstantExpression(null);

        // `.constructor` (altea's GetType) yields the runtime type of any reference as
        // a Type expression; `.entityType` is the same but specifically Signum's
        // Lite.EntityType, so it's scoped to a lite (a real entity field named
        // `entityType` on a plain reference must still bind as a field). getEntityType
        // unwraps a Lite to its reference. `.name` (Type.FullName) on a Type expression
        // → its type-name string.
        if (name === "constructor" && isReferenceish(obj))
            return this.getEntityType(obj);
        if (name === "entityType" && obj instanceof LiteReferenceExpression)
            return this.getEntityType(obj);
        if (name === "name" && isTypeExpression(obj))
            return this.typeName(obj);

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

    // `expr != null` as a bound boolean: an entity/lite reference routes through
    // SmartEqualizer (an id-not-null guard, like visitBinary's `!=`), a scalar keeps a
    // plain comparison. Used to build the coalesce test in the bindMember distribution.
    private notNull(expr: Expression): Expression {
        const nul = new ConstantExpression(null);
        return isReferenceish(expr)
            ? SmartEqualizer.not(SmartEqualizer.polymorphicEqual(expr, nul))
            : new BinaryExpression("!=", expr, nul);
    }

    // Binds `entity.<name>`: id short-circuits to the FK column (no JOIN), a
    // collection field becomes a lazy FieldEntityArrayExpression, anything else
    // completes the entity (navigation → JOIN) and reads the field binding.
    private bindEntityMember(entity: EntityExpression, name: string): Expression {
        if (name === "id")
            return entity.externalId;
        // A row read from the database is never new (Signum folds IsNew in queries);
        // used by the default `@quoted` toString's `this.isNew ? … : …`.
        if (name === "isNew")
            return new SqlConstantExpression(false, LiteralType.boolean);
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

    // Signum's EntityContext.EntityId: the primary key of the entity/row the argument
    // belongs to. If the argument isn't itself a reference (a value column, or an
    // embedded), unwrap the member access to its object and retry — an embedded's owning
    // row is its entity (altea inlines embeddeds); an MList/part row is its own entity.
    private bindEntityId(arg: Expression): Expression {
        const bound = this.visit(arg);
        const ref = bound instanceof LiteReferenceExpression ? bound.reference : bound;
        if (ref instanceof EntityExpression || ref instanceof ImplementedByExpression || ref instanceof ImplementedByAllExpression)
            return this.idOfReference(ref);
        // firstOrNull()/single() of a part-entity collection (`a.songs.firstOrNull()`):
        // the id of that single row, re-projected as a correlated scalar subquery
        // (mirrors the member-of-single-result-subquery path in bindMember).
        if (bound instanceof ProjectionExpression && bound.uniqueFunction != null && isReferenceish(bound.projector)) {
            const id = this.unwrapPk(this.idOfReference(bound.projector as LiteReferenceTarget));
            const alias = this.aliasGenerator.nextSelectAlias();
            const pc = this.projectColumns(id, alias);
            const select = new SelectExpression(alias, false, undefined, pc.columns, bound.select, undefined, [], []);
            return new ScalarExpression(id.type, select);
        }
        if (arg instanceof PropertyExpression)
            return this.bindEntityId(arg.object);
        throw new Error(`EntityContext.entityId is not supported for ${bound.toString()}`);
    }

    // `.id` of a (possibly polymorphic) reference, without a join.
    private idOfReference(ref: LiteReferenceTarget): Expression {
        if (ref instanceof EntityExpression)
            return ref.externalId;
        if (ref instanceof ImplementedByAllExpression)
            return new PrimaryKeyExpression(this.ibaId(ref));
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

    // Signum's DispatchIb: navigate `selector` on each implementation and combine the
    // per-implementation results. Empty → null; single → that one (no combine). With
    // 2+ implementations the combine follows the IB's strategy: "Case" runs the
    // selector on the (lazy) implementation entities and merges with a CASE
    // (combineImplementations recurses into references); "Union" is handled in the
    // UnionAllRequest path.
    private dispatchIb(ib: ImplementedByExpression, selector: (ee: EntityExpression) => Expression): Expression {
        const impls = [...ib.implementations.values()];
        if (impls.length === 0)
            return new SqlConstantExpression(null, LiteralType.null);
        if (impls.length === 1)
            return selector(impls[0]);

        if (ib.strategy === "Union")
            return this.dispatchIbUnion(ib, selector);

        const dictionary = new Map<Function, Expression>();
        for (const [ctor, ee] of ib.implementations)
            dictionary.set(ctor, selector(ee));
        return this.combineImplementations(new SwitchStrategy(ib), dictionary, ib.type);
    }

    // The UNION-ALL combine strategy (Signum's CombineStrategy.Union). Build (once)
    // the union sub-query over the implementations, run the selector against each
    // implementation's full entity (bound at its own inner alias), then combine the
    // per-implementation results via the request — which projects the leaves into
    // union columns read back from the union alias.
    private dispatchIbUnion(ib: ImplementedByExpression, selector: (ee: EntityExpression) => Expression): Expression {
        const ur = this.completedUnion(ib);
        const dictionary = new Map<Function, Expression>();
        for (const [ctor, ue] of ur.implementations)
            dictionary.set(ctor, this.runWithSource(ue.tableExpr, () => selector(ue.entity)));
        return this.combineImplementations(ur, dictionary, ib.type);
    }

    // Signum's Completed(ImplementedByExpression): build/cache the UnionAllRequest —
    // one full-entity projection per implementation at a fresh alias, plus a per-
    // implementation id column used as the join key — and register it against the
    // current source so QueryJoinExpander splices in the UNION ALL join.
    private completedUnion(ib: ImplementedByExpression): UnionAllRequest {
        const cached = this.unionReplacements.get(ib);
        if (cached != null)
            return cached;

        const unionAlias = this.aliasGenerator.nextTableAlias("Union");
        const implementations = new Map<Function, UnionEntity>();
        for (const [ctor, ee] of ib.implementations) {
            const innerAlias = this.aliasGenerator.nextTableAlias(ee.table.name.name);
            implementations.set(ctor, {
                entity: this.createEntityExpression(ee.table, innerAlias),
                tableExpr: new TableExpression(innerAlias, ee.table),
                selectAlias: this.aliasGenerator.nextSelectAlias(),
            });
        }

        const ur = new UnionAllRequest(ib, unionAlias, implementations, this.isPostgres);
        for (const [ctor, ue] of implementations) {
            const idValue = ue.entity.externalId.value;
            ue.unionExternalId = ur.addIndependentColumn(idValue.type, "Id_" + cleanTypeName(ctor), ctor, idValue);
        }

        this.addUnionRequest(ur);
        this.unionReplacements.set(ib, ur);
        return ur;
    }

    private addUnionRequest(ur: UnionAllRequest): void {
        const source = this.sourceStack[this.sourceStack.length - 1];
        if (source == null)
            throw new Error("No current source for a UNION combine request");
        const list = this.requests.get(source);
        if (list != null)
            list.push({ union: ur });
        else
            this.requests.set(source, [{ union: ur }]);
    }

    // Signum's CombineImplementations: reconstruct a single expression from the
    // per-implementation values (keyed by implementation ctor). Recurses through the
    // reference structure — Lite over its wrapped reference, Entity over its id,
    // @implementedByAll over id + type discriminator, PrimaryKey over its value —
    // and defers to `strategy.combineValues` only at scalar leaves. `returnType` is
    // the combined reference's nominal type; the concrete type is recovered at read
    // time from the discriminator, so it is only load-bearing for scalar column types.
    private combineImplementations(strategy: ICombineStrategy, expressions: ReadonlyMap<Function, Expression>, returnType: Type): Expression {
        const values = [...expressions.values()];

        // All Lite<T> → combine the wrapped references and re-wrap as a Lite.
        if (values.every(v => v instanceof LiteReferenceExpression)) {
            const refs = mapValues(expressions, v => (v as LiteReferenceExpression).reference);
            const entity = this.combineImplementations(strategy, refs, liteInner(returnType)) as LiteReferenceTarget;
            return new LiteReferenceExpression(new LiteType(entity.type), entity, undefined);
        }

        // All the same typed entity → one lazy EntityExpression with the combined id.
        if (values.every(v => v instanceof EntityExpression)) {
            const commonType = (values[0] as EntityExpression).type;
            const ids = mapValues(expressions, v => (v as EntityExpression).externalId.value);
            const id = new PrimaryKeyExpression(this.combineImplementations(strategy, ids, LiteralType.number));
            const table = this.schema.table(ctorOfType(commonType) as any);
            return new EntityExpression(commonType, table, id, undefined, undefined, undefined, false);
        }

        // Any @implementedByAll → combine to @implementedByAll (id + discriminator).
        // Mixed IB/IBA implementations (e.g. a member typed IBA on one impl, IB on
        // another) also land here: each is reduced to its id value and type id.
        if (values.some(v => v instanceof ImplementedByAllExpression)) {
            // Combine per PK type (Signum's CombineImplementations over ImplementedByAllPrimaryKeyTypes):
            // for each PK type any source can contribute, combine each source's id-for-that-type, so the
            // combined column stays that type (no cross-type UNION/COALESCE mismatch).
            const pkTypes = new Set<string>();
            for (const v of values) for (const pk of this.idPkTypes(v)) pkTypes.add(pk);
            const ids = new Map<string, Expression>();
            for (const pk of pkTypes) {
                const perType = mapValues(expressions, v => this.getIdAsType(v, pk));
                ids.set(pk, this.combineImplementations(strategy, perType, LiteralType.number));
            }
            const typeIds = mapValues(expressions, v => this.extractTypeId(this.getEntityType(v)));
            const typeId = this.combineImplementations(strategy, typeIds, LiteralType.number);
            return new ImplementedByAllExpression(returnType, ids, new TypeImplementedByAllExpression(typeId));
        }

        // All typed-or-@implementedBy → combine to @implementedBy over the union of
        // implementation types; each implementation entity is combined independently.
        if (values.every(v => v instanceof EntityExpression || v instanceof ImplementedByExpression)) {
            const implTypes = new Set<Function>();
            for (const v of values) {
                if (v instanceof EntityExpression)
                    implTypes.add(ctorOfType(v.type));
                else
                    for (const k of (v as ImplementedByExpression).implementations.keys())
                        implTypes.add(k);
            }
            const newImpls = new Map<Function, EntityExpression>();
            for (const t of implTypes) {
                const perType = mapValues(expressions, v => {
                    if (v instanceof EntityExpression)
                        return ctorOfType(v.type) === t ? v : this.nullEntity(t);
                    const found = (v as ImplementedByExpression).implementations.get(t);
                    return found ?? this.nullEntity(t);
                });
                newImpls.set(t, this.combineImplementations(strategy, perType, new ClassType(t)) as EntityExpression);
            }
            const kinds = new Set(values.filter(v => v instanceof ImplementedByExpression)
                .map(v => (v as ImplementedByExpression).strategy));
            const kind: CombineStrategy = kinds.size === 1 ? [...kinds][0] : "Union";
            return new ImplementedByExpression(returnType, kind, newImpls);
        }

        // All PrimaryKey wrappers → unwrap, combine the values, re-wrap.
        if (values.every(v => v instanceof PrimaryKeyExpression)) {
            const inner = mapValues(expressions, v => (v as PrimaryKeyExpression).value);
            return new PrimaryKeyExpression(this.combineImplementations(strategy, inner, returnType));
        }

        // Any runtime-type expression → combine the underlying type ids.
        if (values.some(v => isTypeExpression(v))) {
            const typeIds = mapValues(expressions, v => this.extractTypeId(v));
            const typeId = this.combineImplementations(strategy, typeIds, LiteralType.number);
            return new TypeImplementedByAllExpression(typeId);
        }

        // Scalar leaf — the strategy builds the actual combining SQL (a CASE / a
        // union column). Use a value's own type (the return type may be the nominal
        // reference type when we recursed from a reference branch).
        return strategy.combineValues(expressions, values.length ? values[0].type : returnType);
    }

    // A lazy, always-null typed EntityExpression standing in for an implementation
    // that a given branch of the combine doesn't populate (Signum's null-id filler).
    private nullEntity(ctor: Function): EntityExpression {
        const nullId = new PrimaryKeyExpression(new SqlConstantExpression(null, LiteralType.null));
        return new EntityExpression(new ClassType(ctor), this.schema.table(ctor as any), nullId, undefined, undefined, undefined, false);
    }

    // The scalar id *value* (unwrapped) of a reference — Signum's GetId reduced to a
    // value. IB coalesces its implementation ids (via the CASE combine); IBA is its
    // single id column; a typed entity its FK.
    private idValueOf(ref: Expression): Expression {
        if (ref instanceof LiteReferenceExpression)
            return this.idValueOf(ref.reference);
        if (ref instanceof EntityExpression)
            return ref.externalId.value;
        if (ref instanceof ImplementedByAllExpression)
            return this.ibaId(ref);
        if (ref instanceof ImplementedByExpression)
            return this.dispatchIb(ref, ee => ee.externalId.value);
        throw new Error(`Cannot take the id of ${ref.toString()}`);
    }

    // Signum's GetOrderExpression: bind an order-by selector and expand it into the SQL
    // order keys, which may be SEVERAL per selector. A reference doesn't order by its FK —
    // it orders by its display string first, then its id (so rows sort the way a user
    // reads them); a polymorphic reference fans out over each implementation; a runtime
    // type (GetType()/`.constructor`) becomes its type-id discriminator. Each key is
    // unwrapped from a PrimaryKey and fully nominated. A plain scalar stays a single key.
    private orderExpressions(selector: LambdaExpression, projection: ProjectionExpression): Expression[] {
        const expr = this.mapVisitExpand(selector, projection);

        // Signum's local GetExpressionOrder: order a single entity by its ToString
        // (its CustomOrder isn't modelled yet); fall back to its id when it has none.
        const expressionOrder = (ee: EntityExpression): Expression =>
            this.entityToStringOf(ee) ?? this.unwrapPk(ee.externalId);

        const perImplementation = (ib: ImplementedByExpression): Expression[] =>
            [...ib.implementations.values()].flatMap(ee => [expressionOrder(ee), ee.externalId]);

        let keys: Expression[];
        if (expr instanceof LiteReferenceExpression) {
            const ref = expr.reference;
            if (ref instanceof ImplementedByAllExpression)
                keys = [ref.typeId, ...ref.ids.values()];
            else if (ref instanceof EntityExpression)
                keys = [expressionOrder(ref), ref.externalId];
            else if (ref instanceof ImplementedByExpression)
                keys = perImplementation(ref);
            else
                throw new Error(`Cannot order by a lite of ${(ref as Expression).toString()}`);
        } else if (expr instanceof EntityExpression) {
            keys = [expressionOrder(expr), expr.externalId];
        } else if (expr instanceof ImplementedByExpression) {
            keys = perImplementation(expr);
        } else if (expr instanceof ImplementedByAllExpression) {
            keys = [expr.typeId, ...expr.ids.values()];
        } else {
            keys = [expr];
        }

        // A runtime-type key (the standalone GetType() case, or an @implementedByAll's
        // typeId which altea models as a Type* node) lowers to its type-id discriminator;
        // a PrimaryKey unwraps to its scalar. Then nominate each to a server expression.
        return keys.map(k => this.fullNominate(this.unwrapPk(isTypeExpression(k) ? this.extractTypeId(k) : k)));
    }

    // Signum's ExtractTypeId: the @implementedByAll type-discriminator *value* (the
    // target's TypeEntity int id) of a runtime-type expression. A concrete type is a
    // constant guarded by its id; an IB is a CASE over which implementation is set.
    private extractTypeId(typeExpr: Expression): Expression {
        if (typeExpr instanceof TypeImplementedByAllExpression)
            return typeExpr.typeColumn;
        if (typeExpr instanceof TypeEntityExpression)
            return new CaseExpression(
                [new When(new IsNotNullExpression(typeExpr.externalId.value), typeConstant(ctorOfType(typeExpr.typeValue)))],
                undefined);
        if (typeExpr instanceof TypeImplementedByExpression) {
            const whens = [...typeExpr.typeImplementations].map(([ctor, id]) =>
                new When(new IsNotNullExpression(id.value), typeConstant(ctor)));
            return new CaseExpression(whens, undefined);
        }
        throw new Error(`Cannot extract a type id from ${typeExpr.toString()}`);
    }

    // @implementedByAll exposes only `.id` on queries (Signum throws for any other
    // member — the concrete fields are reachable only through a cast).
    // The altea PrimaryKeyType an entity's id column uses (from its PK column's db type),
    // to pick the matching @implementedByAll id column when the target type is known.
    private pkTypeOf(ctor: Function): string {
        const pg = this.schema.table(ctor as any).primaryKey.column.dbType.postgres;
        return pg === "int8" ? "long" : pg === "uuid" ? "uuid" : "int";
    }

    // The single logical id of an @implementedByAll reference: COALESCE over the per-PK-type
    // id columns (only one is non-null). Their SQL types differ, so each is cast to text —
    // Signum treats a polymorphic id as an IComparable.
    private ibaId(iba: ImplementedByAllExpression): Expression {
        const cast = (e: Expression) => new SqlCastExpression(LiteralType.string, e, this.isPostgres ? "varchar" : "nvarchar(max)");
        const parts: Expression[] = [...iba.ids.values()].map(cast);
        return parts.reduce((a, b) => new BinaryExpression("??", a, b));
    }

    // The PK types a reference can contribute when combined into an @implementedByAll
    // (its target entities' PK types), used to build the combined per-type ids map.
    private idPkTypes(v: Expression): string[] {
        if (v instanceof LiteReferenceExpression) return this.idPkTypes(v.reference);
        if (v instanceof EntityExpression) return [this.pkTypeOf(ctorOfType(v.type))];
        if (v instanceof ImplementedByExpression) return [...v.implementations.keys()].map(c => this.pkTypeOf(c));
        if (v instanceof ImplementedByAllExpression) return [...v.ids.keys()];
        return [];
    }

    // A reference's id for a specific PK type (NULL when it can't be that type) — Signum's
    // GetIdAsType. Keeps a combined @implementedByAll column single-typed.
    private getIdAsType(v: Expression, pk: string): Expression {
        const nul = new SqlConstantExpression(null, LiteralType.null);
        if (v instanceof LiteReferenceExpression) return this.getIdAsType(v.reference, pk);
        if (v instanceof EntityExpression) return this.pkTypeOf(ctorOfType(v.type)) === pk ? v.externalId.value : nul;
        if (v instanceof ImplementedByExpression) {
            const matching = [...v.implementations].filter(([c]) => this.pkTypeOf(c) === pk).map(([, ee]) => ee.externalId.value);
            return matching.length ? matching.reduce((a, b) => new BinaryExpression("??", a, b)) : nul;
        }
        if (v instanceof ImplementedByAllExpression) return v.ids.get(pk) ?? nul;
        return nul;
    }

    private bindImplementedByAllMember(iba: ImplementedByAllExpression, name: string): Expression {
        if (name === "id")
            return new PrimaryKeyExpression(this.ibaId(iba));
        throw new Error(`Member '${name}' of @implementedByAll is not accessible on queries (cast to a concrete type first)`);
    }

    // Signum's GetEntityType: the runtime type of a (possibly polymorphic, possibly
    // lite-wrapped) reference. A typed entity → TypeEntity (its static type, guarded
    // by id); an @implementedBy → TypeImplementedBy (the per-implementation id
    // columns); an @implementedByAll → its existing type discriminator.
    private getEntityType(expr: Expression): Expression {
        if (expr instanceof LiteReferenceExpression)
            return this.getEntityType(expr.reference);
        if (expr instanceof EntityExpression)
            return new TypeEntityExpression(expr.externalId, expr.type);
        if (expr instanceof ImplementedByExpression) {
            const map = new Map<Function, PrimaryKeyExpression>();
            for (const [ctor, ee] of expr.implementations)
                map.set(ctor, ee.externalId);
            return new TypeImplementedByExpression(map);
        }
        if (expr instanceof ImplementedByAllExpression)
            return expr.typeId;
        throw new Error(`GetType (.constructor) is not supported for ${expr.toString()}`);
    }

    // `Type.FullName` (altea's `.constructor.name`): the JS constructor name of the
    // runtime type. A typed reference has a statically-known name, but the runtime type is NULL
    // when the reference is null, so the constant is guarded by the reference's id being non-null
    // (like extractTypeId); an @implementedBy is a CASE over which implementation column is set.
    private typeName(typeExpr: Expression): Expression {
        if (typeExpr instanceof TypeEntityExpression)
            return new CaseExpression(
                [new When(new IsNotNullExpression(typeExpr.externalId.value),
                    new SqlConstantExpression(ctorOfType(typeExpr.typeValue).name, LiteralType.string))],
                undefined);
        if (typeExpr instanceof TypeImplementedByExpression) {
            const whens = [...typeExpr.typeImplementations].map(([ctor, id]) =>
                new When(new IsNotNullExpression(id.value), new SqlConstantExpression(ctor.name, LiteralType.string)));
            return new CaseExpression(whens, undefined);
        }
        throw new Error(`Type.name is not supported for ${typeExpr.toString()}`);
    }

    // Signum's Type.ToTypeEntity(): the TypeEntity row identified by a runtime-type's
    // discriminator id. Built as an ordinary entity reference to the TypeEntity table keyed by the
    // type id (extractTypeId gives the id for a typed / IB / IBA reference), so it completes and
    // materialises like any other reference.
    private toTypeEntityRef(typeExpr: Expression): EntityExpression {
        const typeId = this.extractTypeId(typeExpr);
        const table = this.schema.table(TypeEntity as any);
        return new EntityExpression(new ClassType(TypeEntity), table, new PrimaryKeyExpression(typeId), undefined, undefined, undefined, false);
    }

    // Signum's Type.NiceName(): the localized display name. Like typeName but using the localized
    // niceName(ctor); an @implementedByAll reference has no static type (its type is a runtime id
    // column), so there is no constant to emit — throw (the decided scope: constants for a typed
    // entity / @implementedBy only).
    private typeNiceName(typeExpr: Expression): Expression {
        if (typeExpr instanceof TypeEntityExpression)
            // NULL when the reference is null (guard on its id), else the localized name constant.
            return new CaseExpression(
                [new When(new IsNotNullExpression(typeExpr.externalId.value),
                    new SqlConstantExpression(niceName(ctorOfType(typeExpr.typeValue)), LiteralType.string))],
                undefined);
        if (typeExpr instanceof TypeImplementedByExpression) {
            const whens = [...typeExpr.typeImplementations].map(([ctor, id]) =>
                new When(new IsNotNullExpression(id.value), new SqlConstantExpression(niceName(ctor), LiteralType.string)));
            return new CaseExpression(whens, undefined);
        }
        throw new Error(`Type.niceName() is not supported for an @implementedByAll reference (no static type to localize)`);
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

    private addRequest(request: ExpansionRequest, source?: SourceExpression): void {
        source ??= this.getCurrentSource(request);
        const list = this.requests.get(source);
        if (list != null)
            list.push(request);
        else
            this.requests.set(source, [request]);
    }

    // Signum's ExpansionRequest.ExternalAlias: the correlation aliases a request reads
    // from an *outer* source. A TableRequest reads the FK column's alias (its condition,
    // minus its own table alias). A UniqueRequest reads the aliases its subquery uses but
    // does not itself declare (used − declared, with declared expanded transitively).
    private externalAlias(request: ExpansionRequest): Alias[] {
        if ("table" in request)
            return AliasGatherer.gather(request.condition).filter(a => !a.equals(request.table.alias));
        if ("select" in request) {
            const declared = DeclaredAliasGatherer.gather(request.select);
            this.expandKnownAlias(declared);
            return AliasGatherer.gather(request.select).filter(a => !declared.some(d => d.equals(a)));
        }
        // UnionRequest attaches to the top source (added directly by addUnionRequest).
        return [];
    }

    // Signum's GetCurrentSource: a completion join must attach to the source that owns
    // the alias(es) its correlation reads (the FK column's table), NOT blindly the top of
    // the stack. This is what lets the join splice INTO the inner subquery that declares
    // the FK (e.g. `Album A LEFT JOIN Label L ON A.LabelID = L.ID`), instead of wrapping
    // an outer select — the latter leaves the join and its columns unbindable (the
    // update-part bug). Searches the stack from the top, so the innermost matching source
    // wins; when a request carries no external alias it falls back to the top.
    private getCurrentSource(request: ExpansionRequest): SourceExpression {
        const stack = this.sourceStack;
        if (stack.length === 0)
            throw new Error("Expansion requested with no current source on the stack");
        const external = this.externalAlias(request);
        if (external.length === 0)
            // Signum's GetCurrentSource returns currentSource.Last() (the OUTERMOST source)
            // for a request with no outer correlation. A UniqueRequest apply may be shared
            // across disjoint sibling scopes (dedup), so it must attach where both can see it
            // — the outermost source. TableRequest completions keep altea's innermost
            // fallback (the update-part fix relies on it).
            return "select" in request ? stack[0] : stack[stack.length - 1];
        for (let i = stack.length - 1; i >= 0; i--) {
            const known = this.knownAliasesExpanded(stack[i]);
            if (external.some(a => known.some(k => k.equals(a))))
                return stack[i];
        }
        throw new Error("Impossible to get current source for aliases " + external.map(a => a.toString()).join(", "));
    }

    // Signum's KnownAliases + ExpandKnowAlias: a source knows its own aliases plus those
    // of any completion table already joined to a source it fully contains (chained
    // navigations — the second join's FK lives on the first join's table).
    private knownAliasesExpanded(source: SourceExpression): Alias[] {
        const result: Alias[] = [...source.knownAliases()];
        this.expandKnownAlias(result);
        return result;
    }

    // Signum's ExpandKnowAlias: grow `result` in place with the aliases contributed by any
    // request whose source is already fully known — a TableRequest adds its joined table's
    // alias; a UniqueRequest adds all the aliases its APPLY subquery declares; a
    // UnionRequest adds its union alias. Repeated to a fixpoint (chained navigations).
    private expandKnownAlias(result: Alias[]): void {
        const has = (a: Alias) => result.some(x => x.equals(a));
        const add = (a: Alias) => { if (!has(a)) { result.push(a); return true; } return false; };
        let changed = true;
        while (changed) {
            changed = false;
            for (const [key, reqs] of this.requests) {
                if (!key.knownAliases().every(has))
                    continue;
                for (const r of reqs) {
                    if ("table" in r) {
                        if (add(r.table.alias)) changed = true;
                    } else if ("select" in r) {
                        for (const a of r.select.knownAliases())
                            if (add(a)) changed = true;
                    } else if ("union" in r) {
                        const ua = (r.union as unknown as { unionAlias?: Alias }).unionAlias;
                        if (ua != null && add(ua)) changed = true;
                    }
                }
            }
        }
    }

    private getTableProjection(ctor: new () => object): ProjectionExpression {
        return this.getTableProjectionForTable(this.schema.table(ctor as any), new ClassType(ctor));
    }

    // A query-only SQL function (Signum's [SqlMethod]). The result type tells scalar from
    // table-/set-returning: an ArrayType result → a table-valued-function source (a view or a
    // scalar column, see bindTableValuedFunction); any other (scalar) result → a plain
    // `<name>(args)` SqlFunctionExpression.
    private bindSqlMethod(functionName: string, call: CallExpression): Expression {
        if (call.type instanceof ArrayType)
            return this.bindTableValuedFunction(functionName, call.args, call.type);
        return new SqlFunctionExpression(call.type, undefined, functionName, call.args.map(a => this.visit(a)));
    }

    // A set-returning / table-valued function used as a source. Two shapes, told apart by the
    // element of the call's result type (@returnType, carried in __resultType):
    //   • a scalar element (Postgres generate_subscripts → number): a single output column
    //     named "value" projected as that scalar → Query<number>.
    //   • an IView element (an inline TVF UDF like dbo.MinimumTableValued, Signum's
    //     `IQueryable<IntValue>`): the view's fields become the output columns, projected as
    //     `{ field: <column>, … }` so `.map(m => m.field)` binds → Query<{ field: … }>.
    // The function arguments are bound in the current scope, so when they reference outer
    // columns the formatter emits a CROSS JOIN LATERAL / CROSS APPLY.
    private bindTableValuedFunction(functionName: string, args: readonly Expression[], resultType: Type): ProjectionExpression {
        const boundArgs = args.map(a => this.visit(a));
        const tableAlias = this.aliasGenerator.nextTableAlias(functionName);

        // The IView row type is the ClassType element of the ArrayType result; a scalar element
        // (or an untyped call, e.g. generate_subscripts) has no view.
        const element = resultType instanceof ArrayType ? resultType.elementType : undefined;
        const viewCtor = element instanceof ClassType ? element.constructorFunction : undefined;

        let source: SqlTableValuedFunctionExpression;
        let projector: Expression;
        let elementType: Type;
        if (viewCtor != null) {
            // Reflect the IView row type into its output columns (Signum reflects the SqlMethod's
            // IQueryable<T> element). The Postgres column-alias list (see queryFormatter) names a
            // single column, so a TVF view maps to exactly one column for now.
            const cols = viewColumns(viewCtor);
            if (cols.length !== 1)
                throw new Error(`Table-valued function '${functionName}' view '${viewCtor.name}' must declare exactly one column (got ${cols.length}).`);
            const [c] = cols;
            // A user-defined TVF in a FROM clause must be schema-qualified on SQL Server (an
            // unqualified TVF name is rejected there); Postgres resolves it via search_path but a
            // qualified name is equally valid. Qualify an unqualified @sqlMethod name with the
            // dialect default schema (built-in set-returning functions carry their own qualified
            // name and take the bare-column branch below, so they're unaffected).
            const qualifiedName = functionName.includes(".") ? functionName : `${this.isPostgres ? "public" : "dbo"}.${functionName}`;
            source = new SqlTableValuedFunctionExpression(tableAlias, qualifiedName, c.column, boundArgs);
            projector = new ObjectExpression({ [c.property]: new ColumnExpression(c.type, tableAlias, c.column) });
            elementType = new ObjectType({ [c.property]: c.type });
        } else {
            source = new SqlTableValuedFunctionExpression(tableAlias, functionName, "value", boundArgs);
            projector = new ColumnExpression(LiteralType.number, tableAlias, "value");
            elementType = LiteralType.number;
        }

        const selectAlias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(projector, selectAlias);
        return new ProjectionExpression(
            new SelectExpression(selectAlias, false, undefined, pc.columns, source, undefined, [], []),
            pc.projector, undefined, new ArrayType(elementType));
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
    // Public for EntityCompleter (Signum calls binder.MListProjection from VisitMList).
    fieldEntityArrayProjection(fea: FieldEntityArrayExpression): ProjectionExpression {
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

    // SelectMany (flatMap): bind the collection selector against the source, then APPLY the
    // (correlated) collection sub-projection onto the source. Signum's BindSelectMany
    // (single-selector form). A trailing `.defaultIfEmpty()` on the collection selector is
    // peeled off *before* binding (Signum's OverloadingSimplifier.ExtractDefaultIfEmpty) and
    // makes the apply an OUTER APPLY (outer rows survive with a null inner); otherwise a CROSS
    // APPLY.
    private bindSelectMany(projection: ProjectionExpression, selectorRaw: LambdaExpression): ProjectionExpression {
        const { selector, outer } = this.extractDefaultIfEmpty(selectorRaw);
        const { expression: coll, projection: proj } = this.mapVisitExpandIndexed(selector, projection);
        const collProj = this.asProjection(coll);

        const alias = this.aliasGenerator.nextSelectAlias();
        const pc = this.projectColumns(collProj.projector, alias);
        const join = new JoinExpression(outer ? "OuterApply" : "CrossApply", proj.select, collProj.select, undefined);
        return new ProjectionExpression(
            new SelectExpression(alias, false, undefined, pc.columns, join, undefined, [], []),
            pc.projector, undefined, collProj.type);
    }

    // Signum's OverloadingSimplifier.ExtractDefaultIfEmpty: strip a `.defaultIfEmpty()` that is
    // the *outermost* (last) operator of the flatMap collection selector → OUTER APPLY; the
    // collection it wraps (however built — filter/map/…) is bound as-is. A `defaultIfEmpty()`
    // anywhere else is left in place and errors when the binder reaches it (the `defaultIfEmpty`
    // dispatch case), so it must genuinely be the last operator.
    private extractDefaultIfEmpty(selector: LambdaExpression): { selector: LambdaExpression, outer: boolean } {
        const body = selector.body;
        if (isNoArgMethodCall(body, "defaultIfEmpty")) {
            const receiver = ((body as CallExpression).func as PropertyExpression).object;
            return { selector: new LambdaExpression(selector.parameters, receiver), outer: true };
        }
        return { selector, outer: false };
    }

    // Join — port of Signum's BindJoin. The join type is explicit (the binder is
    // called from innerJoin/leftJoin/rightJoin/fullJoin), so there's no DefaultIfEmpty
    // marker to detect: leftJoin preserves the outer (left) side, rightJoin the inner
    // (right), fullJoin both. The result selector takes two parameters (outer, inner)
    // and binds against the join, so navigations in it splice on via QueryJoinExpander.
    private bindJoin(joinType: JoinType, outerSourceRaw: Expression, innerSourceRaw: Expression, outerKey: LambdaExpression, innerKey: LambdaExpression, resultSelector: LambdaExpression): ProjectionExpression {
        const outerProj = this.asProjection(this.visit(outerSourceRaw));
        const innerProj = this.asProjection(this.visit(innerSourceRaw));

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
        // Re-visit the source for an independent element subquery (Signum visits the source
        // twice). Route through asProjection (our VisitCastProjection) so a navigated-collection
        // source (`band.members.groupBy(…)` in a correlated flatMap) is realised into a
        // correlated sub-projection — a raw `this.visit(...) as ProjectionExpression` leaves a
        // FieldEntityArrayExpression whose absent projector maps the lambda param to undefined.
        const subqueryProjection = this.asProjection(this.visit(sourceExpr));

        let alias = this.aliasGenerator.nextSelectAlias();

        // The grouping key must be nominated aggressively (its computed value forms the GROUP
        // BY columns) — a lazy projection would group on the key's raw leaf columns instead.
        const key = GroupEntityCleaner.clean(this.mapVisitExpand(keySelector, projection));
        let keyPC = this.projectColumns(key, alias, /* aggressive */ true);

        let select = projection.select;

        // SQL Server rejects an aggregate/subquery as a grouping key (error 144: "Cannot use
        // an aggregate or a subquery in an expression used for the group by list"). When the
        // key contains one (e.g. `groupBy(a => a.songs.length)` — a correlated COUNT), wrap the
        // source in an intermediate SELECT that projects the key as a column, then GROUP BY a
        // plain reference to that column. Signum's BindGroupBy "key contains an aggregate" branch.
        if (keyPC.columns.some(c => ContainsAggregateVisitor.test(c.expression))) {
            select = new SelectExpression(alias, false, undefined, keyPC.columns, projection.select, undefined, [], []);
            alias = this.aliasGenerator.nextSelectAlias();
            const cg = new ColumnGenerator();
            const newColumns = keyPC.columns.map(cd => cg.mapColumn(cd.getReference(select.alias)));
            const replacements = new Map<string, ColumnExpression>();
            for (const cd of newColumns)
                replacements.set(columnKey(cd.expression as ColumnExpression), cd.getReference(alias));
            keyPC = { columns: newColumns, projector: ColumnReplacerVisitor.replace(replacements, keyPC.projector) };
        }

        const elemExpr = elementSelector != null
            ? this.mapVisitExpand(elementSelector, projection)
            : projection.projector;

        const subqueryKey = GroupEntityCleaner.clean(this.mapVisitExpand(keySelector, subqueryProjection));
        const subqueryKeyPC = this.projectColumns(subqueryKey, this.aliasGenerator.raw("basura"), /* aggressive */ true);
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
    // lazy EntityExpression (completed on navigation, step 5), collection
    // (FieldEntityArray) → an eager marker EntityCompleter expands into a child query.
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
            const binding = this.bindField(ef, alias, externalId.value);
            if (binding != null)
                bindings.push(new FieldBinding(ef.fieldInfo, binding));
        }

        const mixins: MixinEntityExpression[] = [];
        for (const fm of Object.values(table.mixins)) {
            const mixinBindings: FieldBinding[] = [];
            for (const ef of Object.values(fm.fields)) {
                const binding = this.bindField(ef, alias, externalId.value);
                if (binding != null)
                    mixinBindings.push(new FieldBinding(ef.fieldInfo, binding));
            }
            // Type the mixin by its own class (FieldMixin.mixinType) so a query's
            // `entity.mixin(X)` can match it; fall back to the owner type if unknown.
            const mixinType = fm.mixinType != null ? new ClassType(fm.mixinType as any) : new ClassType(table.type as any);
            mixins.push(new MixinEntityExpression(mixinType, mixinBindings, alias));
        }

        return new EntityExpression(
            new ClassType(table.type as any), table, externalId, alias, bindings,
            mixins.length ? mixins : undefined, false);
    }

    private bindField(ef: EntityField, alias: Alias, ownerId?: Expression): Expression | undefined {
        const f = ef.field;

        // FieldEnum extends FieldReference — check before FieldReference. Stored as
        // its numeric value; typed EnumType so the nominator can lower `.toString()`
        // to a value→name CASE (falls back to number when the enum isn't registered).
        if (f instanceof FieldEnum) {
            const enumObj = resolveEnum(ef.fieldInfo.typeName);
            const type: Type = enumObj != null ? new EnumType(enumObj, ef.fieldInfo.typeName) : LiteralType.number;
            return new ColumnExpression(type, alias, f.column.name);
        }

        if (f instanceof FieldValue) // includes FieldTicks
            return new ColumnExpression(this.valueType(ef.fieldInfo), alias, f.column.name);

        if (f instanceof FieldReference) {
            // Lazy single reference: an EntityExpression whose id is the FK column;
            // bindings stay undefined until a navigation completes it.
            const refTable = f.column.referenceTable!;
            const refType = new ClassType(refTable.type as any);
            const externalId = new PrimaryKeyExpression(new ColumnExpression(LiteralType.number, alias, f.column.name));
            const entity = new EntityExpression(refType, refTable, externalId, undefined, undefined, undefined, f.avoidExpandOnRetrieving);
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
                implementations.set(implCtor, new EntityExpression(new ClassType(implCtor), implTable, externalId, undefined, undefined, undefined, f.avoidExpandOnRetrieving));
            }
            const ib = new ImplementedByExpression(new ClassType(this.refCleanCtor(ef.fieldInfo)), "Case", implementations);
            return f.isLite ? new LiteReferenceExpression(new LiteType(ib.type), ib, undefined) : ib;
        }

        if (f instanceof FieldImplementedByAll) {
            // One id column per PK type ('int'/'long'/'uuid'); the discriminator holds the
            // target's TypeEntity int id.
            const ids = new Map<string, Expression>();
            for (const col of f.idColumns)
                ids.set(col.pkType, new ColumnExpression(LiteralType.number, alias, col.name));
            const typeId = new TypeImplementedByAllExpression(new ColumnExpression(LiteralType.number, alias, f.typeColumn.name));
            const iba = new ImplementedByAllExpression(new ClassType(this.refCleanCtor(ef.fieldInfo)), ids, typeId);
            return f.isLite ? new LiteReferenceExpression(new LiteType(iba.type), iba, undefined) : iba;
        }

        // FieldEntityArray: an eager collection (Signum's MList). Bind a marker carrying
        // the correlation key (the owner's id); EntityCompleter.visitFieldEntityArray
        // realises it into a correlated child projection and recurses (so element entities'
        // own references/collections expand too), which ChildProjectionFlattener then
        // eager-loads as one extra query per level — matching Signum's VisitMList. An
        // embedded sub-field has no owning id (ownerId == null), so its collections, if
        // any, stay lazy navigation targets.
        if (f instanceof FieldEntityArray) {
            if (ownerId == null)
                return undefined;
            const childTable = this.schema.table(f.childType as any);
            return new FieldEntityArrayExpression(new ClassType(f.childType as any), childTable, f.childFkProperty, ownerId);
        }

        return undefined;
    }

    // The declared (base) constructor of a polymorphic reference field — e.g.
    // `Entity` for `author: Entity`. Used only for the IB/IBA expression's nominal
    // `.type`; the reader materialises the concrete implementation, never this.
    private refCleanCtor(fi: FieldInfo): Function {
        // The polymorphic reference's nominal base type. A field declared with an
        // interface type (e.g. `author: IAuthorEntity`, Signum-style) has no runtime
        // constructor — the base is nominal only (the reader picks the concrete
        // implementation), so fall back to Entity. Concrete base types resolve normally.
        return resolveType(fi.typeName) ?? Entity;
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
