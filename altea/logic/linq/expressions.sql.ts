import { Expression } from "./expressions";
import { LiteralType, Type } from "../../entities/types";
import type { FieldInfo } from "../../entities/reflection";
import type { Table } from "../schema/table";
import { Alias } from "./AliasGenerator";
import type { ExpressionVisitor } from "./visitors/ExpressionVisitor";
import { DbExpressionVisitor } from "./visitors/DbExpressionVisitor";

// Port of Signum's DbExpressions (Engine/Linq/DbExpressions.Sql.cs + .Signum.cs).
// The QueryBinder produces a tree of these; optimiser passes rewrite it; the
// QueryFormatter renders the SQL nodes and the ProjectionReader materialises
// from the projector. `kind` doubles as Signum's DbExpressionType discriminator.
//
// This is the core set (steps 1–5): SQL sources/scalars + Projection + the
// entity-semantic nodes (Entity/Embedded/Mixin/PrimaryKey). Deferred to their
// tiers: command nodes (Update/Delete/Insert), MList*, ImplementedBy*, Lite*,
// Type*, Interval/temporal, TVF, RowNumber, SqlCast, hierarchy.

// Source nodes (FROM clauses) carry no SQL value type of their own.
const SOURCE_TYPE: Type = LiteralType.null;

export function asDbVisitor(visitor: ExpressionVisitor): DbExpressionVisitor {
    if (visitor instanceof DbExpressionVisitor)
        return visitor;

    throw new Error(`DbExpression trees must be traversed with a DbExpressionVisitor (acceptDb), not ExpressionVisitor (accept)`);
}

export abstract class DbExpression extends Expression {
    constructor(kind: string, type: Type) {
        super(kind, type);
    }

}

// ---- Enums (string unions; Signum's enums) -------------------------------

export type OrderType = "Ascending" | "Descending";

export type JoinType =
    | "CrossJoin" | "InnerJoin" | "CrossApply" | "OuterApply"
    | "LeftOuterJoin" | "SingleRowLeftOuterJoin" | "RightOuterJoin" | "FullOuterJoin";

export type SetOperator = "Union" | "UnionAll" | "Intersect" | "Except";

export type AggregateSqlFunction =
    | "Average" | "StdDev" | "StdDevP" | "Count" | "CountDistinct"
    | "Min" | "Max" | "Sum" | "string_agg";

export function aggregateOrderMatters(fn: AggregateSqlFunction): boolean {
    return fn === "string_agg";
}

export type UniqueFunction = "First" | "FirstOrDefault" | "Single" | "SingleOrDefault";

// Signum's [Flags] SelectOptions, as a bitmask.
export const SelectOptions = {
    None: 0,
    Reverse: 1,
    ForXmlPathEmpty: 2,
    OrderAlsoByKeys: 4,
    HasIndex: 8,
} as const;
export type SelectOptions = number;

// ---- Sources -------------------------------------------------------------

export abstract class SourceExpression extends DbExpression {
    constructor(kind: string) {
        super(kind, SOURCE_TYPE);
    }
    abstract knownAliases(): Alias[];
}

export abstract class SourceWithAliasExpression extends SourceExpression {
    constructor(kind: string, public readonly alias: Alias) {
        super(kind);
    }
}

export class TableExpression extends SourceWithAliasExpression {
    constructor(
        alias: Alias,
        public readonly table: Table,
        public readonly withHint?: string,
    ) {
        super("Table", alias);
    }

    get name() { return this.table.name; }

    knownAliases(): Alias[] {
        return [this.alias];
    }

    toString(): string {
        return `${this.name} as ${this.alias}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return asDbVisitor(visitor).visitTable(this);
    }
}

export class ColumnExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly alias: Alias,
        public readonly name: string | undefined,
    ) {
        super("Column", type);
    }

    equalsColumn(other: ColumnExpression | undefined): boolean {
        return other != null && this.alias.equals(other.alias) && this.name === other.name;
    }

    toString(): string {
        return `${this.alias}.${this.name}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return asDbVisitor(visitor).visitColumn(this);
    }
}

