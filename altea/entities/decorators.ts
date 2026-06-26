
import { getOrCreateTypeInfo, getOrCreateFieldInfo, registerType, FieldInfo } from './reflection';
import type { PrimaryKeyType } from './reflection';
import type { Type, Entity } from './entity';

export type { PrimaryKeyType } from './reflection';

export {
    stringLengthValidator, urlValidator, telephoneValidator,
    emailValidator, noRepeatValidator,
    customValidators as fieldValidation,
} from './validators';

// Re-exported so entity authors get @mixin from the same module as the other
// entity decorators. Implementation lives in ./mixinDeclarations.
export { mixin, MixinDeclarations } from './mixinDeclarations';

export enum EntityKind {
    /** Detailed diagnostic information. */
    SystemString = 'SystemString',
    System = 'System',
    Relational = 'Relational',
    String = 'String',
    Shared = 'Shared',
    Main = 'Main',
    Part = 'Part',
    SharedPart = 'SharedPart',
}

export enum EntityData {
    Transactional = 'Transactional',
    Master = 'Master',
}

export interface EntityInfo {
    kind?: EntityKind;
    data?: EntityData;
}

const symbolWithMetadata = Symbol as any;
if (symbolWithMetadata.metadata == null) {
    symbolWithMetadata.metadata = Symbol.for('Symbol.metadata');
}
const metadataSymbol: symbol = symbolWithMetadata.metadata;

const entityInfoKey = Symbol.for('altea:entityInfo');
const allowUnauthenticatedKey = Symbol.for('altea:allowUnauthenticated');



// Marks a class as a persistent entity. Like @reflect it creates reflection
// metadata and registers the type (so the quote-transformer auto-injects @field
// on its properties); additionally it records the EntityKind / EntityData.
// `@entity()` (no args) is valid for the base Entity class.
export function entity(kind?: EntityKind, data?: EntityData) {
    return function (target: Function, context?: ClassDecoratorContext): void {
        const metadata = context?.metadata ?? (target as any)[metadataSymbol];
        if (metadata != null) {
            metadata[entityInfoKey] = { kind, data } satisfies EntityInfo;
            getOrCreateTypeInfo(metadata);
        }
        registerType(target);
    };
}

// A "part" entity: owned/embedded-style table (EntityKind.Part), e.g. the rows
// that replace a Signum MList. Triggers the same @field injection as @entity.
export function partEntity(target: Function, context: ClassDecoratorContext): void {
    const metadata = context.metadata;
    if (metadata != null) {
        metadata[entityInfoKey] = { kind: EntityKind.Part, data: EntityData.Transactional } satisfies EntityInfo;
        getOrCreateTypeInfo(metadata);
    }
    registerType(target);
}

// Sets the runtime type of the entity's primary key (Signum's
// [PrimaryKey(typeof(...))]). Recorded on the implicit `id` field's
// columnOptions and consumed by SchemaBuilder. Absent → schema default (int).
export function primaryKey(type: PrimaryKeyType) {
    return function (_target: Function, context: ClassDecoratorContext): void {
        if (context.metadata == null)
            return;
        const typeInfo = getOrCreateTypeInfo(context.metadata);
        // The base Entity's `id` FieldInfo is shallow-copied (by reference) into
        // every subclass's TypeInfo, so it is SHARED. Replace it with an own copy
        // before mutating, or @primaryKey on one entity would change all of them.
        const inherited = typeInfo.fields['id'];
        const fi = new FieldInfo('id');
        if (inherited != null)
            Object.assign(fi, inherited);
        fi.columnOptions = { ...(fi.columnOptions ?? {}), primaryKey: type };
        typeInfo.fields['id'] = fi;
    };
}

export function allowUnauthenticated(target: Function): void {
    const metadata = (target as any)[metadataSymbol];
    if (metadata != null)
        metadata[allowUnauthenticatedKey] = true;
}

