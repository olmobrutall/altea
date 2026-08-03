
import type { BaseEntity, Type } from './entity';

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

export namespace MixinDeclarations {
    export function register<T extends BaseEntity, M extends BaseEntity>(
        target: Type<T>,
        mixin: Type<M>,
    ): void {
        ownThunks(target).push(() => [mixin]);
    }

    export function getMixins(target: Type<BaseEntity>): Type<BaseEntity>[] {
        const thunks = (target as any)?.[mixinDeclarationsKey] as MixinThunk[] | undefined;
        return thunks?.flatMap(t => t()) ?? [];
    }
}

// Attaches one or more mixins to an entity: `@mixin(() => [ColaboratorsMixin])`.
// The thunk defers evaluation so mixin classes may be declared after the owner.
export function mixin(mixins: () => Type<BaseEntity>[]) {
    return function (target: Function): void {
        ownThunks(target).push(mixins);
    };
}