// SELECT-list item: a server expression exposed under `name`.
export class ColumnDeclaration {
    constructor(
        public readonly name: string,
        public readonly expression: Expression,
    ) { }

    toString(): string {
        return this.name ? `${this.name} = ${this.expression}` : this.expression.toString();
    }

    // A reference to this declaration from an enclosing SELECT aliased `alias`.
    getReference(alias: Alias): ColumnExpression {
        return new ColumnExpression(this.expression.type, alias, this.name);
    }
}

export class OrderExpression {
    constructor(
        public readonly orderType: OrderType,
        public readonly expression: Expression,
    ) { }

    toString(): string {
        return `${this.expression} ${this.orderType === "Ascending" ? "ASC" : "DESC"}`;
    }
}

export class SelectExpression extends SourceWithAliasExpression {
    readonly #knownAliases: Alias[];

    constructor(
        alias: Alias,
        public readonly isDistinct: boolean,
        public readonly top: Expression | undefined,
        public readonly columns: readonly ColumnDeclaration[],
        public readonly from: SourceExpression | undefined,
        public readonly where: Expression | undefined,
        public readonly orderBy: readonly OrderExpression[],
        public readonly groupBy: readonly Expression[],
        public readonly selectOptions: SelectOptions = SelectOptions.None,
        // OFFSET (the `skip` count). Optional 10th arg so existing constructions are
        // unaffected; the optimiser passes thread it through alongside `top`.
        public readonly offset: Expression | undefined = undefined,
    ) {
        super("Select", alias);
        this.#knownAliases = from == null ? [alias] : [...from.knownAliases(), alias];
    }

    knownAliases(): Alias[] {
        return this.#knownAliases;
    }

    isOneRow(): boolean {
        const t = this.top as { value?: unknown } | undefined;
        return t != null && (t as any).value === 1;
    }

    toString(): string {
        const cols = this.columns.map(c => c.toString()).join(",\n");
        return `SELECT ${this.isDistinct ? "DISTINCT " : ""}${this.top != null ? `TOP ${this.top} ` : ""}${cols}\n` +
            `FROM ${this.from ?? ""}\n` +
            `${this.where != null ? `WHERE ${this.where}\n` : ""}` +
            `${this.orderBy.length ? `ORDER BY ${this.orderBy.join(", ")}\n` : ""}` +
            `${this.groupBy.length ? `GROUP BY ${this.groupBy.join(", ")}\n` : ""}` +
            `${this.offset != null ? `OFFSET ${this.offset}\n` : ""}` +
            `AS ${this.alias}`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitSelect(this);
    }
}

export class JoinExpression extends SourceExpression {
    constructor(
        public readonly joinType: JoinType,
        public readonly left: SourceExpression,
        public readonly right: SourceExpression,
        public readonly condition: Expression | undefined,
    ) {
        super("Join");
        if (condition == null && joinType !== "CrossApply" && joinType !== "OuterApply" && joinType !== "CrossJoin")
            throw new Error(`Join '${joinType}' requires a condition`);
    }

    knownAliases(): Alias[] {
        return [...this.left.knownAliases(), ...this.right.knownAliases()];
    }

    toString(): string {
        return `${this.left}\n${this.joinType}\n${this.right}\nON ${this.condition ?? ""}`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitJoin(this);
    }
}

// A set operation (UNION ALL / …) over two aliased sub-selects, exposed to the
// enclosing query under a single `alias` (Signum's SetOperatorExpression). Used by
// the @implementedBy UNION combine strategy: each implementation contributes one
// inner SELECT, all folded into a UNION ALL and joined to the owner once.
export class SetOperatorExpression extends SourceWithAliasExpression {
    constructor(
        public readonly operator: SetOperator,
        public readonly left: SourceWithAliasExpression,
        public readonly right: SourceWithAliasExpression,
        alias: Alias,
    ) {
        super("SetOperator", alias);
    }

    knownAliases(): Alias[] {
        return [this.alias, ...this.left.knownAliases(), ...this.right.knownAliases()];
    }

