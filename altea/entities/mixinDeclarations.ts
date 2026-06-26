
import type { BaseEntity, Type } from './entity';
import { getOrCreateTypeInfo } from './reflection';

const mixinDeclarationsKey = Symbol.for('altea:mixinDeclarations');

const symbolWithMetadata = Symbol as any;
if (symbolWithMetadata.metadata == null) {
    symbolWithMetadata.metadata = Symbol.for('Symbol.metadata');
}
const metadataSymbol: symbol = symbolWithMetadata.metadata;

// Mixins are stored as deferred thunks so that @mixin(() => [SomeMixin]) can
// reference a mixin class declared later in the file (forward reference). The
// thunks are resolved lazily by getMixins, called from the schema builder once
// every class is defined.
type MixinThunk = () => Type<BaseEntity>[];

export namespace MixinDeclarations {
    export function register<T extends BaseEntity, M extends BaseEntity>(
        target: Type<T>,
        mixin: Type<M>,
    ): void {
        const metadata = (target as any)[metadataSymbol];
        if (metadata == null) return;
        const thunks: MixinThunk[] = metadata[mixinDeclarationsKey] ?? [];
        thunks.push(() => [mixin]);
        metadata[mixinDeclarationsKey] = thunks;
    }

    export function getMixins(target: Type<BaseEntity>): Type<BaseEntity>[] {
        const metadata = (target as any)[metadataSymbol];
        const thunks: MixinThunk[] = metadata?.[mixinDeclarationsKey] ?? [];
        return thunks.flatMap(t => t());
    }
}

// Attaches one or more mixins to an entity: `@mixin(() => [ColaboratorsMixin])`.
// The thunk defers evaluation so mixin classes may be declared after the owner.
export function mixin(mixins: () => Type<BaseEntity>[]) {
    return function (_target: Function, context: ClassDecoratorContext): void {
        if (context.metadata == null)
            return;
        const thunks: MixinThunk[] = (context.metadata as any)[mixinDeclarationsKey] ?? [];
        thunks.push(mixins);
        (context.metadata as any)[mixinDeclarationsKey] = thunks;
    };
}
