import { Entity, typeConstructor } from './entity';
import type { FieldInfo } from './reflection';
import { fieldType } from './reflection';
import { cleanTypeName } from './registration';

// Port of Signum's `Implementations` (Entities/FieldAttributes.cs): the set of concrete
// entity types a reference may hold. Either a fixed list (`ImplementedBy`) or "any entity"
// (`ImplementedByAll`). A plain, non-polymorphic reference is modelled as a single-type
// `ImplementedBy` — matching Signum, where `Implementations.By(type)` covers the ordinary
// FK case too.
//
// Divergence from Signum: altea resolves implementations directly off the field's reflection
// metadata (`FieldInfo.implementations` / the field's declared type) via `tryFromFieldInfo`,
// not through a schema-level `FindImplementations` callback — so `PropertyRoute.getImplementations()`
// needs no global registration step.
export class Implementations {
    // `undefined` ⇒ ImplementedByAll; a ctor array ⇒ ImplementedBy(those types).
    private constructor(private readonly arrayOrType: Function[] | undefined) { }

    get isByAll(): boolean { return this.arrayOrType == undefined; }

    get types(): Function[] {
        if (this.arrayOrType == undefined)
            throw new Error("ImplementedByAll");
        return this.arrayOrType;
    }

    // The single implementation, or undefined if there are zero or many (Signum's `Types.Only()`).
    only(): Function | undefined {
        return this.arrayOrType != undefined && this.arrayOrType.length === 1 ? this.arrayOrType[0] : undefined;
    }

    static readonly byAll = new Implementations(undefined);

    static by(...types: Function[]): Implementations {
        const errors = types.map(Implementations.error).filter((e): e is string => e != null);
        if (errors.length > 0)
            throw new Error(errors.join("\n"));
        return new Implementations(types);
    }

    // Resolve a reference field's implementations from its reflection metadata (Signum's
    // `Implementations.TryFromAttributes`). Returns undefined for a non-reference field
    // (value/enum/embedded).
    static tryFromFieldInfo(fi: FieldInfo): Implementations | undefined {
        const impl = fi.implementations;
        if (impl != undefined)
            return impl.kind === 'implementedByAll' ? Implementations.byAll : Implementations.by(...impl.types().map(typeConstructor));

        const ctor = fieldType(fi);
        if (ctor != undefined && Implementations.error(ctor) == null)
            return Implementations.by(ctor);

        return undefined;
    }

    // Signum's `Implementations.Error`: an implementation must be a concrete entity.
    private static error(type: Function): string | null {
        if (!(type.prototype instanceof Entity))
            return `${type.name} is not an Entity`;
        return null;
    }

    key(): string {
        return this.isByAll ? "[ALL]" : this.types.map(cleanTypeName).join(", ");
    }

    toString(): string {
        return this.isByAll ? "ImplementedByAll" : `ImplementedBy(${this.types.map(t => t.name).join(", ")})`;
    }

    equals(other: Implementations): boolean {
        if (this.isByAll || other.isByAll)
            return this.isByAll && other.isByAll;
        const a = this.types, b = other.types;
        return a.length === b.length && a.every(t => b.includes(t));
    }
}
