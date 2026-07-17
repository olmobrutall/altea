
import type { Entity, Type, PrimaryKey } from './entity';
import { typeName, typeConstructor } from './entity';
import { LiteralType, quotedFunction } from './runtimeTypes';
import type { Quoted } from 'quote-transformer/quoted';

export abstract class Lite<out T extends Entity> {
    abstract readonly id: PrimaryKey;
    abstract readonly entityType: Type<T>;
    abstract toString(): string;

    // Stored loosely (as Entity, not T) so the public accessors below can stay
    // covariant — a writable `T` field would force `Lite<T>` to be invariant and
    // break the `out T` annotation.
    private _entity?: Entity;

    /**
     * The full entity this lite points to, or `undefined` when the lite is not
     * loaded ("thin"/lazy lite, the result of `toLite()`).
     *
     * Populated by `toLiteFat()` / `toLite(true)` — used for new (unsaved)
     * entities and for LINQ queries that navigate through a lite. In the DB a
     * lite navigation is a no-op (the FK is already there), so the translator
     * reads through `entityOrNull` instead of issuing a join.
     */
    get entityOrNull(): T | undefined {
        return this._entity as T | undefined;
    }

    /**
     * The full entity this lite points to. Throws if the lite is not loaded —
     * use `entityOrNull` when absence is expected.
     */
    get entity(): T {
        if (this._entity == null)
            throw new Error(
                `The lite of ${typeName(this.entityType)} (Id ${this.id}) is not loaded. ` +
                `Use entityOrNull, or build it fat with toLiteFat() / toLite(true).`,
            );
        return this._entity as T;
    }

    /**
     * Attaches the full entity, turning a thin lite into a fat one. Internal —
     * callers should use `Entity.toLiteFat()`; accepts `Entity` (not `T`) to
     * keep `Lite<T>` covariant.
     */
    setEntity(entity: Entity): this {
        this._entity = entity;
        return this;
    }

    // Accepts a lite or a full entity of the same type (mirrors Signum's
    // overloaded Lite.Is). In a quoted query the binder lowers this to an id
    // comparison (SmartEqualizer); this body is the in-memory fallback.
    is(other: Lite<Entity> | Entity | null | undefined): boolean {
        if (other == null)
            return false;

        const isEntity = !(other instanceof Lite);
        const otherType = isEntity ? ((other as Entity).constructor as Type<Entity>) : (other as Lite<Entity>).entityType;
        if (this.entityType !== otherType)
            return false;

        // New entities have no id yet, so fat lites of new entities are compared
        // by the embedded entity reference (mirrors Signum's Lite.Is).
        if (this.id != null || other.id != null)
            return this.id === other.id;

        const otherEntity = isEntity ? (other as Entity) : (other as Lite<Entity>).entityOrNull;
        return this.entityOrNull === otherEntity;
    }

    /**
     * Runtime-type test on this lite: `lite.isInstanceOf(AlbumEntity)` — the method form of
     * `AlbumEntity.isLite(lite)` and of the `lite instanceof AlbumEntity` operator. It is a
     * TypeScript type guard (narrows `this` to `Lite<S>`), subtype-inclusive (matches
     * subclasses), and — unlike the raw `instanceof` operator — honest in memory: a lite is
     * never a JS instance of the entity class, so it reads the lite's `entityType` instead.
     * In a quoted query the binder lowers it to a reference type-test (entityIsInstance).
     */
    isInstanceOf<S extends Entity>(ctor: abstract new (...args: any[]) => S): this is Lite<S> {
        return (ctor as unknown as { isLite(lite: Lite<Entity>): boolean }).isLite(this);
    }
}

// Query-expression metadata: a lite value (LiteType) routes method calls in a
// quoted lambda to Lite.prototype, so `lite.is(...)` resolves here. The binder
// lowers it to an id comparison, same as Entity.is. (`lite.entity` is a property,
// typed by resolveMemberType, so it needs no metadata.)
quotedFunction(Lite.prototype.is).__resultType = () => LiteralType.boolean;
// `lite.isInstanceOf(Ctor)` → boolean; the binder lowers it via SmartEqualizer.entityIsInstance.
quotedFunction(Lite.prototype.isInstanceOf).__resultType = () => LiteralType.boolean;

export class LiteImp<T extends Entity> extends Lite<T> {
    constructor(
        readonly id: PrimaryKey,
        readonly entityType: Type<T>,
        readonly toStr: string,
    ) {
        super();
    }

    toString(): string {
        return this.toStr;
    }
}

// A custom lite class: a {@link LiteImp} subclass that carries display/model fields directly on
// the lite instance (altea has no separate "model" entity). Besides being constructible into a
// Lite<T>, it declares two statics so the JSON codec can rebuild it from the wire: isCompatible
// picks it among the type's registered custom lites, fromJson materialises it.
export interface CustomLiteClass {
    isCompatible(json: Record<string, unknown>): boolean;
    fromJson(json: Record<string, unknown>): Lite<Entity>;
}

