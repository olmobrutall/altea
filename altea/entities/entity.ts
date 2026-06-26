
import { Lite, LiteImp, getLiteModelConstructor } from './lite';
import { entity, EntityData, ignore } from './decorators';
import { reflect } from './reflection';

export type PrimaryKey = string | number;

export type Type<T extends BaseEntity> = new () => T;

export type InitValues<T> = Partial<{
    [K in keyof T as T[K] extends Function ? never : K]: T[K]
}>;

export abstract class BaseEntity {
    mixin<M extends BaseEntity>(mixinClass: Type<M>): M {
        return this as unknown as M;
    }

    // Factory: `Order.create({ amount: 42 })` instead of `new Order().init(...)`.
    // The explicit `this` parameter binds to the concrete subclass constructor,
    // so the result is typed as that subclass (and abstract bases can't call it).
    // `InitValues` excludes method-typed properties from the accepted shape.
    static create<T extends BaseEntity>(this: Type<T>, values: InitValues<T>): T {
        const instance = new this();
        Object.assign(instance, values);
        return instance;
    }

    static createMany<T extends BaseEntity>(this: Type<T>, valuesArray: InitValues<T>[]): T[] {
        return valuesArray.map(values => (this as any).create(values) as T);
    }
}

export type EntitySnapshot = Record<string, unknown>;

@reflect
@entity()
export abstract class Entity extends BaseEntity {
    id: PrimaryKey;
    @ignore isNew: boolean;
    ticks: number;
    _snapshot?: EntitySnapshot;

    /**
     * Builds a {@link Lite} pointing to this entity. Uses the
     * {@link registerLiteModelConstructor | registered} constructor for this
     * entity type to attach model data, falling back to a plain {@link LiteImp}.
     *
     * @param fat when `true` (a.k.a. `toLiteFat()`), embeds the full entity so
     * `lite.entity` / `lite.entityOrNull` resolve without a round-trip. Needed
     * for new (unsaved) entities and for LINQ navigation through the lite.
     */
    toLite(fat: boolean = false): Lite<this> {
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

    isDirty(): boolean {
        if (this._snapshot == null) return this.isNew;
        return false;
    }
}

export abstract class EmbeddedEntity extends BaseEntity { }

export abstract class ModelEntity extends BaseEntity { }

// Base for mixin classes (Signum's MixinEntity). A mixin contributes extra
// fields to an owning entity; it is attached with @mixin(() => [TheMixin]) on
// the entity and its fields are folded into the owner's table by the schema
// builder.
export abstract class MixinEntity extends BaseEntity { }
