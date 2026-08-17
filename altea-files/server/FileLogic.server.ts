import type { SchemaBuilder } from "@altea/altea/server/schema";
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
// altea divergence: Signum's `FileLogic.Start` also includes the standalone FileEntity / FilePathEntity tables
// (not ported — see server/FilesServer.server.ts) and BigStringLogic (altea's BigStringEmbedded needs none).

export namespace FileLogic {
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        FileTypeLogic.start(sb);
        FilePathEmbeddedLogic.start(sb);

        if (sb.webBuilder)
            FilesServer.start(sb.webBuilder);
    }
}
