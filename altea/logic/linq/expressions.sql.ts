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
// TypeImplementedByAllExpression). Interim altea model: `typeColumn` is a string
// column holding the clean type name (e.g. "Band"), not yet an int FK to a
// TypeEntity table. SmartEqualizer compares it against `cleanTypeName(ctor)`.
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
    constructor(
        type: Type,
        public readonly id: Expression,
        public readonly typeId: TypeImplementedByAllExpression,
    ) {
        super("ImplementedByAll", type);
    }

    toString(): string {
        return `ImplementedByAll{ Id = ${this.id}, Type = ${this.typeId} }`;
    }

    accept(visitor: ExpressionVisitor) {
        return asDbVisitor(visitor).visitImplementedByAll(this);
    }
}
