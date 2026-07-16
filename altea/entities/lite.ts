
import type { Entity, Type, PrimaryKey } from './entity';
import { typeName } from './entity';
import { LiteralType, quotedFunction } from './runtimeTypes';

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

const liteModelConstructors = new Map<Type<Entity>, (entity: Entity) => Lite<Entity>>();

/**
 * Registers the constructor used by `Entity.toLite()` to build the lite (and
 * its model) for a given entity type. Instead of a separate `LiteModel` class
 * (as in Signum), altea subclasses {@link LiteImp} and stores the model fields
 * on the lite itself:
 *
 * ```ts
 * export class EmployeeLite extends LiteImp<EmployeeEntity> {
 *     constructor(id: PrimaryKey, toStr: string,
 *         readonly firstName: string,
 *         readonly lastName: string) {
 *         super(id, EmployeeEntity, toStr);
 *     }
 * }
 *
 * registerLiteModelConstructor(EmployeeEntity, e =>
 *     new EmployeeLite(e.id, e.toString(), e.firstName, e.lastName));
 * ```
 *
 * When no constructor is registered, `Entity.toLite()` falls back to a plain
 * {@link LiteImp} whose model is just the `toString()`.
 */
export function registerLiteModelConstructor<T extends Entity>(
    entityType: Type<T>,
    constructor: (entity: T) => Lite<T>,
): void {
    liteModelConstructors.set(entityType, constructor as unknown as (entity: Entity) => Lite<Entity>);
}

/** Returns the registered constructor for an entity type, if any. */
export function getLiteModelConstructor<T extends Entity>(
    entityType: Type<T>,
): ((entity: T) => Lite<T>) | undefined {
    return liteModelConstructors.get(entityType) as ((entity: T) => Lite<T>) | undefined;
}
