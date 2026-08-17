import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { retrieve } from "@altea/altea/server/Database";
import { Entity } from "@altea/altea/data/entity";
import type { Type } from "@altea/altea/data/entity";
import { FileEmbedded, FilePathEmbedded } from "../data/Files";
import { FilePathEmbeddedLogic } from "./FilePathEmbeddedLogic.server";
import { mimeType } from "./FileTypeAlgorithm.server";

// Port of Signum.Files' FilesController (the download half) + FilesServer.cs. A file is downloaded by naming
// its OWNER — the root entity type + id + the property route to the embedded — never by naming the stored path:
// the server re-reads the embedded from the database, so the entity's own read rules (type auth, row-level
// conditions) gate the download, and a stored suffix is never guessable from the URL.
//
// altea divergences:
//  - Signum also serves the standalone `FileEntity` / `FilePathEntity` rows (`downloadFile` /
//    `downloadFilePath`); those entities are not ported, so only the EMBEDDED routes exist.
//  - Signum parses a full PropertyRoute (with MList rowId support). altea walks the dotted path on the
//    retrieved entity, and a `@part` COLLECTION step is addressed by the row's id via `?rowId=` — one
//    collection level, which is what a file field needs in practice.
//  - Cache-Control: Signum computes a per-file max-age (FilePathLogic.MaxAge). altea marks the response
//    `private, max-age=3600` — a stored file's bytes never change (the suffix carries a GUID).

export namespace FilesServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        // The bytes of a FilePathEmbedded (they live in the file-type's store).
        ws.get("/api/files/downloadEmbeddedFilePath/:rootType/:id",
            { params: CustomType<{ rootType: string; id: string }>() },
            async (req, res) => {
                const { route, rowId } = fileQuery(req);
                const value = await readEmbedded(req.params.rootType, req.params.id, route, rowId);

                if (!(value instanceof FilePathEmbedded))
                    throw new Error(`Route '${route}' does not point to a FilePathEmbedded`);

                const bytes = await FilePathEmbeddedLogic.readAllBytes(value);
                sendFile(res, value.fileName, bytes);
            });

        // The bytes of a FileEmbedded (they live in the row itself).
        ws.get("/api/files/downloadEmbedded/:rootType/:id",
            { params: CustomType<{ rootType: string; id: string }>() },
            async (req, res) => {
                const { route, rowId } = fileQuery(req);
                const value = await readEmbedded(req.params.rootType, req.params.id, route, rowId);

                if (!(value instanceof FileEmbedded))
                    throw new Error(`Route '${route}' does not point to a FileEmbedded`);

                sendFile(res, value.fileName, value.binaryFile);
            });
    }
}

// ---- helpers -------------------------------------------------------------------------------------------

// `route` / `rowId` are plain query-string values (express parses them as `string | ParsedQs | …`), read the
// same way queryServer reads its `token` / `options`.
function fileQuery(req: { query: Record<string, unknown> }): { route: string; rowId: string | undefined } {
    return {
        route: (req.query.route as string | undefined) ?? "",
        rowId: req.query.rowId as string | undefined,
    };
}

// Retrieve the owner (through the normal, GATED retrieve) and walk `route` to the embedded value. A collection
// step consumes `rowId` (the row entity's id).
async function readEmbedded(rootType: string, id: string, route: string, rowId: string | undefined): Promise<unknown> {
    // `Entity.resolveType` is the framework's clean-name resolver and carries the PK statics (the URL id is a
    // string; each type parses its own int / long / uuid id) — the same pair entitiesServer uses.
    const ctor = Entity.resolveType(rootType);
    const entity = await retrieve(ctor as Type<Entity>, ctor.parseId(id));

    let current: unknown = entity;
    for (const step of route.split(/[./]/).filter(s => s.length > 0 && s !== "Item")) {
        if (current == null)
            return undefined;

        if (Array.isArray(current)) {
            if (rowId == null)
                throw new Error(`Route '${route}' crosses a collection: a rowId is required`);
            current = (current as Entity[]).find(e => String(e.id) === String(rowId));
            if (current == null)
                throw new Error(`Row '${rowId}' not found in '${route}'`);
        }

        current = (current as Record<string, unknown>)[step];
    }

    // A trailing collection (the file is ON the row): resolve the row now.
    if (Array.isArray(current) && rowId != null)
        current = (current as Entity[]).find(e => String(e.id) === String(rowId));

    return current;
}

function sendFile(res: { setHeader(name: string, value: string): void; type(t: string): { send(body: unknown): void } }, fileName: string, bytes: Uint8Array): void {
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.type(mimeType(fileName) ?? "application/octet-stream").send(Buffer.from(bytes));
}
