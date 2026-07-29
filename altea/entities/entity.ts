
import { Lite, LiteImp, getCustomLiteConstructor, getCustomLiteConstructorFor } from './lite';
import type { CustomLiteClass } from './lite';
import { column, serialize, quoted } from './decorators';
import { niceName, nicePluralName } from './utils/localization';
import { reflect, getTypeInfo } from './reflection';
import { MixinDeclarations } from './mixinDeclarations';
import { cleanTypeName, resolveCleanType } from './registration';
import { isGraphModified, isModifiedSelf } from './changes';

export type PrimaryKey = string | number;

// A reference to an entity type: ALWAYS a constructor. Closed generic entity types like
// EnumEntity<Sex> are real constructors too — see EnumEntity.typeFor, which returns a cached
// per-enum subclass carrying its enum as a static `boundEnum`. (Formerly a `(new()=>T) |
// GenericType<T>` union; the GenericType data-descriptor form was removed.)
export type Type<T extends BaseEntity> = abstract new () => T;

// The constructor behind a type reference. Now that Type<T> is always a constructor this is the
// identity — kept as a named accessor during the transition (call sites inline it over time).
export function typeConstructor(type: Type<BaseEntity>): Function {
    return type;
}

// A human-readable type name — the constructor's name (e.g. "OrderEntity", "EnumEntity<Sex>").
export function typeName(type: Type<BaseEntity>): string {
    return (type as { name: string }).name;
}

export type InitValues<T> = Partial<{
    [K in keyof T as T[K] extends Function ? never : K]: T[K]
}>;

export type EntitySnapshot = Record<string, unknown>;

export abstract class BaseEntity {
    // The clean baseline used for snapshot-based change tracking: the normalized
    // row image taken on load / after save. Three states (see ./changes.isModifiedSelf):
    //   - a projection (Record) → diff the live values against it;
    //   - `true`      → known-modified with no baseline: a freshly created entity, or one
    //                   deserialized with `modified: true` and no resolved original;
    //   - `undefined` → known-clean with no baseline: an entity deserialized WITHOUT the
    //                   `modified` flag (the JSON codec's client-receive path).
    // Defaults to `true`, so a freshly constructed entity is modified (needs saving) —
    // exactly as before this sentinel existed. Maintained by ./changes (cleanModified)
    // and the JSON codec (entities/serializer); @column(false) so it is never treated as a column,
    // @serialize(false) so it never rides the wire (it is the baseline, rebuilt on each end).
    @column(false) @serialize(false) _snapshot?: EntitySnapshot | true = true;

    mixin<M extends BaseEntity>(mixinClass: Type<M>): M {
        // altea inlines a mixin's fields onto the owner, so `mixin()` is just a typed cast —
        // but assert the mixin is actually declared on this entity (Signum's MixinDeclarations
        // guard, mirrored by the query binder's `entity.mixin(X)` check). Without it a typo or
        // an undeclared mixin would silently return `this` and read/write phantom fields.
        const declared = MixinDeclarations.getMixins(this.constructor as Type<BaseEntity>);
        if (!declared.some(m => typeConstructor(m) === typeConstructor(mixinClass)))
            throw new Error(`Mixin '${typeName(mixinClass)}' is not declared on '${this.constructor.name}'`);
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
        // Seed the mixin fields with their defaults. altea's `mixin()` returns `this`, so mixin
        // fields live flat on the entity but aren't declared on it — their initializers
        // (e.g. CorruptMixin.corrupt = false) would otherwise never run. Values override.
        applyMixinDefaults(instance, this);
        Object.assign(instance, values);
        return instance;
    }

    static createMany<T extends BaseEntity>(this: new () => T, valuesArray: InitValues<T>[]): T[] {
        return valuesArray.map(values => (this as any).create(values) as T);
    }

