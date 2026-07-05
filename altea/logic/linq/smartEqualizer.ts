import { Expression, BinaryExpression, ConstantExpression, UnaryExpression } from "./expressions";
import {
    EntityExpression, ImplementedByExpression, ImplementedByAllExpression,
    LiteReferenceExpression, LiteReferenceTarget, PrimaryKeyExpression,
    IsNullExpression, EmbeddedEntityExpression,
    TypeEntityExpression, TypeImplementedByExpression, TypeImplementedByAllExpression,
} from "./expressions.sql";
import { ClassType } from "../../entities/types";
import { Entity } from "../../entities/entity";
import { Lite } from "../../entities/lite";
import { getTypeInfo } from "../../entities/reflection";
import { TypeLogic } from "../typeLogic";

// The @implementedByAll id column matching a known target ctor's PK type (NULL if absent):
// comparisons against a typed value resolve to the one column that can hold its id.
function ibaIdOf(iba: ImplementedByAllExpression, ctor: Function): Expression {
    const pk = (getTypeInfo(ctor)?.fields["id"]?.columnOptions?.primaryKey as string | undefined) ?? "int";
    return iba.ids.get(pk) ?? new ConstantExpression(null);
}

// Port of Signum's SmartEqualizer (Engine/Linq/ExpressionVisitor/SmartEqualizer.cs),
// scoped to what altea models. SQL has no notion of "entity equality": a reference
// equality must be lowered to a comparison of the underlying id column(s) — and for
// polymorphic references (@implementedBy / @implementedByAll) of an id *and* a type,
// possibly spread across several implementation columns. This replaces the binder's
// old single-column `idOf` stopgap.
//
// Differences vs Signum: altea has no PrimaryKey wrapper struct, no Guid comparer,
// no MList element / external (temporal) period, no nullable-bool three-valued
// logic. The @implementedByAll discriminator is the target's TypeEntity int id
// (TypeLogic.typeToId), so type equality compares the type column against that id.
export class SmartEqualizer {
    static readonly True = new ConstantExpression(true);
    static readonly False = new ConstantExpression(false);

    // ---- entry points -----------------------------------------------------

    // `a == b` / `a.is(b)` between (possibly polymorphic) references. Either side
    // may be a bound EntityExpression/IB/IBA/Lite, a captured constant Entity/Lite,
    // or a null literal.
    static polymorphicEqual(e1: Expression, e2: Expression): Expression {
        const c1 = constRef(e1);
        const c2 = constRef(e2);

        const n1 = this.unwrapLite(e1);
        const n2 = this.unwrapLite(e2);

        // A bound reference compared against a captured constant / null.
        if (isReferenceNode(n1) && c2 != null)
            return this.nodeVsConst(n1, c2);
        if (isReferenceNode(n2) && c1 != null)
            return this.nodeVsConst(n2, c1);

        // Two bound references.
        if (isReferenceNode(n1) && isReferenceNode(n2))
            return this.entityEquals(n1, n2);

        // A (nullable) embedded compared to null → test its HasValue column: an embedded is
        // "null" exactly when it has no value (Signum's SmartEqualizer embedded handling). A
        // non-nullable embedded has a constant-true HasValue, so this folds to False.
        if (n1 instanceof EmbeddedEntityExpression && isNullConstant(e2))
            return this.equalNullable(n1.hasValue, this.False);
        if (n2 instanceof EmbeddedEntityExpression && isNullConstant(e1))
            return this.equalNullable(n2.hasValue, this.False);

        // Neither is an entity reference — a plain value comparison.
        return this.equalNullable(e1, e2);
    }

    // `capturedList.contains(reference)` — Signum's EntityIn. A reference can't be
    // compared column-wise, so membership in a captured collection of entities/lites
    // is an OR of id (+ type) comparisons against each captured element. Empty → False.
    static entityIn(item: Expression, values: readonly unknown[]): Expression {
        return this.orAll(values.map(v => this.polymorphicEqual(item, new ConstantExpression(v))));
    }

