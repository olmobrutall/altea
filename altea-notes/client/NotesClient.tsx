import { Navigator } from "@altea/altea/client/Navigator";
import { isNotPart } from "@altea/altea/data/reflection";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import { QuickLinkClient, QuickLinkExplore } from "@altea/altea/client/QuickLinkClient";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { NoteEntity, NoteTypeSymbol, NoteOperation } from "../data/Notes";

// Port of Signum.Notes/NotesClient.tsx — the note view, the "create a note about this" operation button
// (whose visibility is per SOURCE type) and the global quick link that lists an entity's notes.
//
// altea divergence: `Navigator.addSettings(new EntitySettings(...))` → the ClientBuilder's
// `cb.configure(X).withView(...)`, and `couldHaveNotes` reads a constructor's name rather than Signum's
// `Type` string — the same shape @altea/altea-alert's showAlerts uses.

export namespace NotesClient {

    export function start(cb: ClientBuilder, options?: {
        couldHaveNotes?: (typeName: string) => boolean;
    }): void {

        const couldHaveNotes = options?.couldHaveNotes ?? ((): boolean => true);

        cb.configure(NoteEntity)
            .withView(() => import("./Templates/Note"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(n => n.id),
                    token(n => n.createdBy),
                    token(n => n.creationDate),
                    token(n => n.title),
                    token(n => n.text),
                    token(n => n.target),
                ],
            }));

        cb.configure(NoteTypeSymbol)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(t => t.id),
                    token(t => t.name),
                    token(t => t.key),
                ],
            }));

        // "Write a note about this entity" — the button lives on the SOURCE type, so its visibility is
        // per type (Signum's couldHaveNotes). Registered on `Entity`, so a part row inherits it too; a
        // note is about its owner (`isVisibleForType`).
        Operations.addSettings(new EntityOperationSettings(NoteOperation.CreateNoteFromEntity, {
            isVisibleForType: isNotPart,
            isVisible: ctx => couldHaveNotes(ctx.entity.constructor.name),
            icon: "note-sticky",
            iconColor: "#0e4f8c",
            color: "info",
            contextual: { isVisible: ctx => couldHaveNotes(ctx.context.lites[0]!.entityType.name) },
        }));

        if (Navigator.isViewable(NoteEntity))
            QuickLinkClient.registerGlobalQuickLink(entityType => Promise.resolve([
                new QuickLinkExplore(NoteEntity,
                    ctx => NoteEntity.findOptions(token => ({
                        filterOptions: [{ token: token(n => n.target), value: ctx.lite }],
                    })),
                    {
                        isVisible: couldHaveNotes(entityType),
                        icon: "note-sticky",
                        iconColor: "#337ab7",
                    }),
            ]));
    }
}