    // --- Static "Type<T>-object" API (Signum's Type<T>) ---
    // altea has real entity classes, so a class doubles as Signum's Type descriptor: ported
    // React client code calls OrderEntity.typeName / .niceName() / .nicePluralName() directly
    // instead of holding a separate `new Type("Order")` object. `this` binds to the concrete
    // subclass constructor. (`niceName()` also exists on Function.prototype for query
    // expressions; declared here too as the canonical anchor + the react-layer static hook.)
    // `token()` is deferred until the client QueryToken (QueryTokenString) is ported.
    static get typeName(): string { return cleanTypeName(this); }
    static niceName(this: Function): string { return niceName(this); }
    static nicePluralName(this: Function): string { return nicePluralName(this); }

    // Resolve a clean type name (the $type / URL discriminator) to its Type, checking it inherits
    // from the class this is called on: `Entity.resolveType("Order")` -> Type<OrderEntity> typed as
    // Type<Entity>; `ModelEntity.resolveType(...)` restricts to models; `BaseEntity.resolveType(...)`
    // accepts anything reflected. Throws if unregistered or of the wrong branch.
    static resolveType<T extends BaseEntity>(this: abstract new (...args: any[]) => T, cleanName: string): Type<T> {
        const ctor = resolveCleanType(cleanName);
        if (ctor == null)
            throw new Error(`Type '${cleanName}' is not registered`);
        const base = this as unknown as Function;
        if (ctor !== base && !(ctor.prototype instanceof base))
            throw new Error(`Type '${cleanName}' does not inherit from '${base.name}'`);
        return ctor as unknown as Type<T>;
    }
}

// Base for raw database views (Signum's IView) and, more generally, any reflected class
// that a query projection constructs directly via `create` (e.g. the sync DiffTable /
// DiffColumn model). Like Entity it exposes a static `create(values)` factory; the query
// projector recognises `View.create({ … })` and materialises a real instance per row
// (instead of a plain object literal). No id/ticks/change-tracking — a view/DTO is not a
// persisted entity.
export abstract class View {
    // Runtime factory the query projector calls per row for `Ctor.create({ … })`. Loosely
    // typed (`values: any`) so subclasses can override with their own value shape — e.g.
    // DiffTable.create takes a columns *array* and indexes it. Typed helpers on concrete
    // subclasses (or a plain `new`) give call-site safety where it matters.
    static create(values: any): any {
        return Object.assign(new (this as unknown as new () => View)(), values);
    }
}

// A reference to a view type (Signum's `Type` for an `IView`): a constructor for a {@link View}
// subclass. The view analogue of {@link Type} — used where an API takes a view rather than an
// entity (e.g. Administrator.createTemporaryTable / SqlBuilder.createTableSql over a temp-table
// view). A view has no closed-generic form, so this is just the constructor.
export type ViewType<T extends View = View> = new () => T;

@reflect
export abstract class Entity extends BaseEntity {
    id: PrimaryKey;
    // Signum's `Entity.IsNew`: true for a freshly constructed entity, cleared to false once it
    // is retrieved (Retriever.getOrCreate / TypeLogic) or saved (Saver). Authoritative — the
    // Saver keys insert-vs-update on it, and the default toString() branches on it.
    // @column(false) so it is never a column / never enters change tracking; @serialize(false)
    // so it stays off the wire (it is derived from id == null on each end).
    @column(false) @serialize(false) isNew: boolean = true;
    ticks: number;

