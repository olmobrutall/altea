import { WebBuilder, CustomType, attachmentDisposition } from "@altea/altea/server/webApi";
import { retrieve } from "@altea/altea/server/Database";
import { Entity } from "@altea/altea/data/entity";
import type { Type } from "@altea/altea/data/entity";
import { FileEmbedded, FilePathEmbedded } from "../data/Files";
import { FilePathEmbeddedLogic } from "./FilePathEmbeddedLogic.server";
import { calculateMD5Hash, mimeType } from "./FileTypeAlgorithm.server";

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
//  - Signum's per-file max-age knob lives in FilePathLogic (not ported, it is the FilePathEntity module);
//    altea keeps it here, as `FilesServer.maxAge`, next to the only code that reads it.

export namespace FilesServer {
    let started = false;

    /** Signum's `FilePathLogic.MaxAge` — how long (seconds) a downloaded file may sit in the browser cache;
     *  one month, like Signum. A month is safe because the file's HASH is both in the URL
     *  (`FilesClient.fileUrl`) and in the response ETag: replacing a file's bytes changes its URL, and a
     *  client revalidating a stale copy of the OLD url gets 200 + the new bytes rather than a 304. */
    export let maxAge: (file: FilePathEmbedded | FileEmbedded) => number = () => 30 * 24 * 60 * 60;

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

                // The hash STORED on the row is the ETag, so revalidating a cached copy never touches the
                // store — the 304 is answered before the bytes are read.
                if (cache(req, res, value, value.hash))
                    return;

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

                // A FileEmbedded keeps no hash column (neither does Signum's) — its bytes are already in
                // hand, so hash them now for the ETag.
                if (cache(req, res, value, calculateMD5Hash(value.binaryFile)))
                    return;

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

// Only the bits of express's Request / Response the file routes use (the same duck-typing `fileQuery` uses).
interface FileRequest { headers: Record<string, string | string[] | undefined>; }
interface FileResponse {
    setHeader(name: string, value: string): void;
    status(code: number): { end(): void };
    type(t: string): { send(body: unknown): void };
}

/** Signum's `FilesCacheControl` + the hash half of its download URLs: stamp `Cache-Control` and the file's
 *  `ETag`, and answer `304 Not Modified` when the client already holds those exact bytes. Returns true when
 *  it answered (the caller must not send a body). */
function cache(req: FileRequest, res: FileResponse, file: FilePathEmbedded | FileEmbedded, hash: string | null): boolean {
    res.setHeader("Cache-Control", `private, max-age=${FilesServer.maxAge(file)}`);

    if (hash == null)
        return false;

    // An ETag is a quoted string (RFC 9110 §8.8.3); base64 needs no further escaping inside the quotes.
    const etag = `"${hash}"`;
    res.setHeader("ETag", etag);

    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch == null || !matchesETag(ifNoneMatch, etag))
        return false;

    res.status(304).end();
    return true;
}

// If-None-Match is a comma-separated LIST, and each entry may be a weak validator ("W/…") or the wildcard.
function matchesETag(ifNoneMatch: string | string[], etag: string): boolean {
    const header = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
    return header.split(",")
        .map(t => t.trim())
        .map(t => t.startsWith("W/") ? t.slice(2) : t)
        .some(t => t === "*" || t === etag);
}

function sendFile(res: FileResponse, fileName: string, bytes: Uint8Array): void {
    res.setHeader("Content-Disposition", attachmentDisposition(fileName));
    res.type(mimeType(fileName) ?? "application/octet-stream").send(Buffer.from(bytes));
}
