
import type { BaseEntity, Type, Entity } from './entity';

const mixinDeclarationsKey = Symbol.for('altea:mixinDeclarations');

// Mixins are stored as deferred thunks so that @mixin(() => [SomeMixin]) can
// reference a mixin class declared later in the file (forward reference). The
// thunks are resolved lazily by getMixins, called from the schema builder once
// every class is defined. Thunks live on the class constructor (legacy
// decorators have no context.metadata).
type MixinThunk = () => Type<BaseEntity>[];

// The class's own thunk array, created (seeded from inherited thunks) on first
// write. Constructors inherit statics via their prototype chain, so seeding from
// the inherited array preserves "a base class's mixins apply to subclasses" while
// the copy ensures a subclass never mutates the base class's array.
function ownThunks(ctor: any): MixinThunk[] {
    if (Object.prototype.hasOwnProperty.call(ctor, mixinDeclarationsKey))
        return ctor[mixinDeclarationsKey] as MixinThunk[];
    const inherited = ctor[mixinDeclarationsKey] as MixinThunk[] | undefined;
    const own = inherited != null ? [...inherited] : [];
    Object.defineProperty(ctor, mixinDeclarationsKey, { value: own, configurable: true, writable: true, enumerable: false });
    return own;
}

// What `register` has already declared, so a second call (both tiers share the module, tests re-run the
// overrides) is a no-op instead of a duplicate mixin.
const registered = new WeakMap<Type<BaseEntity>, Set<Type<BaseEntity>>>();

export namespace MixinDeclarations {
    /** Signum's `MixinDeclarations.Register<T, M>()`. Idempotent; must run on BOTH tiers before anything is
     *  (de)serialized or the schema is built. */
    export function register<T extends BaseEntity, M extends BaseEntity>(
        target: Type<T>,
        mixin: Type<M>,
    ): void {
        let mixins = registered.get(target);
        if (mixins == null)
            registered.set(target, mixins = new Set());
        if (mixins.has(mixin))
            return;
        mixins.add(mixin);
        ownThunks(target).push(() => [mixin]);
    }

    export function getMixins(target: Type<BaseEntity>): Type<BaseEntity>[] {
        const thunks = (target as any)?.[mixinDeclarationsKey] as MixinThunk[] | undefined;
        return thunks?.flatMap(t => t()) ?? [];
    }

    /** Whether `mixin` is declared on `target` — what a module's `start` asserts before relying on it. */
    export function isDeclared(target: Type<BaseEntity>, mixin: Type<BaseEntity>): boolean {
        return getMixins(target).includes(mixin);
    }
}

// Attaches one or more mixins to an entity: `@mixin(() => [ColaboratorsMixin])`.
// The thunk defers evaluation so mixin classes may be declared after the owner.
export function mixin(mixins: () => Type<BaseEntity>[]) {
    return function (target: Type<Entity>): void {
        ownThunks(target).push(mixins);
    };
}
