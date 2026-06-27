import { Entity, isGenericType } from './entity';
import type { Type, GenericType } from './entity';
import { reflect } from './reflection';
import { ignore } from './decorators';
import { enumNameOf } from './registration';

// Port of Signum's EnumEntity<T>: a database enum modelled as a real entity (and
// therefore a real table) rather than an inline column. The row Id is the enum
// member's underlying numeric value and `name` is the member name.
//
// TypeScript erases generics at runtime, so the closed type EnumEntity<Sex> is
// represented as data via EnumEntity.typeFor(Sex), which returns a (cached)
// GenericType `{ genericType: EnumEntity, genericArguments: [Sex] }`. Because that
// descriptor is a Type<EnumEntity<Sex>>, it flows through sb.include() like any
// entity — so it supports mixins (MixinDeclarations.register(EnumEntity.typeFor(Sex),
// …)) and polymorphic references (@implementedBy(() => [EnumEntity.typeFor(Sex), …])).
//
// The PK is a non-identity int and there is no ticks column; the SchemaBuilder
// special-cases enum-entity tables for both (see completeTable).
@reflect
export class EnumEntity<T = unknown> extends Entity {
    // The enum this row belongs to. TS erases the generic `T`, so an instance
    // carries its enum object explicitly — that's how runtime code tells an
    // EnumEntity<Sex> from an EnumEntity<Color>. @ignore: identity lives in code,
    // it is never a column.
    @ignore
    readonly enumObject: object;

    // The enum member name (Signum's ToStringColumn "Name"). Sized by the builder.
    name: string;

    constructor(enumObject: object) {
        super();
        this.enumObject = enumObject;
    }

    // The closed type EnumEntity<E> as data. Cached per enum object so the
    // descriptor has a stable identity (schema.tables / include() dedupe on it,
    // and mixins register against it). The enum must already be registered.
    static typeFor<E extends object>(enumObject: E): Type<EnumEntity<E>> {
        let descriptor = cache.get(enumObject);
        if (descriptor == null) {
            if (enumNameOf(enumObject) == null)
                throw new Error('EnumEntity.typeFor(...) requires the enum to be registered first (registerEnum). Enums declared in the same file as a referencing entity are auto-registered; call registerEnum(MyEnum) by hand for cross-file enums.');
            descriptor = { genericType: EnumEntity, genericArguments: [enumObject] };
            cache.set(enumObject, descriptor);
        }
        return descriptor as Type<EnumEntity<E>>;
    }
}

const cache = new WeakMap<object, GenericType>();

// True for a closed EnumEntity<…> type reference.
export function isEnumEntityType(type: unknown): boolean {
    return isGenericType(type) && type.genericType === EnumEntity;
}

// The enum object a closed EnumEntity<…> type is bound to (undefined otherwise).
export function getBoundEnum(type: unknown): object | undefined {
    return isEnumEntityType(type) ? (type as GenericType).genericArguments[0] as object : undefined;
}

// The rows to seed for an enum: id = the member's underlying numeric value,
// name = the member name. TS numeric enums carry reverse value→name entries too;
// keep only the name→number side.
export function enumEntityMembers(enumObject: object): { id: number; name: string }[] {
    return Object.entries(enumObject)
        .filter(([, v]) => typeof v === 'number')
        .map(([name, v]) => ({ id: v as number, name }));
}
