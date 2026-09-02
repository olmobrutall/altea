import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { SemiSymbol } from "@altea/altea/data/semiSymbol";
import { entity, implementedByAll, stringLengthValidator, quoted } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import type { IUserEntity } from "@altea/altea/data/security";

// Port of Signum.Notes — a free-text note attached to ANY entity, optionally typed, surfaced as a quick
// link on every type the app says could have one.
//
//
// NoteTypeSymbol is a real SemiSymbol (@altea/altea/data/semiSymbol): a note type may be DECLARED in code
// — then it has a key and SemiSymbolLogic keeps it in step — or created by a USER at runtime, when it has
// only a name and the synchronizer leaves it alone.

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

    // Signum's `Lite<IUserEntity>` — an INTERFACE, so the column is polymorphic (created_by_id_user) and
    // the app pins the implementation; see the same note on AlertEntity.
    createdBy: Lite<IUserEntity>;

    noteType: NoteTypeSymbol | null = null;

    // Signum's `" - ".Combine(Title, Text.FirstNonEmptyLine()).Etc(100)`.
    toString(): string {
        const firstLine = this.text?.split(/\r?\n/).find(l => l.trim() !== "") ?? "";
        const combined = [this.title, firstLine].filter(s => s != null && s !== "").join(" - ");
        return combined.length > 100 ? combined.slice(0, 97) + "..." : combined;
    }
}

/** Signum's NoteTypeSymbol — a SemiSymbol: declared in code (it gets a key) or created by a user (it gets
 *  only a name). @entity("String") because the table IS user-writable, unlike a Symbol's. */
@reflect
@entity("String", "Master")
export class NoteTypeSymbol extends SemiSymbol {
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
