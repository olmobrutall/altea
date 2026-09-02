import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Symbol } from "@altea/altea/data/symbol";
import { entity, implementedByAll, stringLengthValidator, quoted } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";

// Port of Signum.Notes — a free-text note attached to ANY entity, optionally typed, surfaced as a quick
// link on every type the app says could have one.
//
// altea divergences:
//  - **NoteTypeSymbol is a plain Symbol, not a SemiSymbol** — altea has none, the same call
//    @altea/altea-alert made for AlertTypeSymbol and @altea/altea-agent for AgentSymbol. A note type is
//    therefore DECLARED IN CODE (NoteLogic.registerNoteType) and cannot be created by a user at runtime,
//    which is what Signum's SemiSymbol adds over a Symbol.
//    The `name` field is kept even so, because it is a real column of Signum's note_type table and a
//    database migrated from Signum carries values in it. Consequence worth knowing before pointing altea
//    at such a database: altea's SymbolLogic synchronizes symbols BY KEY and deletes a row whose key is no
//    longer declared, so a note type a Signum USER created (name, no key) would be dropped by a sync.
//  - `Lite<IUserEntity>` → `Lite<UserEntity>`: altea has no IUserEntity interface, and altea-auth's user
//    is the only implementation (the same substitution every other module makes).

@reflect
@entity("Main", "Transactional")
export class NoteEntity extends Entity {

    @stringLengthValidator({ max: 100 })
    title: string | null = null;

    // Signum's `[ImplementedByAll] Lite<Entity> Target` — a note can hang off anything.
    @implementedByAll
    target: Lite<Entity>;

    creationDate: Temporal.PlainDateTime = Clock.now;

    @stringLengthValidator({ min: 1, multiLine: true })
    text: string;

    createdBy: Lite<UserEntity>;

    noteType: NoteTypeSymbol | null = null;

    // Signum's `" - ".Combine(Title, Text.FirstNonEmptyLine()).Etc(100)`.
    toString(): string {
        const firstLine = this.text?.split(/\r?\n/).find(l => l.trim() !== "") ?? "";
        const combined = [this.title, firstLine].filter(s => s != null && s !== "").join(" - ");
        return combined.length > 100 ? combined.slice(0, 97) + "..." : combined;
    }
}

/** Signum's NoteTypeSymbol (a SemiSymbol there — see the header). */
@reflect
@entity("String", "Master")
export class NoteTypeSymbol extends Symbol {

    /** Signum's SemiSymbol.Name — the editable display name. Kept for column compatibility; a
     *  code-declared type gets it from `registerNoteType`. */
    @stringLengthValidator({ max: 100 })
    name: string | null = null;
}

/** Signum's `[AutoInit] NoteOperation`. */
export namespace NoteOperation {
    export const CreateNoteFromEntity: ConstructSymbol<NoteEntity, From<Entity>> = init();
    export const Save: ExecuteSymbol<NoteEntity> = init();
}

/** Signum's `[AutoInit] NoteTypeOperation`. */
export namespace NoteTypeOperation {
    export const Save: ExecuteSymbol<NoteTypeSymbol> = init();
}

export const NoteMessage = {
    NewNote: msg("New Note"),
    Note: msg("Note:"),
    _note: msg("note"),
    _notes: msg("notes"),
    CreateNote: msg(),
    NoteCreated: msg(),
    Notes: msg(),
    ViewNotes: msg(),
};

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("notes")]`.
setDefaultDatabaseSchema("notes");
