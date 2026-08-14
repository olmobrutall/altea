import { Entity } from './entity';
import { reflect } from './reflection';
import { uniqueIndex, quoted } from './decorators';

// Port of Signum's Symbol (Signum/Basics/Symbol.cs): the abstract base of every
// "symbol" — a SystemString entity identified by a unique textual `key` of the
// form "<Container>.<field>" (e.g. "UserOperation.Save"). Concrete subtypes
// (OperationSymbol, TypeConditionSymbol, …) each get their own table via
// SymbolLogic<T>; the abstract base is never `sb.include`d directly, so it carries
// no @entity kind/data (that lives on the concrete subtype) — only @reflect, so the
// `key` field gets reflection metadata that subclasses inherit (getOrCreateTypeInfo
// seeds a subclass's fields from its base).
//
// Differences vs Signum:
//  - No AutoInit/MSBuild: the `key` is filled by the quote-transformer, which
//    rewrites `init()` into `init("<Kind>", "<Container>.<field>", __fileInfo)`
//    (see registration.init).
//  - Faithful to Signum: the id is an IDENTITY PK, DB-assigned and READ BACK by
//    SymbolLogic (via a ResetLazy, exactly like TypeLogic/TypeEntity) — `init()`
//    leaves the id unset, generation seeds the rows without ids, and the load stamps
//    the read-back ids onto the shared symbol instances.
@reflect
export abstract class Symbol extends Entity {
    // Signum's Symbol.Key ([UniqueIndex], [StringLengthValidator(3, 200)]). The
    // stable textual identity; unique across a given concrete symbol table.
    @uniqueIndex
    key: string;

    // Signum's [AutoExpressionField] ToString => Key: a translatable expression, so
    // it inlines in queries and the entity carries no stored ToStr column.
    @quoted
    toString(): string {
        return this.key;
    }
}

// True for a concrete Symbol subclass (OperationSymbol, …), false for the abstract
// base and non-symbols. The SchemaBuilder uses it to give symbol tables the seeded,
// no-ticks treatment (like TypeEntity) — an IDENTITY PK whose rows SymbolLogic seeds
// (without ids) and reads back.
export function isSymbolType(ctor: Function): boolean {
    return ctor !== Symbol && ctor.prototype instanceof Symbol;
}
