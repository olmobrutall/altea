
import { Lite, LiteImp, getLiteModelConstructor } from './lite';
import { entity, EntityData, ignore, quoted } from './decorators';
import { niceName, newNiceName } from './utils/localization';
import { reflect } from './reflection';
import { enumNameOf } from './registration';
import { isGraphModified, isModifiedSelf } from './changes';
import { LiteralType, LiteType, type Type as ExpressionType } from './types';

export type PrimaryKey = string | number;

// A closed generic entity type carried as data (the open generic class + its type
// arguments), e.g. EnumEntity.typeFor(Sex) → { genericType: EnumEntity,
// genericArguments: [Sex] }. TypeScript erases generics at runtime, so this is how
// a parameterised entity type (EnumEntity<Sex>) flows through reflection / schema
// building instead of fabricating a class per instantiation.
export interface GenericType<T extends BaseEntity = BaseEntity> {
    readonly genericType: Function;          // the open generic class, e.g. EnumEntity
    readonly genericArguments: readonly unknown[];
    readonly __closed?: T;                   // phantom: ties the descriptor to T
}

// A reference to an entity type: either a constructor or a closed generic type.
export type Type<T extends BaseEntity> = (new () => T) | GenericType<T>;

export function isGenericType(type: unknown): type is GenericType {
    return typeof type === 'object' && type !== null && 'genericType' in type;
}

// The underlying constructor of a type reference (the open generic class for a
// GenericType; the constructor itself otherwise). Used to read reflection metadata.
export function typeConstructor(type: Type<BaseEntity>): Function {
    return isGenericType(type) ? type.genericType : type;
}

// A human-readable type name: a closed generic renders as "EnumEntity<Sex>"
// (each argument named via its class name or registered enum name); a plain
// constructor renders as its class name.
export function typeName(type: Type<BaseEntity>): string {
    if (!isGenericType(type))
        return (type as { name: string }).name;
    const args = type.genericArguments.map(genericArgumentName).join(', ');
    return `${(type.genericType as { name: string }).name}<${args}>`;
}

function genericArgumentName(arg: unknown): string {
    if (typeof arg === 'function')
        return (arg as { name: string }).name;
    if (typeof arg === 'object' && arg !== null)
        return enumNameOf(arg) ?? '?';
    return String(arg);
}

export type InitValues<T> = Partial<{
    [K in keyof T as T[K] extends Function ? never : K]: T[K]
}>;

export type EntitySnapshot = Record<string, unknown>;

export abstract class BaseEntity {
    // The clean baseline used for snapshot-based change tracking: the normalized
    // row image taken on load / after save. `undefined` means "never persisted"
    // (a freshly created instance), which counts as modified. Maintained by
    // ./changes (cleanModified); @ignore so it is never treated as a column.
    @ignore _snapshot?: EntitySnapshot;

    mixin<M extends BaseEntity>(mixinClass: Type<M>): M {
        return this as unknown as M;
    }

    /**
     * True if this modifiable — or anything in its object graph — has changed
     * since its snapshot baseline (Signum's graph-`Modified` / `HasChanges`).
     * Computed by diffing live values against {@link _snapshot}; no setter or
     * Proxy bookkeeping is involved.
     */
    isDirty(): boolean {
        return isGraphModified(this);
    }

    /** True if *this* modifiable's own fields differ from its snapshot (Signum's `SelfModified`). */
    isModifiedSelf(): boolean {
        return isModifiedSelf(this);
    }

    // Factory: `Order.create({ amount: 42 })` instead of `new Order().init(...)`.
    // The explicit `this` parameter binds to the concrete subclass constructor,
    // so the result is typed as that subclass (and abstract bases can't call it).
    // `InitValues` excludes method-typed properties from the accepted shape.
    static create<T extends BaseEntity>(this: new () => T, values: InitValues<T>): T {
        const instance = new this();
        Object.assign(instance, values);
        return instance;
    }