    // `x instanceof Ctor` (C#'s `x is Ctor`). True when the reference points at a
    // row of that concrete type: for a typed reference, the static type must match;
    // for IB, the matching implementation column must be non-null; for IBA, the type
    // discriminator must equal the target's TypeEntity id.
    static entityIsInstance(expr: Expression, ctor: Function): Expression {
        const node = this.unwrapLite(expr);

        if (node instanceof EntityExpression)
            return sameCtor(node.type, ctor) ? this.notEqualToNull(node.externalId) : this.False;

        if (node instanceof ImplementedByExpression) {
            const impl = node.implementations.get(ctor);
            return impl != null ? this.notEqualToNull(impl.externalId) : this.False;
        }

        if (node instanceof ImplementedByAllExpression)
            return this.equalNullable(node.typeId.typeColumn, typeConstant(ctor));

        throw new Error("instanceof is not defined for " + node.toString());
    }

    // `f.GetType() == typeof(X)` — type equality. A Type expression (Signum's
    // TypeEntity / TypeImplementedBy / TypeImplementedByAll) compared against a
    // captured ctor constant (`typeof X`), a null, or another Type expression.
    // Lowers to id-not-null guards (typed/IB) or a discriminator-string comparison
    // (IBA), following Signum's TypeEquals dispatch.
    static typeEqual(e1: Expression, e2: Expression): Expression {
        const c1 = typeConstOf(e1);
        const c2 = typeConstOf(e2);

        if (e1 instanceof TypeEntityExpression) {
            if (c2 != null) return this.typeConstEntity(c2, e1);
            if (e2 instanceof TypeEntityExpression) return this.typeEntityEntity(e1, e2);
            if (e2 instanceof TypeImplementedByExpression) return this.typeEntityIb(e1, e2);
            if (e2 instanceof TypeImplementedByAllExpression) return this.typeEntityIba(e1, e2);
        } else if (e1 instanceof TypeImplementedByExpression) {
            if (c2 != null) return this.typeConstIb(c2, e1);
            if (e2 instanceof TypeEntityExpression) return this.typeEntityIb(e2, e1);
            if (e2 instanceof TypeImplementedByExpression) return this.typeIbIb(e1, e2);
            if (e2 instanceof TypeImplementedByAllExpression) return this.typeIbIba(e1, e2);
        } else if (e1 instanceof TypeImplementedByAllExpression) {
            if (c2 != null) return this.typeConstIba(c2, e1);
            if (e2 instanceof TypeEntityExpression) return this.typeEntityIba(e2, e1);
            if (e2 instanceof TypeImplementedByExpression) return this.typeIbIba(e2, e1);
            if (e2 instanceof TypeImplementedByAllExpression) return this.typeIbaIba(e1, e2);
        } else if (c1 != null) {
            if (e2 instanceof TypeEntityExpression) return this.typeConstEntity(c1, e2);
            if (e2 instanceof TypeImplementedByExpression) return this.typeConstIb(c1, e2);
            if (e2 instanceof TypeImplementedByAllExpression) return this.typeConstIba(c1, e2);
        }
        throw new Error(`Impossible to resolve type-equality between '${e1}' and '${e2}'`);
    }

    // ---- type vs ctor constant --------------------------------------------

    private static typeConstEntity(c: TypeConst, te: TypeEntityExpression): Expression {
        if (c.isNull) return this.equalsToNull(te.externalId);
        return sameCtor(te.typeValue, c.ctor!) ? this.notEqualToNull(te.externalId) : this.False;
    }

    private static typeConstIb(c: TypeConst, tib: TypeImplementedByExpression): Expression {
        if (c.isNull)
            return this.andAll([...tib.typeImplementations.values()].map(id => this.equalsToNull(id)));
        const id = tib.typeImplementations.get(c.ctor!);
        return id != null ? this.notEqualToNull(id) : this.False;
    }

