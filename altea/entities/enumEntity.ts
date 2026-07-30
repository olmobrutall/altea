import { Entity } from './entity';
import type { Type } from './entity';
import { reflect, field, getOrCreateTypeInfo } from './reflection';
import { enumNameOf } from './registration';
import { Enum } from './enum';

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
    // EnumEntity<Sex> from an EnumEntity<Color>. @field(false): a runtime enum object with no
    // reflection metadata at all — never a column, never change-tracked, never serialized.
    @field(false)
    readonly enumObject: object;

    // The enum member name (Signum's ToStringColumn "Name"). Sized by the builder.
    name: string;

    constructor(enumObject: object) {
        super();
        this.enumObject = enumObject;
    }

    // The closed type EnumEntity<E> as a real constructor: a per-enum subclass that carries the
    // enum as a static `boundEnum` and is 0-arg constructable (so it's a valid `Type<T>` = ctor,
    // no GenericType descriptor). Cached per enum for stable identity (schema.tables / include()
    // dedupe on it, mixins register against it). Its own TypeInfo is seeded (copying EnumEntity's
    // reflected fields) so tryGetTypeInfo works on it. The enum must already be registered.
    static typeFor<E extends object>(enumObject: E): Type<EnumEntity<E>> {
        let ctor = cache.get(enumObject);
        if (ctor == null) {
            if (enumNameOf(enumObject) == null)
                throw new Error('EnumEntity.typeFor(...) requires the enum to be registered first (registerEnum). Enums declared in the same file as a referencing entity are auto-registered; call registerEnum(MyEnum) by hand for cross-file enums.');
            const bound = class extends EnumEntity<E> {
                static readonly boundEnum: object = enumObject;
                constructor() { super(enumObject); }
            };
            Object.defineProperty(bound, 'name', { value: `EnumEntity<${enumNameOf(enumObject)}>`, configurable: true });
            getOrCreateTypeInfo(bound); // seed its own TypeInfo (inherits EnumEntity's fields)
            cache.set(enumObject, bound);
            ctor = bound;
        }
        return ctor as unknown as Type<EnumEntity<E>>;
    }
}

const cache = new WeakMap<object, Type<EnumEntity>>();

// True for a closed EnumEntity<…> type: a constructor carrying the `boundEnum` static.
export function isEnumEntityType(type: unknown): boolean {
    return typeof type === 'function' && (type as { boundEnum?: object }).boundEnum != null;
}

// The enum object a closed EnumEntity<…> type is bound to (undefined otherwise).
export function getBoundEnum(type: unknown): object | undefined {
    return typeof type === 'function' ? (type as { boundEnum?: object }).boundEnum : undefined;
}

// The rows to seed for an enum: id = the member's underlying numeric value,
// name = the member name. TS numeric enums carry reverse value→name entries too;
// keep only the name→number side. Members marked not-mapped (Enum.markAsNotMapped) are
// excluded, so they never get a database row — this is the hook by which not-mapped members
// influence both the Schema Generator (insertEnumValues) and the Synchronizer.
export function enumEntityMembers(enumObject: object): { id: number; name: string }[] {
    return Object.entries(enumObject)
        .filter(([, v]) => typeof v === 'number')
        .filter(([name]) => !Enum.isNotMapped(enumObject as Record<string, string | number>, name))
        .map(([name, v]) => ({ id: v as number, name }));
}