    static createMany<T extends BaseEntity>(this: new () => T, valuesArray: InitValues<T>[]): T[] {
        return valuesArray.map(values => (this as any).create(values) as T);
    }
}

@reflect
@entity()
export abstract class Entity extends BaseEntity {
    id: PrimaryKey;
    @ignore isNew: boolean;
    ticks: number;

    /**
     * Builds a {@link Lite} pointing to this entity. Uses the
     * {@link registerLiteModelConstructor | registered} constructor for this
     * entity type to attach model data, falling back to a plain {@link LiteImp}.
     *
     * @param fat when `true` (a.k.a. `toLiteFat()`), embeds the full entity so
     * `lite.entity` / `lite.entityOrNull` resolve without a round-trip. Needed
     * for new (unsaved) entities and for LINQ navigation through the lite.
     */
    toLite(fat?: boolean): Lite<this>;
    toLite(model: string): Lite<this>;
    toLite(fat: boolean | string = false): Lite<this> {
        if (!fat && this.id == null)
            throw new Error('toLite() is not allowed for new entities (no id yet), use toLiteFat() instead');

        const type = this.constructor as Type<this>;
        const constructor = getLiteModelConstructor(type);
        const lite = constructor != null
            ? constructor(this)
            : new LiteImp<this>(this.id, type, this.toString());

        if (fat)
            lite.setEntity(this);

        return lite;
    }

    /**
     * Null-safe identity comparison against another entity or a lite of the same
     * type (mirrors Signum's `Entity.Is` / `Lite.Is`). New entities (no id) are
     * compared by reference. In a quoted query the binder lowers `.is(...)` to an
     * id comparison (SmartEqualizer); this body is the in-memory fallback.
     */
    is(other: Entity | Lite<Entity> | null | undefined): boolean {
        if (other == null)
            return false;

        const otherType = other instanceof Entity ? (other.constructor as Type<Entity>) : other.entityType;
        if ((this.constructor as Type<Entity>) !== otherType)
            return false;

        if (this.id != null || other.id != null)
            return this.id === other.id;

        const otherEntity = other instanceof Entity ? other : other.entityOrNull;
        return (this as Entity) === otherEntity;
    }

    /**
     * Default display string (Signum's `Entity.ToString()` → `BaseToString()`):
     * a new entity shows its type's "New …" name; a persisted one shows the type's
     * nice name plus its id. It is `@quoted` so a subclass that does NOT override
     * `toString()` inherits a *translatable* default — the query provider expands it
     * inline rather than needing a stored `ToStr` column. A subclass with its own
     * (non-`@quoted`) `toString()` gets a `ToStr` column instead.
     */
    @quoted
    toString(): string {
        return this.isNew ? newNiceName(this.constructor) : niceName(this.constructor) + " " + this.id.toString();
    }
}

// Query-expression metadata for the quote-transformer: lets `.is(...)` and
// `.toLite()` appear inside quoted query lambdas. fromQuoted reads `__resultType`
// off the method to type the call; the QueryBinder then lowers `.is(...)` to an id
// comparison and `.toLite()` to a LiteReference. `is` → boolean; `toLite` → a
// `Lite<this>`.
(Entity.prototype.is as { __resultType?: (t: ExpressionType, ...a: ExpressionType[]) => ExpressionType }).__resultType =
    () => LiteralType.boolean;
(Entity.prototype.toLite as { __resultType?: (t: ExpressionType, ...a: ExpressionType[]) => ExpressionType }).__resultType =
    (ownerType: ExpressionType) => new LiteType(ownerType);

export abstract class EmbeddedEntity extends BaseEntity { }

export abstract class ModelEntity extends BaseEntity { }

// Base for mixin classes (Signum's MixinEntity). A mixin contributes extra
// fields to an owning entity; it is attached with @mixin(() => [TheMixin]) on
// the entity and its fields are folded into the owner's table by the schema
// builder.
export abstract class MixinEntity extends BaseEntity { }