    private static typeConstIba(c: TypeConst, tiba: TypeImplementedByAllExpression): Expression {
        if (c.isNull) return this.eqNull(tiba.typeColumn);
        return this.equalNullable(typeConstant(c.ctor!), tiba.typeColumn);
    }

    // ---- type vs type -----------------------------------------------------

    private static typeEntityEntity(te1: TypeEntityExpression, te2: TypeEntityExpression): Expression {
        if (!sameCtor(te1.typeValue, ctorOf(te2.typeValue))) return this.False;
        return this.and(this.notEqualToNull(te1.externalId), this.notEqualToNull(te2.externalId));
    }

    private static typeEntityIb(te: TypeEntityExpression, tib: TypeImplementedByExpression): Expression {
        const id = tib.typeImplementations.get(ctorOf(te.typeValue));
        return id != null ? this.and(this.notEqualToNull(te.externalId), this.notEqualToNull(id)) : this.False;
    }

    private static typeEntityIba(te: TypeEntityExpression, tiba: TypeImplementedByAllExpression): Expression {
        return this.and(this.notEqualToNull(te.externalId), this.equalNullable(tiba.typeColumn, typeConstant(ctorOf(te.typeValue))));
    }

    private static typeIbIb(tib1: TypeImplementedByExpression, tib2: TypeImplementedByExpression): Expression {
        const terms: Expression[] = [];
        for (const [ctor, id1] of tib1.typeImplementations) {
            const id2 = tib2.typeImplementations.get(ctor);
            if (id2 != null) terms.push(this.and(this.notEqualToNull(id1), this.notEqualToNull(id2)));
        }
        return this.orAll(terms);
    }

    private static typeIbIba(tib: TypeImplementedByExpression, tiba: TypeImplementedByAllExpression): Expression {
        return this.orAll([...tib.typeImplementations].map(([ctor, id]) =>
            this.and(this.notEqualToNull(id), this.equalNullable(tiba.typeColumn, typeConstant(ctor)))));
    }

    private static typeIbaIba(tiba1: TypeImplementedByAllExpression, tiba2: TypeImplementedByAllExpression): Expression {
        return this.equalNullable(tiba1.typeColumn, tiba2.typeColumn);
    }

    // ---- node vs constant -------------------------------------------------

    private static nodeVsConst(node: LiteReferenceTarget, c: ConstRef): Expression {
        if (c.isNull)
            return this.equalsNull(node);

        if (node instanceof EntityExpression)
            return sameCtor(node.type, c.ctor!) ? this.equalNullable(node.externalId.value, idConstant(c)) : this.False;

        if (node instanceof ImplementedByExpression) {
            const impl = node.implementations.get(c.ctor!);
            return impl != null ? this.equalNullable(impl.externalId.value, idConstant(c)) : this.False;
        }

        // ImplementedByAll: compare the id column matching the constant's PK type.
        return this.and(
            this.equalNullable(ibaIdOf(node, c.ctor!), idConstant(c)),
            this.equalNullable(node.typeId.typeColumn, typeConstant(c.ctor!)));
    }

    // ---- node vs node (Signum's EntityEquals dispatch) --------------------

    private static entityEquals(e1: LiteReferenceTarget, e2: LiteReferenceTarget): Expression {
        if (e1 instanceof EntityExpression) {
            if (e2 instanceof EntityExpression) return this.entityEntityEquals(e1, e2);
            if (e2 instanceof ImplementedByExpression) return this.entityIbEquals(e1, e2);
            return this.entityIbaEquals(e1, e2);
        }
        if (e1 instanceof ImplementedByExpression) {
            if (e2 instanceof EntityExpression) return this.entityIbEquals(e2, e1);
            if (e2 instanceof ImplementedByExpression) return this.ibIbEquals(e1, e2);
            return this.ibIbaEquals(e1, e2);
        }
        // e1 ImplementedByAll
        if (e2 instanceof EntityExpression) return this.entityIbaEquals(e2, e1);
        if (e2 instanceof ImplementedByExpression) return this.ibIbaEquals(e2, e1);
        return this.ibaIbaEquals(e1, e2);
    }

