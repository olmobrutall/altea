import {
    Expression, ConstantExpression, ConditionalExpression, BinaryExpression,
} from "../expressions";
import {
    EntityExpression, EmbeddedEntityExpression, ImplementedByExpression,
    ImplementedByAllExpression, TypeImplementedByAllExpression, LiteReferenceExpression,
    PrimaryKeyExpression, FieldBinding, SqlConstantExpression,
    CaseExpression, When, IsNotNullExpression,
} from "../expressions.sql";
import { LiteralType, Type } from "../../../entities/runtimeTypes";
import { TypeLogic } from "../../typeLogic";
import { getTypeInfo } from "../../../entities/reflection";
import { Entity } from "../../../entities/entity";

// The altea PrimaryKeyType of an entity ctor's id, from its @primaryKey (default 'int') —
// picks which @implementedByAll id column an assigned value populates.
function pkTypeOfCtor(ctor: Function | undefined): string {
    return (ctor != null ? getTypeInfo(ctor)?.fields["id"]?.columnOptions?.primaryKey as string | undefined : undefined) ?? "int";
}

// The per-PK-type id expression of an IBA (NULL when that type isn't present).
function idOr(iba: ImplementedByAllExpression, pk: string): Expression {
    return iba.ids.get(pk) ?? new SqlConstantExpression(null, LiteralType.null);
}

function isNullConst(e: Expression): boolean {
    return (e instanceof SqlConstantExpression || e instanceof ConstantExpression) && e.value == null;
}

// Combine two leaf-column expressions with `op` (a CASE/COALESCE), but if BOTH are null, keep a
// single null — `CASE WHEN … THEN NULL ELSE NULL` (or `COALESCE(NULL, NULL)`) types as text and
// clashes with the (typed) target column on assignment, whereas a bare NULL is coerced to the
// column's type. Used for IB/IBA implementation ids and embedded field bindings alike.
function combineId(a: Expression, b: Expression, op: (a: Expression, b: Expression) => Expression): Expression {
    return isNullConst(a) && isNullConst(b) ? a : op(a, b);
}
import { Lite } from "../../../entities/lite";
import { DbExpressionVisitor } from "./DbExpressionVisitor";

// Port of Signum's AssignAdapterExpander (nested in QueryBinder.cs). Rewrites an
// update/insert VALUE expression into the SHAPE of its target column expression so
// `Assign` can pair leaf columns: a captured constant entity/lite/embedded becomes
// the matching Entity/Lite/Embedded expression with constant id/sub-columns; a
// `?:` / `??` distributes the column extraction into its branches; an entity value
// assigned to an IB/IBA column fans out across the implementation/type columns.
export class AssignAdapterExpander extends DbExpressionVisitor {
    constructor(private colExpression: Expression) {
        super();
    }

    static adapt(exp: Expression, colExpression: Expression): Expression {
        return new AssignAdapterExpander(colExpression).visit(exp);
    }

    private withCol<T>(col: Expression, action: () => T): T {
        const old = this.colExpression;
        this.colExpression = col;
        try { return action(); }
        finally { this.colExpression = old; }
    }

    override visitConditional(c: ConditionalExpression): Expression {
        const ifTrue = this.visit(c.whenTrue);
        const ifFalse = this.visit(c.whenFalse);

        if (this.colExpression instanceof LiteReferenceExpression) {
            const col = this.colExpression;
            const entity = this.withCol(col.reference, () =>
                this.combineConditional(c.condition, asLite(ifTrue).reference, asLite(ifFalse).reference));
            return entity == null ? c : new LiteReferenceExpression(col.type, entity as any, undefined);
        }
        return this.combineConditional(c.condition, ifTrue, ifFalse) ?? c;
    }

    override visitBinary(b: BinaryExpression): Expression {
        if (b.kind !== "??")
            return b;
        const left = this.visit(b.left);
        const right = this.visit(b.right);

        if (this.colExpression instanceof LiteReferenceExpression) {
            const col = this.colExpression;
            const entity = this.withCol(col.reference, () =>
                this.combineCoalesce(asLite(left).reference, asLite(right).reference));
            return entity == null ? b : new LiteReferenceExpression(col.type, entity as any, undefined);
        }
        return this.combineCoalesce(left, right) ?? b;
    }

