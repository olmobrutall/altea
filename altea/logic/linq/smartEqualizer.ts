import { Expression, BinaryExpression, ConstantExpression, UnaryExpression } from "./expressions";
import {
    EntityExpression, ImplementedByExpression, ImplementedByAllExpression,
    LiteReferenceExpression, LiteReferenceTarget, PrimaryKeyExpression,
    IsNullExpression,
} from "./expressions.sql";
import { ClassType } from "../../entities/types";
import { Entity } from "../../entities/entity";
import { Lite } from "../../entities/lite";
import { cleanTypeName } from "../../entities/registration";

// Port of Signum's SmartEqualizer (Engine/Linq/ExpressionVisitor/SmartEqualizer.cs),
// scoped to what altea models. SQL has no notion of "entity equality": a reference
// equality must be lowered to a comparison of the underlying id column(s) — and for
// polymorphic references (@implementedBy / @implementedByAll) of an id *and* a type,
// possibly spread across several implementation columns. This replaces the binder's
// old single-column `idOf` stopgap.
//
// Differences vs Signum: altea has no PrimaryKey wrapper struct, no Guid comparer,
// no MList element / external (temporal) period, no nullable-bool three-valued
// logic. The @implementedByAll discriminator is the clean type-name string (e.g.
// "Band"), not yet an int FK to a TypeEntity table, so type equality compares
// against `cleanTypeName(ctor)`.
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
    // discriminator must equal the clean type name.
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

        // ImplementedByAll
        return this.and(
            this.equalNullable(node.id, idConstant(c)),
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
            this.equalNullable(ee.externalId.value, iba.id),
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
                this.equalNullable(iba.id, impl.externalId.value)));
        return this.orAll(terms);
    }

    private static ibaIbaEquals(iba1: ImplementedByAllExpression, iba2: ImplementedByAllExpression): Expression {
        return this.and(
            this.equalNullable(iba1.typeId.typeColumn, iba2.typeId.typeColumn),
            this.equalNullable(iba1.id, iba2.id));
    }

    // ---- null comparison --------------------------------------------------

    private static equalsNull(node: LiteReferenceTarget): Expression {
        if (node instanceof EntityExpression)
            return this.equalsToNull(node.externalId);
        if (node instanceof ImplementedByExpression)
            return this.andAll([...node.implementations.values()].map(e => this.equalsToNull(e.externalId)));
        // ImplementedByAll
        return this.eqNull(node.id);
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
function typeConstant(ctor: Function): Expression {
    return new ConstantExpression(cleanTypeName(ctor));
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
