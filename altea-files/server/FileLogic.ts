import type { SchemaBuilder } from "@altea/altea/server/schema";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { FileEntity } from "../data/Files";
import { calculateMD5Hash } from "./FileTypeAlgorithm";
import { FileTypeLogic } from "./FileTypeLogic";
import { FilePathEmbeddedLogic } from "./FilePathEmbeddedLogic";
import { FilesServer } from "./FilesServer";

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
// the one thing its C# `BinaryFile` setter did that has nowhere else to live: computing the hash (see
// `startFileEntity`). Refusing a change to a SAVED file comes from its base — see
// @altea/altea/data/immutableEntity. Its store-backed sibling FilePathEntity is still not ported (see
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

        // The immutability check itself is NOT registered here: FileEntity derives from ImmutableEntity,
        // and `SchemaBuilder.include` hangs Signum's `ImmutableEntity.PreSaving` on every included
        // subclass — the base carries the guarantee, as it does in Signum. It runs BEFORE the hash
        // handler above, which changes nothing: it reads the change DIFF, and recomputing the hash of
        // UNCHANGED bytes writes the same value back, so an untouched file is clean on either side of it.
        // Re-saving an unchanged file therefore still works, which it has to — the owner's save walks the
        // whole reachable graph, so every owner of a shared file re-saves it.
    }
}
