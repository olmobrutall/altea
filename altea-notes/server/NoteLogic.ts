import "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import { table } from "@altea/altea/server/table";
import { Lite } from "@altea/altea/data/lite";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { IQuery } from "@altea/altea/data/iquery";
import { withQuoted } from "@altea/altea/data/decorators";
import { Clock } from "@altea/altea/data/utils/clock";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SemiSymbolLogic } from "@altea/altea/server/semiSymbolLogic";
import { Operations } from "@altea/altea/server/operationLogic";
import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserEntity } from "@altea/altea-auth/data/User";
import { NoteEntity, NoteTypeSymbol, NoteOperation, NoteTypeOperation } from "../data/Notes";

// Port of Signum.Notes/NoteLogic.cs.
//
// altea divergences:
//  - `Notes()` is an `[AutoExpressionField]` extension method on Entity there; here a `withQuoted`
//    PROTOTYPE member plus a per-CONCRETE-TYPE expression registration. altea keys an extension token on a
//    constructor and the token walk follows the concrete prototype chain, so hanging it off `Entity` would
//    reach nothing — the same accommodation @altea/altea-view-log and @altea/altea-alert make.
//  - `SemiSymbolLogic<NoteTypeSymbol>.Start(sb, () => SystemNoteTypes)` → altea's own SemiSymbolLogic,
//    which keeps Signum's crucial rule: only rows WITH a key take part in the sync, so a note type a user
//    created is never deleted by it.
//  - `RegisterUserTypeCondition` uses `TypeConditionLogic.registerCompile`, altea's same call.

export namespace NoteLogic {

    let started = false;

    export function start(sb: SchemaBuilder, options?: { registerExpressionsFor?: Type<Entity>[] }): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(NoteEntity)
            .withSave(NoteOperation.Save, {})
            .withQuery()
            .withConstructFrom(Entity, NoteOperation.CreateNoteFromEntity, {
                construct: async (source: Entity) => {
                    const note = NoteEntity.create({ creationDate: Clock.now, target: source.toLite() });
                    return note;
                },
            });

        sb.include(NoteTypeSymbol)
            .withSave(NoteTypeOperation.Save, {})
            .withQuery();

        SemiSymbolLogic.start(sb, NoteTypeSymbol);

        // Signum registers ONE ExtensionInfo per requested type; altea needs the same, per concrete type.
        for (const type of options?.registerExpressionsFor ?? [])
            QueryLogic.expressions.register(type, (e: Entity) => e.entityNotes!(),
                { key: "Notes", niceName: () => NoteEntity.nicePluralName() });

        started = true;
    }

    /** Signum's `RegisterNoteType` — a note type must be code-declared (see the data header). */
    export function registerNoteType(noteType: NoteTypeSymbol): void {
        if (!noteType.key)
            throw new Error("noteType must have a key — declare it with init() inside a namespace");
        // A plain Symbol is already collected by its declaration; this only asserts the key, which is what
        // Signum's SystemNoteTypes set does for the ones IT synchronizes.
    }

    /**
     * Signum's `CreateNote(entity, text, noteType, user?, title?)` — answers null when the module was never
     * started, exactly as Signum does, so an app can call it unconditionally.
     */
    export async function createNote(
        target: Lite<Entity>,
        text: string,
        noteType: NoteTypeSymbol,
        user?: Lite<UserEntity> | null,
        title?: string | null,
    ): Promise<NoteEntity | null> {
        if (!started)
            return null;

        const note = NoteEntity.create({
            createdBy: user ?? UserHolder.currentUserLite() as Lite<UserEntity>,
            text,
            title: title ?? null,
            target,
            noteType,
        });

        await Operations.execute(note, NoteOperation.Save);
        return note;
    }
}

// Signum's `NoteLogic.Notes(this Entity ident)` — every note pointing at this entity. A `withQuoted`
// prototype member on Entity, so any type can carry it; which types OFFER it as a token is decided by the
// per-type registration in `start`.
//
// It is called `entityNotes`, not `notes`, because an EXTENSION METHOD occupies no name on the type while a
// prototype member does — and a real entity already has the obvious one (eastwind's EmployeeEntity.notes is
// Northwind's employee notes column). The query TOKEN is still Signum's "Notes": the registration names it
// explicitly, so the member's own name never reaches the query surface.
declare module "@altea/altea/data/entity" {
    interface Entity {
        entityNotes?(): IQuery<NoteEntity>;
    }
}

Entity.prototype.entityNotes = withQuoted(function (this: Entity): IQuery<NoteEntity> {
    return table(NoteEntity).filter(n => n.target.is(this));
});
