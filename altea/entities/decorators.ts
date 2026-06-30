
import { getOrCreateTypeInfo, getOrCreateFieldInfo, registerType, FieldInfo, ctorOf } from './reflection';
import type { PrimaryKeyType, ColumnOptions } from './reflection';
import type { Type, Entity } from './entity';
import type { ExLambda } from 'quote-transformer/quoted';

export type { ColumnOptions } from './reflection';

// `@quoted` / `withQuoted` mark a method (or function) whose body the quote-transformer
// captures as a translatable expression, stored on `__quoted`. They live here (entities)
// so the entity model can annotate expression members without depending on the query
// layer; the resolver/carrier helpers (StaticFunction, lambdaTypeForParam, …) stay in
// logic/query. We touch only `__quoted`, so a minimal local carrier type suffices.
type Quotable = { __quoted?: () => ExLambda };

// Two call shapes:
//   @quoted        — bare. The quote-transformer rewrites it to @quoted(() => <expr>)
//                    before emit, so this overload exists only so the bare form
//                    type-checks as a method decorator.
//   @quoted(exp)   — the rewritten/explicit form the transformer produces.
export function quoted(target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void;
export function quoted(exp?: () => ExLambda): (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => void;
export function quoted(arg1?: unknown, arg2?: unknown, _arg3?: unknown): unknown {
    // Bare @quoted reached runtime (applied directly as a decorator: arg2 is a
    // property key). The transformer should have rewritten it to @quoted(() => <expr>).
    if (typeof arg2 === "string" || typeof arg2 === "symbol")
        throw new Error(`Unable to add the quoted expression to "${String(arg2)}". Are you using ts-patch and quote-transformer?`);

    const exp = arg1 as (() => ExLambda) | undefined;
    return function (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void {
        if (exp == undefined)
            throw new Error(`Unable to add the quoted expression to "${String(propertyKey)}". Are you using ts-patch and quote-transformer?`);

        const fn = descriptor.value;
        if (typeof fn != "function")
            throw new Error(`@quoted can only be applied to methods, but '${String(propertyKey)}' is not a method`);

        (fn as Quotable).__quoted = exp;
    };
}

// Functional form of @quoted, for attaching a quoted expression to a function value
// (e.g. a prototype method added outside a class). The transformer rewrites
// `withQuoted(fn)` to inject the captured expression as the second argument.
export function withQuoted<T extends Function>(f: T, quoted?: () => ExLambda): T {
    (f as unknown as Quotable).__quoted = quoted;
    return f;
}

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

const entityInfoKey = Symbol.for('altea:entityInfo');
const allowUnauthenticatedKey = Symbol.for('altea:allowUnauthenticated');

// EntityKind / EntityData are recorded on the constructor (legacy decorators
// have no context.metadata). Read back with getEntityInfo.
export function getEntityInfo(target: object): EntityInfo | undefined {
    return (ctorOf(target) as any)?.[entityInfoKey] as EntityInfo | undefined;
}

export function isAllowUnauthenticated(target: object): boolean {
    return (ctorOf(target) as any)?.[allowUnauthenticatedKey] === true;
}

// Marks a class as a persistent entity. Like @reflect it creates reflection
// metadata and registers the type (so the quote-transformer auto-injects @field
// on its properties); additionally it records the EntityKind / EntityData.
// `@entity()` (no args) is valid for the base Entity class.
export function entity(kind?: EntityKind, data?: EntityData) {
    return function (target: Function): void {
        (target as any)[entityInfoKey] = { kind, data } satisfies EntityInfo;
        getOrCreateTypeInfo(target);
        registerType(target);
    };
}

// A "part" entity: owned/embedded-style table (EntityKind.Part), e.g. the rows
// that replace a Signum MList. Triggers the same @field injection as @entity.
export function partEntity(target: Function): void {
    (target as any)[entityInfoKey] = { kind: EntityKind.Part, data: EntityData.Transactional } satisfies EntityInfo;
    getOrCreateTypeInfo(target);
    registerType(target);
}

// Sets the runtime type of the entity's primary key (Signum's
// [PrimaryKey(typeof(...))]). Recorded on the implicit `id` field's
// columnOptions and consumed by SchemaBuilder. Absent → schema default (int).
export function primaryKey(type: PrimaryKeyType) {
    return function (target: Function): void {
        const typeInfo = getOrCreateTypeInfo(target);
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
    (target as any)[allowUnauthenticatedKey] = true;
}

export function ignore(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).ignore = true;
}

export function fkProperty(propertyName: string) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).fkPropertyName = propertyName;
    };
}

// Field-level decorator: overrides column mapping (name / db types / size /
// precision / nullability) for a field. Stored on FieldInfo.columnOptions and
// consumed by SchemaBuilder. Lives in entities/ (the entity model owns its column
// annotations); the schema layer re-exports it for back-compat.
export function column(options: ColumnOptions = {}) {
    return function (target: object, propertyKey: string | symbol) {
        const key = String(propertyKey);
        const normalizedOptions: ColumnOptions = {
            ...options,
            columnName: options.columnName ?? key,
        };

        const typeInfo = getOrCreateTypeInfo(target);
        const existing = getOrCreateFieldInfo(typeInfo, key);
        existing.columnOptions = normalizedOptions;
        // Mirror an explicit nullable into the field's nullability so the column
        // is generated NULL even when the TS type isn't `| null` (Signum's
        // ForceNullable). Auto-@field never sets nullable for a non-null type, so
        // this is the authoritative source for those.
        if (options.nullable != null)
            existing.isNullable = options.nullable;
        typeInfo.fields[key] = existing;
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
// Bare @include defers to a sibling @implementedBy; @include(() => X) supplies
// the referenced constructor(s). The bare overload exists so source type-checks
// (tsc checks the original AST, before the transformer runs).
export function include(target: object, propertyKey: string | symbol): void;
export function include(types: () => unknown): (target: object, propertyKey: string | symbol) => void;
export function include(arg1: unknown, arg2?: unknown): unknown {
    // Bare @include applied directly as a property decorator.
    if (typeof arg2 === 'string' || typeof arg2 === 'symbol') {
        getOrCreateFieldInfo(getOrCreateTypeInfo(arg1 as object), String(arg2)).include = true;
        return;
    }
    const types = arg1 as () => unknown;
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).include = types;
    };
}

// Marks the int column that preserves MList row order (Signum's [PreserveOrder]).
export function rowOrder(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).isRowOrder = true;
}

// Marks the element-value field of a non-embedded MList row (the scalar /
// reference the MList<T> held), e.g. `@valueField colaborator: Lite<ArtistEntity>`.
export function valueField(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).isValueField = true;
}

export function implementedBy(types: () => Type<Entity>[]) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).implementations = { kind: 'implementedBy', types };
    };
}

export function implementedByAll(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).implementations = { kind: 'implementedByAll' };
}

// Child-side marker (Altea's MList replacement): tags the single FK field on a
// part entity that points back to its owner, e.g. `@backReference album: Lite<AlbumEntity>`
// inside `AlbumEntity_Songs`. The owner declares the collection with
// `@include(() => AlbumEntity_Songs)`; the SchemaBuilder finds this marked field
// as the back-pointing FK, so the relationship is described from both sides
// without repeating the property name.
export function backReference(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).isBackReference = true;
}