    toString(): string {
        return `(${this.left})\n${this.operator}\n(${this.right})\nAS ${this.alias}`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitSetOperator(this);
    }
}

// ---- Scalar SQL nodes ----------------------------------------------------

export class AggregateExpression extends DbExpression {
    readonly arguments: readonly Expression[];
    constructor(
        type: Type,
        public readonly aggregateFunction: AggregateSqlFunction,
        args: readonly Expression[],
        public readonly orderBy: readonly OrderExpression[] | undefined,
    ) {
        super("Aggregate", type);
        this.arguments = args;
    }

    toString(): string {
        const inner = this.arguments.length ? this.arguments.join(", ") : "*";
        return `${this.aggregateFunction}(${this.aggregateFunction === "CountDistinct" ? "Distinct " : ""}${inner})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitAggregate(this);
    }
}

// Signum's RowNumberExpression: ROW_NUMBER() OVER (ORDER BY …), the source of the
// index in an indexed selector (`map((x, i) => …)`). Signum starts with an empty
// orderBy and fills it from gathered orderings in a later pass; altea passes the
// enclosing select's orderBy through directly and the formatter falls back to a
// constant ORDER BY when it's empty (the query imposes no order).
export class RowNumberExpression extends DbExpression {
    constructor(
        public readonly orderBy: readonly OrderExpression[],
    ) {
        super("RowNumber", LiteralType.number);
    }

    toString(): string {
        return "ROW_NUMBER()";
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitRowNumber(this);
    }

    updateRowNumber(orderBy: readonly OrderExpression[]): RowNumberExpression {
        return orderBy === this.orderBy ? this : new RowNumberExpression(orderBy);
    }
}

// Signum's AggregateRequestsExpression: a deferred aggregate that logically
// belongs to the GROUP BY select identified by `groupByAlias`. The binder emits
// it for an aggregate written over a grouping's elements (e.g. `g.elements.sum()`);
// AggregateRewriter later hoists the inner aggregate into that select as an extra
// column and replaces the request with a reference to that column.
export class AggregateRequestsExpression extends DbExpression {
    constructor(
        public readonly groupByAlias: Alias,
        public readonly aggregate: AggregateExpression,
    ) {
        super("AggregateRequest", aggregate.type);
    }

    toString(): string {
        return `AggregateRequest OF ${this.groupByAlias}(${this.aggregate})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitAggregateRequest(this);
    }
}

export class SqlFunctionExpression extends DbExpression {
    readonly arguments: readonly Expression[];
    constructor(
        type: Type,
        public readonly object: Expression | undefined,
        public readonly sqlFunction: string,
        args: readonly Expression[],
    ) {
        super("SqlFunction", type);
        this.arguments = args;
    }

    toString(): string {
        const call = `${this.sqlFunction}(${this.arguments.join(", ")})`;
        return this.object == null ? call : `${this.object}.${call}`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitSqlFunction(this);
    }
}

// `array[index]` — a Postgres array subscript (1-based). Port of the `conkey[i]` pattern in
// Signum's PostgresCatalogSchema; altea reaches it through the `arrayGet(arr, i)` marker
// (element access can't be quoted). Postgres-only.
export class SqlArrayIndexExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly array: Expression,
        public readonly index: Expression,
    ) {
        super("SqlArrayIndex", type);
    }

    toString(): string {
        return `${this.array}[${this.index}]`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitArrayIndex(this);
    }
}

// A set-returning function used as a FROM source: `functionName(args) AS alias(columnName)`.
// Port of Signum's use of `generate_subscripts(...)` as a queryable; formatted as a LATERAL
// source when it correlates with an outer row. Postgres-only.
export class SqlTableValuedFunctionExpression extends SourceWithAliasExpression {
    readonly arguments: readonly Expression[];
    constructor(
        alias: Alias,
        public readonly functionName: string,
        public readonly columnName: string,
        args: readonly Expression[],
    ) {
        super("SqlTableValuedFunction", alias);
        this.arguments = args;
    }

    knownAliases(): Alias[] {
        return [this.alias];
    }