    private static entityEntityEquals(e1: EntityExpression, e2: EntityExpression): Expression {
        if (!sameCtor(e1.type, ctorOf(e2.type)))
            return this.False;
        return this.equalNullable(e1.externalId.value, e2.externalId.value);
    }

    private static entityIbEquals(ee: EntityExpression, ib: ImplementedByExpression): Expression {
        const impl = ib.implementations.get(ctorOf(ee.type));
        return impl != null ? this.entityEntityEquals(impl, ee) : this.False;
    }

    private static entityIbaEquals(ee: EntityExpression, iba: ImplementedByAllExpression): Expression {
        return this.and(
            this.equalNullable(ee.externalId.value, ibaIdOf(iba, ctorOf(ee.type))),
            this.equalNullable(typeConstant(ctorOf(ee.type)), iba.typeId.typeColumn));
    }

    private static ibIbEquals(ib1: ImplementedByExpression, ib2: ImplementedByExpression): Expression {
        const terms: Expression[] = [];
        for (const [ctor, impl1] of ib1.implementations) {
            const impl2 = ib2.implementations.get(ctor);
            if (impl2 != null)
                terms.push(this.entityEntityEquals(impl1, impl2));
        }
        return this.orAll(terms);
    }

    private static ibIbaEquals(ib: ImplementedByExpression, iba: ImplementedByAllExpression): Expression {
        const terms: Expression[] = [];
        for (const [ctor, impl] of ib.implementations)
            terms.push(this.and(
                this.equalNullable(iba.typeId.typeColumn, typeConstant(ctor)),
                this.equalNullable(ibaIdOf(iba, ctor), impl.externalId.value)));
        return this.orAll(terms);
    }

    private static ibaIbaEquals(iba1: ImplementedByAllExpression, iba2: ImplementedByAllExpression): Expression {
        // Same type discriminator, and every per-PK-type id column matches.
        const idTerms = [...iba1.ids.keys()].map(pk =>
            this.equalNullable(iba1.ids.get(pk)!, iba2.ids.get(pk) ?? new ConstantExpression(null)));
        return this.and(
            this.equalNullable(iba1.typeId.typeColumn, iba2.typeId.typeColumn),
            this.andAll(idTerms));
    }

    // ---- null comparison --------------------------------------------------

    private static equalsNull(node: LiteReferenceTarget): Expression {
        if (node instanceof EntityExpression)
            return this.equalsToNull(node.externalId);
        if (node instanceof ImplementedByExpression)
            return this.andAll([...node.implementations.values()].map(e => this.equalsToNull(e.externalId)));
        // ImplementedByAll: null when its type discriminator is unset (no target).
        return this.eqNull(node.typeId.typeColumn);
    }

    // ---- primitive builders (Signum's EqualNullable & friends) ------------

    private static equalNullable(e1: Expression, e2: Expression): Expression {
        return new BinaryExpression("==", e1, e2);
    }

    private static equalsToNull(pk: PrimaryKeyExpression): Expression {
        return this.eqNull(pk.value);
    }

    private static notEqualToNull(pk: PrimaryKeyExpression): Expression {
        return new BinaryExpression("!=", pk.value, new ConstantExpression(null));
    }

    private static eqNull(e: Expression): Expression {
        return new BinaryExpression("==", e, new ConstantExpression(null));
    }

    private static unwrapLite(e: Expression): Expression {
        return e instanceof LiteReferenceExpression ? e.reference : e;
    }

