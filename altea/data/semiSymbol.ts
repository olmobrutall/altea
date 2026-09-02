import { Entity } from './entity';
import { reflect } from './reflection';
import { uniqueIndex, quoted, stringLengthValidator, ticksColumn } from './decorators';
import { Localization } from './utils/localization';

// Port of Signum's SemiSymbol (Signum/Basics/SemiSymbol.cs) — HALF a symbol: a row that MAY be declared in
// code (then it has a `key`, like a Symbol) or created by a user at runtime (then it has only a `name`).
// That is the whole difference from Symbol, and it is why the key is NULLABLE here and not there.
//
// It is a SIBLING of Symbol, not a subclass — Signum derives it straight from Entity, because almost
// nothing Symbol does applies: a SemiSymbol table is user-writable (EntityKind.String, its own Save
// operation), so it is not "seeded", and its rows are not all known at compile time.
//
// What it shares with Symbol: identity is the KEY when there is one (equality, the display string), the
// declared instances are stamped with their persisted ids at startup, and the table carries no concurrency
// stamp (Signum's [TicksColumn(false)] — see SemiSymbolLogic for who writes these rows).
//
// altea divergences:
//  - No AutoInit/MSBuild: `init()` fills the key, rewritten by the quote-transformer exactly as for a
//    Symbol — so a code-declared SemiSymbol is written the same way.
//  - Signum's `FieldInfo` / `SetFromDatabase` / `CallRetrieved` plumbing exists to recover a declared
//    symbol's reflection info on a row retrieved from the database. altea resolves a display name from the
//    metadata blob by key (see niceToString), so none of it is needed.
@reflect
@ticksColumn(false)
export abstract class SemiSymbol extends Entity {

    // Signum's SemiSymbol.Key ([UniqueIndex], [StringLengthValidator(3, 200)]) — NULLABLE, unlike a
    // Symbol's: a row a user created has no key, and that is precisely what makes it a SemiSymbol.
    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 200 })
    key: string | null = null;

    // Signum's SemiSymbol.Name ([StringLengthValidator(3, 100)]) — always present, and the only identity a
    // user-created row has.
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    // Signum's `[AutoExpressionField] ToString => this.Key ?? this.Name`.
    @quoted
    toString(): string {
        return this.key ?? this.name;
    }

    /**
     * The LOCALISED label (Signum's `SemiSymbol.NiceToString()`): a DECLARED one is translated through its
     * container exactly as a Symbol's key is, and a user-created one has only the name it was given.
     */
    niceToString(): string {
        if (this.key == null)
            return this.name;

        const dot = this.key.indexOf(".");
        const container = dot >= 0 ? this.key.slice(0, dot) : this.key;
        const member = dot >= 0 ? this.key.slice(dot + 1) : this.key;
        return Localization.Internal.translate(container, member) ?? Localization.Internal.niceMemberName(member);
    }
}

/** True for a concrete SemiSymbol subclass (NoteTypeSymbol, …), false for the abstract base. */
export function isSemiSymbolType(ctor: Function): boolean {
    return ctor !== SemiSymbol && ctor.prototype instanceof SemiSymbol;
}