    toString(): string {
        return `${this.functionName}(${this.arguments.join(", ")}) as ${this.alias}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return asDbVisitor(visitor).visitTableValuedFunction(this);
    }
}

// `CAST(expression AS sqlType)` — a minimal port of Signum's SqlCastExpression. The
// `sqlType` is the dialect-specific target SQL type text (e.g. "varchar"/"nvarchar(max)").
export class SqlCastExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly expression: Expression,
        public readonly sqlType: string,
    ) {
        super("SqlCast", type);
    }

    toString(): string {
        return `Cast(${this.expression} as ${this.sqlType})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitSqlCast(this);
    }
}

// Wraps a raw SQL day-of-week extraction (`DATEPART(weekday, x)`) whose value must be
// normalised to the Temporal-ISO weekday (Mon=1..Sun=7) — but only in the *projector*, so
// the DATEFIRST arithmetic doesn't contaminate the SELECT/GROUP BY. Signum's
// ToDayOfWeekExpression. SQL Server only: Postgres uses `EXTRACT(isodow …)`, which is ISO
// with no conversion, so it never needs this wrapper. Non-nominated in projection contexts
// (the raw inner becomes the column, the conversion is compiled by TranslatorBuilder);
// inlined server-side in a WHERE/predicate (see the nominator).
export class ToDayOfWeekExpression extends DbExpression {
    constructor(public readonly expression: Expression) {
        super("ToDayOfWeek", LiteralType.number);
    }

    toString(): string {
        return `ToDayOfWeek(${this.expression})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitToDayOfWeek(this);
    }
}

export class SqlConstantExpression extends DbExpression {
    constructor(
        public readonly value: unknown,
        type: Type,
    ) {
        super("SqlConstant", type);
    }

    toString(): string {
        return this.value == null ? "NULL" : `${this.value}`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitSqlConstant(this);
    }
}

// Raw SQL text rendered verbatim — no quoting, no parameter (Signum's
// SqlLiteralExpression). Used for tokens that aren't values, e.g. the date-part
// keyword in `DATEPART(year, …)` or `EXTRACT(year from …)`.
export class SqlLiteralExpression extends DbExpression {
    constructor(
        public readonly value: string,
        type: Type = LiteralType.string,
    ) {
        super("SqlLiteral", type);
    }

    toString(): string {
        return this.value;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitSqlLiteral(this);
    }
}

export class When {
    constructor(
        public readonly condition: Expression,
        public readonly value: Expression,
    ) { }

    toString(): string {
        return `  WHEN ${this.condition} THEN ${this.value}`;
    }
}

export class CaseExpression extends DbExpression {
    constructor(
        public readonly whens: readonly When[],
        public readonly defaultValue: Expression | undefined,
    ) {
        super("Case", whens[0]?.value.type ?? LiteralType.null);
        if (whens.length === 0)
            throw new Error("CaseExpression requires at least one When");
    }

    toString(): string {
        return `CASE\n${this.whens.join("\n")}\n  ELSE ${this.defaultValue ?? "NULL"}\nEND`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitCase(this);
    }
}

export class LikeExpression extends DbExpression {
    constructor(
        public readonly expression: Expression,
        public readonly pattern: Expression,
    ) {
        super("Like", LiteralType.boolean);
    }

    toString(): string {
        return `${this.expression} LIKE ${this.pattern}`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitLike(this);
    }
}

export abstract class SubqueryExpression extends DbExpression {
    constructor(kind: string, type: Type, public readonly select: SelectExpression | undefined) {
        super(kind, type);
    }
}

export class ScalarExpression extends SubqueryExpression {
    constructor(type: Type, select: SelectExpression) {
        super("Scalar", type, select);
    }

    toString(): string {
        return `SCALAR(${this.select})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitScalar(this);
    }
}

export class ExistsExpression extends SubqueryExpression {
    constructor(select: SelectExpression) {
        super("Exists", LiteralType.boolean, select);
    }