    private combineConditional(test: Expression, t: Expression, f: Expression): Expression | undefined {
        const col = this.colExpression;
        if (col instanceof EntityExpression && t instanceof EntityExpression && f instanceof EntityExpression)
            return new EntityExpression(col.type, col.table,
                new PrimaryKeyExpression(new ConditionalExpression(test, t.externalId.value, f.externalId.value)),
                undefined, undefined, undefined, false);

        if (col instanceof ImplementedByExpression && t instanceof ImplementedByExpression && f instanceof ImplementedByExpression) {
            const impls = new Map<Function, EntityExpression>();
            for (const [ctor, ee] of col.implementations) {
                // For an implementation absent from BOTH branches, both ids are NULL — keep a
                // single (typeless) NULL instead of `CASE WHEN … THEN NULL ELSE NULL`, which
                // types as text and clashes with the integer id column (combineId, as for IBA).
                const id = combineId(t.implementations.get(ctor)!.externalId.value, f.implementations.get(ctor)!.externalId.value,
                    (a, b) => new ConditionalExpression(test, a, b));
                impls.set(ctor, new EntityExpression(ee.type, ee.table, new PrimaryKeyExpression(id),
                    undefined, undefined, undefined, false));
            }
            return new ImplementedByExpression(col.type, col.strategy, impls);
        }

        if (col instanceof ImplementedByAllExpression && t instanceof ImplementedByAllExpression && f instanceof ImplementedByAllExpression) {
            const ids = new Map<string, Expression>();
            for (const pk of col.ids.keys())
                ids.set(pk, combineId(idOr(t, pk), idOr(f, pk), (a, b) => new ConditionalExpression(test, a, b)));
            return new ImplementedByAllExpression(col.type, ids,
                new TypeImplementedByAllExpression(new ConditionalExpression(test, t.typeId.typeColumn, f.typeId.typeColumn)));
        }

        if (col instanceof EmbeddedEntityExpression && t instanceof EmbeddedEntityExpression && f instanceof EmbeddedEntityExpression)
            return new EmbeddedEntityExpression(col.type,
                new ConditionalExpression(test, t.hasValue, f.hasValue),
                col.bindings.map(b => new FieldBinding(b.fieldInfo,
                    // A binding null in BOTH branches collapses to a single NULL (combineId), so
                    // the CASE doesn't type as text and clash with the (typed) column.
                    this.withCol(b.binding, () => combineId(bindingOf(t, b), bindingOf(f, b), (x, y) => new ConditionalExpression(test, x, y))))),
                undefined);

        return undefined;
    }

    private combineCoalesce(left: Expression, right: Expression): Expression | undefined {
        const col = this.colExpression;
        if (col instanceof EntityExpression && left instanceof EntityExpression && right instanceof EntityExpression)
            return new EntityExpression(col.type, col.table,
                new PrimaryKeyExpression(new BinaryExpression("??", left.externalId.value, right.externalId.value)),
                undefined, undefined, undefined, false);

        if (col instanceof ImplementedByAllExpression && left instanceof ImplementedByAllExpression && right instanceof ImplementedByAllExpression) {
            const ids = new Map<string, Expression>();
            for (const pk of col.ids.keys())
                ids.set(pk, combineId(idOr(left, pk), idOr(right, pk), (a, b) => new BinaryExpression("??", a, b)));
            return new ImplementedByAllExpression(col.type, ids,
                new TypeImplementedByAllExpression(new BinaryExpression("??", left.typeId.typeColumn, right.typeId.typeColumn)));
        }

        if (col instanceof EmbeddedEntityExpression && left instanceof EmbeddedEntityExpression && right instanceof EmbeddedEntityExpression)
            return new EmbeddedEntityExpression(col.type,
                new BinaryExpression("||", left.hasValue, right.hasValue),
                col.bindings.map(b => new FieldBinding(b.fieldInfo,
                    this.withCol(b.binding, () => new BinaryExpression("??", bindingOf(left, b), bindingOf(right, b))))),
                undefined);

        return undefined;
    }

    override visitEntity(ee: EntityExpression): Expression {
        const col = this.colExpression;
        const ctor = ctorOf(ee.type);
        if (col instanceof ImplementedByAllExpression)
            return this.entityToIba(col.type, ee.externalId.value, ctor);
        if (col instanceof ImplementedByExpression)
            return this.fanOutIb(col, ctor, t => t === ctor ? ee : nullEntity(t));
        return ee;
    }

    // A source reference/embedded VALUE of the same shape as the target column is
    // already aligned — return it as-is. Overriding these stops the base visitor from
    // recursing into the implementations/bindings (which would wrongly re-trigger
    // visitEntity with the outer column as context and fan each child back out).
    override visitImplementedBy(ib: ImplementedByExpression): Expression {
        if (this.colExpression instanceof ImplementedByAllExpression)
            return this.ibToIba(this.colExpression, ib);
        return ib;
    }

    override visitImplementedByAll(iba: ImplementedByAllExpression): Expression {
        return iba;
    }

    override visitEmbeddedEntity(eee: EmbeddedEntityExpression): Expression {
        return eee;
    }

    private ibToIba(col: ImplementedByAllExpression, ib: ImplementedByExpression): ImplementedByAllExpression {
        // Coalesce the (mutually-exclusive) implementation ids into the single IBA id;
        // the type discriminator is a CASE over which implementation is non-null.
        const idVals = [...ib.implementations.values()].map(ee => ee.externalId.value);
        const id = idVals.reduce((a, b) => new BinaryExpression("??", a, b));
        const whens = [...ib.implementations].map(([ctor, ee]) =>
            new When(new IsNotNullExpression(ee.externalId.value), new SqlConstantExpression(TypeLogic.typeToId(ctor), LiteralType.number)));
        // The combined implementation ids share the target's id-column type (impls are
        // typed entities); key the value under that column so Assign routes it correctly.
        const pk = pkTypeOfCtor([...ib.implementations.keys()][0]);
        return new ImplementedByAllExpression(col.type, new Map([[pk, id]]),
            new TypeImplementedByAllExpression(new CaseExpression(whens, undefined)));
    }