export function ignore(_value: undefined, _context: ClassFieldDecoratorContext): void {
    const key = String(_context.name);
    const typeInfo = getOrCreateTypeInfo(_context.metadata!);
    getOrCreateFieldInfo(typeInfo, key).ignore = true;
}

export function fkProperty(propertyName: string) {
    return function (_value: undefined, context: ClassFieldDecoratorContext): void {
        const key = String(context.name);
        const typeInfo = getOrCreateTypeInfo(context.metadata!);
        getOrCreateFieldInfo(typeInfo, key).fkPropertyName = propertyName;
    };
}

// Provides the referenced entity constructor(s) for a field via a user-written
// thunk, e.g. `@include(() => OrderLineEntity)`. Two wins over resolving the type
// by name: (1) the `() => X` arrow is a value-use in source, so TS never elides
// the import (no verbatimModuleSyntax, no transformer magic — works the same on
// tsc and tsgo); (2) the schema builder gets the constructor by reference, so it
// is immune to bundler renames and needs no registration order.
//
// Bare `@include` (no thunk) defers to a sibling `@implementedBy(() => [...])`,
// whose own lambda already supplies the constructors — so the types aren't
// repeated.
export function include(value: undefined, context: ClassFieldDecoratorContext): void;
export function include(types: () => unknown): (value: undefined, context: ClassFieldDecoratorContext) => void;
export function include(arg1: unknown, arg2?: unknown): unknown {
    if (arg2 != null && typeof arg2 === 'object' && (arg2 as { kind?: unknown }).kind != null) {
        const context = arg2 as ClassFieldDecoratorContext;
        getOrCreateFieldInfo(getOrCreateTypeInfo(context.metadata!), String(context.name)).include = true;
        return;
    }
    const types = arg1 as () => unknown;
    return function (_value: undefined, context: ClassFieldDecoratorContext): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(context.metadata!), String(context.name)).include = types;
    };
}

// Marks the int column that preserves MList row order (Signum's [PreserveOrder]).
export function rowOrder(_value: undefined, context: ClassFieldDecoratorContext): void {
    const key = String(context.name);
    const typeInfo = getOrCreateTypeInfo(context.metadata!);
    getOrCreateFieldInfo(typeInfo, key).isRowOrder = true;
}

// Marks the element-value field of a non-embedded MList row (the scalar /
// reference the MList<T> held), e.g. `@valueField colaborator: Lite<ArtistEntity>`.
export function valueField(_value: undefined, context: ClassFieldDecoratorContext): void {
    const key = String(context.name);
    const typeInfo = getOrCreateTypeInfo(context.metadata!);
    getOrCreateFieldInfo(typeInfo, key).isValueField = true;
}

export function implementedBy(types: () => Type<Entity>[]) {
    return function (_value: undefined, context: ClassFieldDecoratorContext): void {
        const key = String(context.name);
        const typeInfo = getOrCreateTypeInfo(context.metadata!);
        getOrCreateFieldInfo(typeInfo, key).implementations = { kind: 'implementedBy', types };
    };
}

export function implementedByAll(_value: undefined, context: ClassFieldDecoratorContext): void {
    const key = String(context.name);
    const typeInfo = getOrCreateTypeInfo(context.metadata!);
    getOrCreateFieldInfo(typeInfo, key).implementations = { kind: 'implementedByAll' };
}

// Child-side marker (Altea's MList replacement): tags the single FK field on a
// part entity that points back to its owner, e.g. `@backReference album: Lite<AlbumEntity>`
// inside `AlbumEntity_Songs`. The owner declares the collection with
// `@include(() => AlbumEntity_Songs)`; the SchemaBuilder finds this marked field
// as the back-pointing FK, so the relationship is described from both sides
// without repeating the property name.
export function backReference(_value: undefined, context: ClassFieldDecoratorContext): void {
    const key = String(context.name);
    const typeInfo = getOrCreateTypeInfo(context.metadata!);
    getOrCreateFieldInfo(typeInfo, key).isBackReference = true;
}