    toString(): string {
        return `EXISTS(${this.select})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitExists(this);
    }
}

export class InExpression extends SubqueryExpression {
    constructor(
        public readonly expression: Expression,
        select: SelectExpression | undefined,
        public readonly values: unknown[] | undefined,
    ) {
        super("In", LiteralType.boolean, select);
    }

    static fromValues(expression: Expression, values: unknown[]): InExpression {
        return new InExpression(expression, undefined, values);
    }

    toString(): string {
        return `${this.expression} IN (${this.select ?? this.values?.join(", ")})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitIn(this);
    }
}

export class IsNullExpression extends DbExpression {
    constructor(public readonly expression: Expression) {
        super("IsNull", LiteralType.boolean);
    }

    toString(): string {
        return `${this.expression} IS NULL`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitIsNull(this);
    }
}

export class IsNotNullExpression extends DbExpression {
    constructor(public readonly expression: Expression) {
        super("IsNotNull", LiteralType.boolean);
    }

    toString(): string {
        return `${this.expression} IS NOT NULL`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitIsNotNull(this);
    }
}

// ---- Projection ----------------------------------------------------------

export class ProjectionExpression extends DbExpression {
    constructor(
        public readonly select: SelectExpression,
        public readonly projector: Expression,
        public readonly uniqueFunction: UniqueFunction | undefined,
        resultType: Type,
    ) {
        super("Projection", resultType);
    }

    toString(): string {
        return `(SOURCE\n${this.select}\nPROJECTOR\n${this.projector})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitProjection(this);
    }
}

// Unique marker for an eager/lazy child projection (Signum's LookupToken).
export class LookupToken {
    constructor(public readonly id: number) { }
}

export class ChildProjectionExpression extends DbExpression {
    constructor(
        public readonly projection: ProjectionExpression,
        public readonly outerKey: Expression,
        public readonly isLazyMList: boolean,
        type: Type,
        public readonly token: LookupToken,
    ) {
        super("ChildProjection", type);
    }

    toString(): string {
        return `${this.projection}.InLookup(${this.outerKey})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitChildProjection(this);
    }
}

// A collection navigation over a FieldEntityArray (the altea analogue of Signum's
// MList; "MList" is not an altea concept). Produced transiently by the binder when
// `owner.someCollection` is navigated, and realised on demand
// (QueryBinder.fieldEntityArrayProjection) into a correlated ProjectionExpression
// over the child table (WHERE child.<fk> = owner id), so it never survives into the
// column projector / SQL. `ownerId` is the parent's id expression (the correlation
// key); `fkProperty` names the child's back-reference.
export class FieldEntityArrayExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly childTable: Table,
        public readonly fkProperty: string,
        public readonly ownerId: Expression,
    ) {
        super("FieldEntityArray", type);
    }

    toString(): string {
        return `FieldEntityArray(${this.childTable.name.name}.${this.fkProperty} = ${this.ownerId})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitFieldEntityArray(this);
    }
}

// What a Lite<T> can wrap: a concrete entity reference, or a polymorphic
// ImplementedBy / ImplementedByAll reference (Signum's `Reference` is likewise a
// FieldExpression | ImplementedBy | ImplementedByAll). All three carry the id
// (and, for the polymorphic ones, the type) the reader needs to build a LiteImp.
export type LiteReferenceTarget = EntityExpression | ImplementedByExpression | ImplementedByAllExpression;

// A Lite<T> value in the expression tree (Signum's LiteReferenceExpression). It
// wraps the underlying entity reference (which carries the id column + entity
// type); `toStr` is the optional display-string expression. The column projector
// projects only the wrapped id, and the reader materialises a LiteImp from it —
// so a Lite loads id+type, never the full entity. `toStr` is deferred (a proper
// server-side toString expression per type is a later tier), so lites currently
// materialise with an empty display string.
export class LiteReferenceExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly reference: LiteReferenceTarget,
        public readonly toStr: Expression | undefined,
    ) {
        super("LiteReference", type);
    }

    toString(): string {
        return `Lite(${this.reference})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitLiteReference(this);
    }
}