// One registration: the class (for JSON round-trip via its statics), the from-entity builder
// (for Entity.toLite() and query projection), and whether it is the default builder for the type.
// `fromEntity` is a Quoted lambda: it runs directly for in-memory toLite/toCustomLite, and the
// query provider reads its `__quoted` expression tree to project the model's columns in SQL and
// construct the lite in the reader.
interface CustomLiteRegistration {
    liteClass: CustomLiteClass;
    fromEntity: Quoted<(entity: Entity) => Lite<Entity>>;
    isDefault: boolean;
}

const customLiteRegistry = new Map<Function, CustomLiteRegistration[]>();

/**
 * Registers a custom lite for an entity type. Instead of a separate `LiteModel` class (as in
 * Signum), altea subclasses {@link LiteImp} and stores the model fields on the lite itself; the
 * class also implements {@link CustomLiteClass} (`isCompatible`/`fromJson`) so the JSON codec can
 * rebuild it from the wire.
 *
 * ```ts
 * export class EmployeeLite extends LiteImp<EmployeeEntity> {
 *     constructor(id: PrimaryKey, toStr: string,
 *         readonly firstName: string,
 *         readonly lastName: string) {
 *         super(id, EmployeeEntity, toStr);
 *     }
 *     static isCompatible(json: Record<string, unknown>): boolean {
 *         return typeof json.firstName === "string";
 *     }
 *     static fromJson(json: Record<string, unknown>): Lite<EmployeeEntity> {
 *         return new EmployeeLite(json.id as PrimaryKey, (json.toStr as string) ?? "",
 *             json.firstName as string, json.lastName as string);
 *     }
 * }
 *
 * registerCustomLite(EmployeeEntity, EmployeeLite,
 *     e => new EmployeeLite(e.id, e.toString(), e.firstName, e.lastName), true);
 * ```
 *
 * More than one custom lite may be registered per entity type; the one flagged `isDefault` is
 * the builder {@link Entity.toLite} uses (its `fromEntity` lambda). On read, the JSON codec tries
 * each registered class's `isCompatible` in registration order and uses the first match, falling
 * back to a plain {@link LiteImp} when none matches (or none is registered).
 *
 * `fromEntity` is a {@link Quoted} lambda (the transformer captures its body): it runs verbatim
 * in memory, and the query provider translates its expression — e.g. `new EmployeeLite(e.id,
 * e.toString(), e.firstName, …)` — into projected columns so a query returns the typed custom
 * lite too, not just a plain {@link LiteImp}. Keep the body translatable (columns + `@quoted`
 * navigations), like a `@quoted` toString.
 */

export function registerCustomLite<T extends Entity>(
    entityType: Type<T>,
    liteClass: CustomLiteClass,
    fromEntity: Quoted<(entity: T) => Lite<T>>,
    isDefault = false,
): void {
    const ctor = typeConstructor(entityType);
    const arr = customLiteRegistry.get(ctor) ?? [];
    arr.push({ liteClass, fromEntity: fromEntity as unknown as Quoted<(entity: Entity) => Lite<Entity>>, isDefault });
    customLiteRegistry.set(ctor, arr);
}

/**
 * The from-entity builder {@link Entity.toLite} uses for a type: the `fromEntity` lambda of the
 * registration flagged `isDefault`, or `undefined` when the type has no *default* custom lite
 * (then `toLite()` builds a plain {@link LiteImp}). A non-default custom lite is reached only via
 * {@link Entity.toCustomLite} or a field's `@customLite`, never by plain `toLite()`.
 */
export function getCustomLiteConstructor<T extends Entity>(
    entityType: Type<T>,
): Quoted<(entity: T) => Lite<T>> | undefined {
    const arr = customLiteRegistry.get(typeConstructor(entityType));
    return arr?.find(r => r.isDefault)?.fromEntity as unknown as Quoted<(entity: T) => Lite<T>> | undefined;
}

/** The custom lite classes registered for a ctor, in registration (isCompatible match) order. */
export function getCustomLites(ctor: Function): CustomLiteClass[] {
    return (customLiteRegistry.get(ctor) ?? []).map(r => r.liteClass);
}

/**
 * The from-entity builder registered for a specific (entity type, custom lite class) pair —
 * used by {@link Entity.toCustomLite} to build a *named* custom lite rather than the default one.
 * `undefined` when that class was never registered for the type.
 */
export function getCustomLiteConstructorFor<T extends Entity>(
    entityType: Type<T>,
    liteClass: CustomLiteClass,
): Quoted<(entity: T) => Lite<T>> | undefined {
    const arr = customLiteRegistry.get(typeConstructor(entityType));
    return arr?.find(r => r.liteClass === liteClass)?.fromEntity as unknown as Quoted<(entity: T) => Lite<T>> | undefined;
}
