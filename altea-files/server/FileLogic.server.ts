import type { SchemaBuilder } from "@altea/altea/server/schema";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { FileEntity } from "../data/Files";
import { calculateMD5Hash } from "./FileTypeAlgorithm.server";
import { FileTypeLogic } from "./FileTypeLogic.server";
import { FilePathEmbeddedLogic } from "./FilePathEmbeddedLogic.server";
import { FilesServer } from "./FilesServer.server";

// Port of Signum.Files' FileLogic.cs / FilePathEmbeddedLogic.Start pairing — the ONE call an app makes to get
// files working (Southwind's `FilePathEmbeddedLogic.Start(sb)` + `FileLogic.Start(sb)`):
//   • the FileTypeSymbol table + the algorithm registry (FileTypeLogic),
//   • the save / delete hooks on every entity holding a FilePathEmbedded (FilePathEmbeddedLogic),
//   • the download routes, when a web host is present (FilesServer).
//
// The app then registers ONE algorithm per file type it declares:
//   FileTypeLogic.register(MyFileType.Attachments, new FileTypeAlgorithm({ physicalPrefix: () => "./files/attachments" }));
//
// FileEntity — the shared, own-row file — is included here exactly as Signum's FileLogic.Start does, with
// the two things its C# property setters did (compute the hash, refuse a change to a saved row) hung on the
// schema events; see `startFileEntity`. Its store-backed sibling FilePathEntity is still not ported (see
// data/Files.ts).
//
// BigStringLogic (redirecting a BigStringEmbedded's text into a file) is deliberately NOT started here, as in
// Signum: it needs the app to declare the mixin and configure every BigStringEmbedded route first, so an app
// that only wants file FIELDS must not pay for it. See server/BigStringLogic.server.ts.

export namespace FileLogic {
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        FileTypeLogic.start(sb);
        FilePathEmbeddedLogic.start(sb);
        startFileEntity(sb);

        if (sb.webBuilder)
            FilesServer.start(sb.webBuilder);
    }

    /**
     * Signum's `sb.Include<FileEntity>().WithQuery(...)`, plus the two halves of its entity that altea
     * cannot express as property setters.
     */
    function startFileEntity(sb: SchemaBuilder): void {
        // Signum's projection is (Entity, Id, FileName). altea's server registration takes none (no
        // QueryDescription), so those are CLIENT default columns — see client/FilesClient.
        sb.include(FileEntity).withQuery();

        const events = sb.schema.entityEvents(FileEntity);

        events.preSaving.push(file => {
            // Signum's `BinaryFile` SETTER: the hash follows the bytes, always, so it can never disagree
            // with them. Computed here because the isomorphic layer has no crypto.
            file.prepareForSave(calculateMD5Hash(file.binaryFile ?? new Uint8Array(0)));
        });

        events.preSaving.push(file => {
            // Signum's ImmutableEntity.PreSaving, one for one: it throws "Attempt to save a not new
            // modified ImmutableEntity" when `Modified == ModifiedState.SelfModified`, and
            // `isModifiedSelf()` IS that state (a value diff against the row's snapshot). This is the half
            // of that base class which actually protects the data — see data/Files.ts on why the setter
            // half is neither portable nor missed. The reason for the rule is the sharing: a file row may
            // have SEVERAL owners, so changing its bytes changes the file under every one of them.
            //
            // Ordering matters, and it works out: the hash handler above ran FIRST, and for an untouched
            // file it recomputes the SAME hash — a value-equal write leaves the snapshot diff clean, so it
            // cannot make an unchanged file look modified. Re-saving an unchanged file is therefore fine,
            // which it has to be: the owner's save walks the whole reachable graph.
            if (!file.isNew && file.isModifiedSelf())
                throw new Error(`Attempt to save a not new modified FileEntity (${file.id}): a stored file `
                    + `is immutable, because it may be referenced by several owners. Assign a NEW `
                    + `FileEntity to the field instead of changing this one.`);
        });
    }
}