    /**
     * Builds a {@link Lite} pointing to this entity. Uses the
     * {@link registerCustomLite | registered} custom-lite constructor for this
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
        const constructor = getCustomLiteConstructor(type);
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
    /**
     * Builds a {@link Lite} using a *specific* registered custom lite class, rather than the
     * type's default (what {@link toLite} uses). The class must have been registered for this
     * entity type via {@link registerCustomLite} — its `fromEntity` builder is what runs here.
     * `fat` embeds the full entity, exactly like {@link toLite}.
     */
    toCustomLite(liteClass: CustomLiteClass, fat = false): Lite<this> {
        if (!fat && this.id == null)
            throw new Error('toCustomLite() is not allowed for new entities (no id yet), use toCustomLite(class, true) instead');

        const type = this.constructor as Type<this>;
        const constructor = getCustomLiteConstructorFor(type, liteClass);
        if (constructor == null)
            throw new Error(`No custom lite '${(liteClass as { name?: string }).name ?? '?'}' is registered for '${this.constructor.name}'`);

        const lite = constructor(this);
        if (fat)
            lite.setEntity(this);
        return lite;
    }

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
        return this.isNew ? "New " + this.getType().niceName() : this.getType().niceName() + " " + this.id.toString();
    }

    /**
     * Runtime-type test on an *entity* reference: `AlbumEntity.isInstance(x)` is the
     * static-method form of `x instanceof AlbumEntity`, and a TypeScript type guard —
     * `x` narrows to the instance type of the class it is called on (the polymorphic
     * `this` constructor parameter captures that type). In a query the provider lowers
     * it to a reference type-test (SmartEqualizer.entityIsInstance): for a concrete/IB
     * reference an id-not-null guard, for an @implementedByAll reference a type-column
     * comparison.
     */
    static isInstance<T extends Entity>(this: abstract new (...args: any[]) => T, entity: Entity | null | undefined): entity is T {
        return entity instanceof (this as unknown as Function);
    }

    /**
     * Runtime-type test on a *lite*: `AlbumEntity.isLite(l)` is the Signum
     * `l is Lite<AlbumEntity>`, and a TypeScript type guard narrowing `l` to
     * `Lite<AlbumEntity>`. TypeScript erases `Lite<AlbumEntity>` to `Lite`, so
     * `l instanceof …` can't discriminate the pointed-to type — this reads the lite's
     * `entityType` instead (matching subclasses). In a query the provider lowers it to
     * the same reference type-test as {@link isInstance} (entityIsInstance unwraps the
     * lite to its reference first).
     */
    static isLite<T extends Entity>(this: abstract new (...args: any[]) => T, lite: Lite<Entity> | null | undefined): lite is Lite<T> {
        if (lite == null)
            return false;
        const ctor = this as unknown as Function;
        const t = lite.entityType as unknown as Function;
        return t === ctor || t.prototype instanceof ctor;
    }

    getType(): Type<this> {
        return this.constructor as Type<this>;
    }
}

// NOTE: the query-expression result-type metadata for `.is()` / `.toLite()` / `Ctor.isInstance` /
// `Ctor.isLite` (Signum's method attributes) is RuntimeType — a LINQ-provider concern — so it lives in
// logic/index.ts (server), not here: entities/ stays RuntimeType-free.

export abstract class EmbeddedEntity extends BaseEntity { }

export abstract class ModelEntity extends BaseEntity { }

// Base for mixin classes (Signum's MixinEntity). A mixin contributes extra
// fields to an owning entity; it is attached with @mixin(() => [TheMixin]) on
// the entity and its fields are folded into the owner's table by the schema
// builder.
export abstract class MixinEntity extends BaseEntity { }

// Copy each declared mixin field's default onto a freshly-created entity. altea inlines mixin
// fields onto the entity (mixin() returns `this`) but doesn't declare them there, so their
// initializers (e.g. `corrupt = false`) never run on `new Entity()` — this seeds them. Only
// declared mixin fields with a defined default are copied (never base bookkeeping props).
function applyMixinDefaults(instance: object, ctor: Function): void {
    for (const mixinCtor of MixinDeclarations.getMixins(ctor as Type<BaseEntity>)) {
        const info = getTypeInfo(mixinCtor as unknown as object);
        if (info == null)
            continue;
        const defaults = new (mixinCtor as unknown as new () => object)() as Record<string, unknown>;
        for (const fieldName of Object.keys(info.fields)) {
            if (defaults[fieldName] !== undefined)
                (instance as Record<string, unknown>)[fieldName] = defaults[fieldName];
        }
    }
}