// The reduced, ready-to-project form of a Lite<T> (Signum's LiteValueExpression).
// EntityCompleter rewrites every projected LiteReferenceExpression into this: it keeps
// only the identity (`typeId` — a TypeEntity/TypeImplementedBy/TypeImplementedByAll
// expression — plus the coalesced `id`) and the display model, DROPPING the wrapped
// entity's field bindings. That is what stops a lite over a fully-retrieved (bound) root
// entity from dragging every one of its columns into the SELECT: only id + type + model
// remain referenced, so UnusedColumnRemover prunes the rest.
//
// The display model is either a single `toStr` (a typed reference or @implementedByAll) or,
// for an @implementedBy reference, a per-implementation `models` map (Signum's GetModels
// dictionary) — one model expression per concrete type, NOT a combined CASE. The reader
// dispatches on the runtime type and evaluates that implementation's model client-side, so
// no CASE / IS NULL is ever pushed into the projector.
export class LiteValueExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly typeId: Expression,
        public readonly id: Expression,
        public readonly toStr: Expression | undefined,
        public readonly models: ReadonlyMap<Function, Expression> | undefined = undefined,
    ) {
        super("LiteValue", type);
    }

    toString(): string {
        const model = this.models != null
            ? `{${[...this.models].map(([c, e]) => `${c.name}: ${e}`).join(", ")}}`
            : (this.toStr ?? "-");
        return `LiteValue(${this.typeId}; ${this.id}; ${model})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitLiteValue(this);
    }
}

// ---- Entity-semantic nodes (rewritten away before SQL) -------------------

// A field name paired with the expression it binds to in an entity constructor.
export class FieldBinding {
    constructor(
        public readonly fieldInfo: FieldInfo,
        public readonly binding: Expression,
    ) { }

    toString(): string {
        return `${this.fieldInfo.name} = ${this.binding}`;
    }
}

// Wraps the (nullable) column that carries an entity id, so the binder can treat
// PrimaryKey specially. `value` is the underlying column expression.
export class PrimaryKeyExpression extends DbExpression {
    constructor(public readonly value: Expression) {
        super("PrimaryKey", value.type);
    }

    toString(): string {
        return `PK(${this.value})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitPrimaryKey(this);
    }
}

export class EntityExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly table: Table,
        public readonly externalId: PrimaryKeyExpression,
        public readonly tableAlias: Alias | undefined,
        public readonly bindings: readonly FieldBinding[] | undefined,
        public readonly mixins: readonly MixinEntityExpression[] | undefined,
        public readonly avoidExpandOnRetrieving: boolean = false,
    ) {
        super("Entity", type);
    }

    getBinding(fi: FieldInfo): Expression {
        if (this.bindings == null)
            throw new Error("EntityExpression not completed (no bindings)");
        const binding = this.bindings.find(fb => fb.fieldInfo === fi || fb.fieldInfo.name === fi.name);
        if (binding == null)
            throw new Error(`field '${fi.name}' not found on ${this.type}`);
        return binding.binding;
    }

    toString(): string {
        const ctor = `new ${this.type}(${this.externalId})`;
        return this.bindings == null ? ctor : `${ctor}\n{ ${this.bindings.join(",\n ")} }`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitEntity(this);
    }
}

export class EmbeddedEntityExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly hasValue: Expression,
        public readonly bindings: readonly FieldBinding[],
        public readonly mixins: readonly MixinEntityExpression[] | undefined,
    ) {
        super("EmbeddedInit", type);
    }

    getBinding(fi: FieldInfo): Expression {
        const binding = this.bindings.find(fb => fb.fieldInfo === fi || fb.fieldInfo.name === fi.name);
        if (binding == null)
            throw new Error(`embedded field '${fi.name}' not found on ${this.type}`);
        return binding.binding;
    }

    toString(): string {
        return `new ${this.type}\n{ ${this.bindings.join(",\n ")} }`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitEmbeddedEntity(this);
    }
}

export class MixinEntityExpression extends DbExpression {
    constructor(
        type: Type,
        public readonly bindings: readonly FieldBinding[],
        public readonly mainEntityAlias: Alias | undefined,
    ) {
        super("MixinInit", type);
    }