    // SmartAnd/SmartOr: fold away the True/False constants (so a single-impl IB or a
    // trivially-true clause doesn't bloat the SQL).
    private static and(e1: Expression, e2: Expression): Expression {
        if (e1 === this.True) return e2;
        if (e2 === this.True) return e1;
        if (e1 === this.False || e2 === this.False) return this.False;
        return new BinaryExpression("&&", e1, e2);
    }

    private static or(e1: Expression, e2: Expression): Expression {
        if (e1 === this.False) return e2;
        if (e2 === this.False) return e1;
        if (e1 === this.True || e2 === this.True) return this.True;
        return new BinaryExpression("||", e1, e2);
    }

    private static andAll(terms: Expression[]): Expression {
        return terms.length === 0 ? this.True : terms.reduce((a, b) => this.and(a, b));
    }

    private static orAll(terms: Expression[]): Expression {
        return terms.length === 0 ? this.False : terms.reduce((a, b) => this.or(a, b));
    }

    static not(e: Expression): Expression {
        if (e === this.True) return this.False;
        if (e === this.False) return this.True;
        return new UnaryExpression("!", e);
    }

    // Null-safe equality used to correlate a group's element subquery to its key
    // (Signum's EqualNullableGroupBy): two key columns match when they are equal
    // OR both null — so NULL keys group together (SQL `=` treats NULL ≠ NULL).
    static equalNullableGroupBy(e1: Expression, e2: Expression): Expression {
        return this.or(
            this.equalNullable(e1, e2),
            this.and(new IsNullExpression(e1), new IsNullExpression(e2)));
    }
}

// ---- helpers --------------------------------------------------------------

function isReferenceNode(e: Expression): e is LiteReferenceTarget {
    return e instanceof EntityExpression || e instanceof ImplementedByExpression || e instanceof ImplementedByAllExpression;
}

// A `null` literal on one side of a comparison (the quoted `== null` operand).
function isNullConstant(e: Expression): boolean {
    return e instanceof ConstantExpression && e.value == null;
}

function ctorOf(type: unknown): Function {
    if (type instanceof ClassType)
        return type.constructorFunction;
    throw new Error("Expected a ClassType for an entity reference");
}

function sameCtor(type: unknown, ctor: Function): boolean {
    return type instanceof ClassType && type.constructorFunction === ctor;
}

// The @implementedByAll type discriminator value for a constructor — the clean
// type name string `save.ts` writes. Compared as a SQL string literal.
// The @implementedByAll type discriminator value for a constructor — the target's
// TypeEntity int id (Signum's TypeToId), compared as a SQL int literal.
function typeConstant(ctor: Function): Expression {
    return new ConstantExpression(TypeLogic.typeToId(ctor));
}

// A captured Entity/Lite (or null) on one side of the comparison.
interface ConstRef {
    readonly ctor: Function | undefined; // undefined when isNull
    readonly id: unknown;
    readonly isNull: boolean;
}

function constRef(e: Expression): ConstRef | null {
    if (!(e instanceof ConstantExpression))
        return null;
    const v = e.value;
    if (v == null)
        return { ctor: undefined, id: null, isNull: true };
    if (v instanceof Lite)
        return { ctor: v.entityType as unknown as Function, id: v.id, isNull: false };
    if (v instanceof Entity)
        return { ctor: v.constructor, id: v.id, isNull: false };
    return null;
}

function idConstant(c: ConstRef): Expression {
    return new ConstantExpression(c.id);
}

// A captured constructor (`typeof X`) or null on one side of a type comparison.
interface TypeConst {
    readonly ctor: Function | undefined; // undefined when isNull
    readonly isNull: boolean;
}

function typeConstOf(e: Expression): TypeConst | null {
    if (!(e instanceof ConstantExpression))
        return null;
    if (e.value == null)
        return { ctor: undefined, isNull: true };
    if (typeof e.value === "function")
        return { ctor: e.value as Function, isNull: false };
    return null;
}