    override visitConstant(c: ConstantExpression): Expression {
        const col = this.colExpression;
        if (col instanceof EntityExpression || col instanceof ImplementedByExpression || col instanceof ImplementedByAllExpression) {
            const ent = c.value as Entity | null | undefined;
            const id = idObject(ent);
            return this.entityConstant(id, ent?.constructor);
        }
        if (col instanceof EmbeddedEntityExpression)
            return this.embeddedFromConstant(c, col);
        if (col instanceof LiteReferenceExpression) {
            const lite = c.value as Lite<Entity> | null | undefined;
            return this.withCol(col.reference, () => {
                const entity = this.entityConstant(lite?.id ?? null, lite?.entityType as unknown as Function | undefined);
                return new LiteReferenceExpression(col.type, entity as any, undefined);
            });
        }
        return c;
    }

    // A captured-constant entity/lite id → the shaped value matching the target column.
    private entityConstant(id: unknown, type: Function | undefined): Expression {
        const col = this.colExpression;
        const idExpr = new SqlConstantExpression(id ?? null, LiteralType.number);

        if (col instanceof EntityExpression)
            return new EntityExpression(col.type, col.table, new PrimaryKeyExpression(idExpr),
                undefined, undefined, undefined, false);

        if (col instanceof ImplementedByAllExpression)
            return this.entityToIba(col.type, idExpr, type);

        if (col instanceof ImplementedByExpression)
            return this.fanOutIb(col, type,
                t => new EntityExpression(t as any, undefined as any, new PrimaryKeyExpression(t === type ? idExpr : nullConst()), undefined, undefined, undefined, false));

        throw new Error("colExpression is not an entity");
    }

    private fanOutIb(col: ImplementedByExpression, type: Function | undefined, make: (ctor: Function) => EntityExpression): ImplementedByExpression {
        const impls = new Map<Function, EntityExpression>();
        for (const [ctor, ee] of col.implementations)
            impls.set(ctor, ctor === type ? make(ctor) : new EntityExpression(ee.type, ee.table, new PrimaryKeyExpression(nullConst()), undefined, undefined, undefined, false));
        return new ImplementedByExpression(col.type, col.strategy, impls);
    }

    private entityToIba(type: Type, idExpr: Expression, ctor: Function | undefined): ImplementedByAllExpression {
        const typeId = ctor != null ? TypeLogic.typeToId(ctor) : null;
        // The constant's id populates only the column matching its PK type.
        return new ImplementedByAllExpression(type, new Map([[pkTypeOfCtor(ctor), idExpr]]),
            new TypeImplementedByAllExpression(new SqlConstantExpression(typeId, LiteralType.number)));
    }

    private embeddedFromConstant(c: ConstantExpression, col: EmbeddedEntityExpression): EmbeddedEntityExpression {
        const value = c.value as Record<string, unknown> | null | undefined;
        const bindings = col.bindings.map(b => {
            const sub = value == null ? null : (value[b.fieldInfo.name] ?? null);
            return new FieldBinding(b.fieldInfo,
                this.withCol(b.binding, () => this.visit(new ConstantExpression(sub))));
        });
        return new EmbeddedEntityExpression(col.type, new SqlConstantExpression(value != null, LiteralType.boolean), bindings, undefined);
    }
}

function asLite(e: Expression): LiteReferenceExpression {
    if (e instanceof LiteReferenceExpression) return e;
    throw new Error("Expected a LiteReferenceExpression branch in conditional/coalesce adaptation, got: " + e.toString());
}

function bindingOf(eee: EmbeddedEntityExpression, b: FieldBinding): Expression {
    const found = eee.bindings.find(x => x.fieldInfo === b.fieldInfo || x.fieldInfo.name === b.fieldInfo.name);
    if (found == null) throw new Error("Missing embedded binding for " + b.fieldInfo.name);
    return found.binding;
}

function idObject(ent: Entity | null | undefined): unknown {
    if (ent == null) return null;
    if (ent.id == null)
        throw new Error(`The entity ${ent.constructor.name} is new and has no Id`);
    return ent.id;
}

function ctorOf(type: Type): Function {
    return (type as { constructorFunction?: Function }).constructorFunction ?? (type as unknown as Function);
}

function nullConst(): SqlConstantExpression {
    return new SqlConstantExpression(null, LiteralType.number);
}

function nullEntity(ctor: Function): EntityExpression {
    return new EntityExpression(ctor as any, undefined as any, new PrimaryKeyExpression(nullConst()), undefined, undefined, undefined, false);
}