    getBinding(fi: FieldInfo): Expression {
        const binding = this.bindings.find(fb => fb.fieldInfo === fi || fb.fieldInfo.name === fi.name);
        if (binding == null)
            throw new Error(`mixin field '${fi.name}' not found on ${this.type}`);
        return binding.binding;
    }

    toString(): string {
        return `new ${this.type}\n{ ${this.bindings.join(",\n ")} }`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitMixinEntity(this);
    }
}

// ---- Polymorphic references (@implementedBy / @implementedByAll) ----------

// How a polymorphic reference combines its implementations when navigated.
// Signum exposes both via `.CombineUnion()` / `.CombineCase()`; altea has no
// combine API yet, so every IB is "Case" (a CASE-style switch over the
// implementations). Kept as a discriminator so the shape matches Signum.
export type CombineStrategy = "Case" | "Union";

// A @implementedBy reference: one nullable FK column per allowed implementation,
// at most one populated. `implementations` maps each implementation constructor
// to a (lazy) EntityExpression whose externalId is that implementation's column.
// Signum's ImplementedByExpression. The column projector recurses into the
// implementations (their id columns are the projected columns); the reader picks
// whichever implementation column is non-null.
export class ImplementedByExpression extends DbExpression {
    readonly implementations: ReadonlyMap<Function, EntityExpression>;
    constructor(
        type: Type,
        public readonly strategy: CombineStrategy,
        implementations: ReadonlyMap<Function, EntityExpression>,
    ) {
        super("ImplementedBy", type);
        this.implementations = implementations;
    }

    toString(): string {
        const imps = [...this.implementations.values()].map(e => e.toString()).join("\n | ");
        return `ImplementedBy(${this.strategy}){\n${imps}\n}`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitImplementedBy(this);
    }
}

// The type-discriminator half of @implementedByAll (Signum's
// TypeImplementedByAllExpression). `typeColumn` holds the target's TypeEntity int
// id; SmartEqualizer compares it against `TypeLogic.typeToId(ctor)` and the reader
// resolves it back to a constructor via `TypeLogic.tryGetType(id)`.
export class TypeImplementedByAllExpression extends DbExpression {
    constructor(public readonly typeColumn: Expression) {
        super("TypeImplementedByAll", LiteralType.string);
    }

    toString(): string {
        return `TypeIba(${this.typeColumn})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitTypeImplementedByAll(this);
    }
}

// A @implementedByAll reference: a single id column + a type discriminator
// (Signum's ImplementedByAllExpression — which keeps an Ids dictionary keyed by
// PrimaryKey type; altea has one id column, so `id` is a single expression). The
// reader resolves the discriminator string to a constructor and builds the
// matching row by id.
export class ImplementedByAllExpression extends DbExpression {
    // One id expression per primary-key type (Signum's Ids dictionary): the target can be
    // any entity, so its id lives in the column matching its PK type. Keyed by the altea
    // PrimaryKeyType ('int' | 'long' | 'uuid'); exactly one is non-null per row.
    constructor(
        type: Type,
        public readonly ids: ReadonlyMap<string, Expression>,
        public readonly typeId: TypeImplementedByAllExpression,
    ) {
        super("ImplementedByAll", type);
    }

    toString(): string {
        return `ImplementedByAll{ Ids = [${[...this.ids.keys()].join(",")}], Type = ${this.typeId} }`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitImplementedByAll(this);
    }
}

// ---- Type expressions (runtime type access in queries — Signum's GetType) -

// The runtime type of a typed entity reference (Signum's TypeEntityExpression).
// The concrete type is statically known (`typeValue`), but materialises to that
// type only when the row exists, so `externalId` is kept for the null check. The
// reader yields the constructor function — altea's analogue of a C# `Type`.
export class TypeEntityExpression extends DbExpression {
    constructor(
        public readonly externalId: PrimaryKeyExpression,
        public readonly typeValue: Type,
    ) {
        super("TypeEntity", LiteralType.string);
    }

    toString(): string {
        return `TypeEntity(${this.typeValue};${this.externalId})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitTypeEntity(this);
    }
}

// The runtime type of an @implementedBy reference (Signum's
// TypeImplementedByExpression): whichever implementation id column is non-null
// determines the type. `typeImplementations` maps each possible implementation
// constructor to its (nullable) id column.
export class TypeImplementedByExpression extends DbExpression {
    readonly typeImplementations: ReadonlyMap<Function, PrimaryKeyExpression>;
    constructor(typeImplementations: ReadonlyMap<Function, PrimaryKeyExpression>) {
        super("TypeImplementedBy", LiteralType.string);
        this.typeImplementations = typeImplementations;
    }

    toString(): string {
        const imps = [...this.typeImplementations].map(([c, id]) => `${(c as Function).name}(${id})`).join(" | ");
        return `TypeIb(${imps})`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitTypeImplementedBy(this);
    }
}

// ---- Command nodes (bulk DML) --------------------------------------------
// Port of Signum's CommandExpression hierarchy (DbExpressions.Sql.cs). These are
// the only nodes whose SQL value type is "void" — they format as a full statement
// (UPDATE/DELETE/INSERT … SELECT) and run via executeQuery, returning the affected
// row count (the formatter appends `SELECT @@rowcount` on SQL Server, or wraps the
// statement in a `WITH rows AS (… RETURNING 1) SELECT count(*)` CTE on Postgres).

const COMMAND_TYPE: Type = LiteralType.null;

export abstract class CommandExpression extends DbExpression {
    constructor(kind: string) {
        super(kind, COMMAND_TYPE);
    }
}

// One `column = expression` pair of an UPDATE SET / INSERT column list. Not a
// DbExpression itself (like ColumnDeclaration) — just a holder the visitor rewrites.
export class ColumnAssignment {
    constructor(
        public readonly column: string,
        public readonly expression: Expression,
    ) { }

    toString(): string {
        return `${this.column} = ${this.expression}`;
    }
}

export class DeleteExpression extends CommandExpression {
    constructor(
        public readonly table: Table,
        public readonly source: SourceWithAliasExpression,
        public readonly where: Expression | undefined,
        public readonly returnRowCount: boolean,
        // When set (SQL Server, trivial WHERE), the DELETE targets this alias
        // directly instead of the table name (CommandSimplifier).
        public readonly alias: Alias | undefined,
    ) {
        super("Delete");
    }

    get name() { return this.table.name; }

    toString(): string {
        return `DELETE ${this.name}\nFROM ${this.source}\nWHERE ${this.where}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return asDbVisitor(visitor).visitDelete(this);
    }
}

export class UpdateExpression extends CommandExpression {
    constructor(
        public readonly table: Table,
        public readonly source: SourceWithAliasExpression,
        public readonly where: Expression | undefined,
        public readonly assignments: readonly ColumnAssignment[],
        public readonly returnRowCount: boolean,
    ) {
        super("Update");
    }

    get name() { return this.table.name; }

    toString(): string {
        return `UPDATE ${this.name} SET\n${this.assignments.join(",\n")}\nFROM ${this.source}\nWHERE ${this.where}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return asDbVisitor(visitor).visitUpdate(this);
    }
}

export class InsertSelectExpression extends CommandExpression {
    constructor(
        public readonly table: Table,
        public readonly source: SourceWithAliasExpression,
        public readonly assignments: readonly ColumnAssignment[],
        public readonly returnRowCount: boolean,
    ) {
        super("InsertSelect");
    }

    get name() { return this.table.name; }

    toString(): string {
        return `INSERT INTO ${this.name}(${this.assignments.map(a => a.column).join(", ")})\nSELECT ${this.assignments.map(a => a.expression).join(", ")}\nFROM ${this.source}`;
    }

    accept(visitor: ExpressionVisitor): Expression {
        return asDbVisitor(visitor).visitInsertSelect(this);
    }
}

export class CommandAggregateExpression extends CommandExpression {
    constructor(
        public readonly commands: readonly CommandExpression[],
    ) {
        super("CommandAggregate");
    }

    toString(): string {
        return this.commands.join(";\n");
    }

    accept(visitor: ExpressionVisitor): Expression {
        return asDbVisitor(visitor).visitCommandAggregate(this);
    }
}
