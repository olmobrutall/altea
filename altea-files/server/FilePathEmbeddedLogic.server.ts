import "@altea/altea/server"; // installs Entity.save()/delete()
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema";
import { FieldEmbedded } from "@altea/altea/server/schema/field";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import type { Entity, Type } from "@altea/altea/data/entity";
import { FilePathEmbedded } from "../data/Files";
import { FileTypeLogic } from "./FileTypeLogic.server";
import type { IFilePath } from "./FileTypeAlgorithm.server";

// Port of Signum.Files' FilePathEmbeddedLogic.cs — the wiring that makes a FilePathEmbedded field behave like
// a file: the bytes are written to its store when the owning entity is saved, and removed from the store when
// the owning row is deleted.
//
// How it finds the fields (Signum's Schema_SchemaCompleted): at `schema.initializing` — once every module has
// included its tables — walk each table's fields for embeddeds of type FilePathEmbedded (recursing into nested
// embeddeds) and register the hooks on that table's type. altea needs no MList handling here: a `@part`
// collection row is its own TABLE with its own events, so a file inside a row is found when that row's table is
// scanned (and `preSaving` fires for every reachable entity — see server/saver.ts).
//
// altea divergences, documented inline:
//  - Signum's `FilePathEmbedded.OnPreSaving` is a static hook on the EMBEDDED type; altea's events are
//    per-entity-type, so the scan above registers one handler per owning type.
//  - Signum splits sync (`SyncFileSave`) and async saving. altea always: assign the suffix + hash SYNCHRONOUSLY
//    in `preSaving` (so the row is INSERTed with its suffix) and write the BYTES on `Transaction.preRealCommit`
//    — so a rolled-back transaction leaves no orphan file (Signum's async mode has the same shape).
//  - Deletion: altea has no per-entity `deleting` event, so the delete signal is the set-based
//    `preUnsafeDelete` (which `entity.delete()` also goes through). The rows about to be deleted are read
//    first, and their files are removed on `postRealCommit` — never before the delete actually commits
//    (Signum's TryDeleteFileOnCommit).

export namespace FilePathEmbeddedLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        FileTypeLogic.start(sb);

        sb.schema.initializing.push(() => {
            for (const [ctor, paths] of filePathFieldsByType(sb.schema)) {
                registerSaveHook(sb, ctor, paths);
                registerDeleteHook(sb, ctor, paths);
            }
        });
    }

    /** Every FilePathEmbedded reachable from `entity` through the given (possibly nested) field paths. */
    export function filesOf(entity: Entity, paths: readonly string[][]): FilePathEmbedded[] {
        const result: FilePathEmbedded[] = [];
        for (const path of paths) {
            const value = readPath(entity, path);
            if (value instanceof FilePathEmbedded)
                result.push(value);
        }
        return result;
    }

    /** Signum's `fpe.SaveFile()` for code that builds a FilePathEmbedded outside the save pipeline. */
    export async function saveFile(fp: FilePathEmbedded): Promise<void> {
        await FileTypeLogic.getAlgorithm(fp.fileType).saveFile(fp as IFilePath);
    }

    /** Signum's `fpe.OpenRead()` / ReadAllBytes — the bytes behind a stored FilePathEmbedded. */
    export async function readAllBytes(fp: FilePathEmbedded): Promise<Uint8Array> {
        return await FileTypeLogic.getAlgorithm(fp.fileType).readAllBytes(fp as IFilePath);
    }

    /** Signum's `TryDeleteFileOnCommit` — remove the stored bytes once the current transaction commits. */
    export function deleteFileOnCommit(fp: FilePathEmbedded): void {
        if (fp.suffix == null)
            return;

        Transaction.postRealCommit(async () => {
            await FileTypeLogic.getAlgorithm(fp.fileType).deleteFilesIfExist([fp as IFilePath]);
        });
    }
}

// ---- hook registration ---------------------------------------------------------------------------------

function registerSaveHook(sb: SchemaBuilder, ctor: Type<Entity>, paths: string[][]): void {
    sb.schema.entityEvents(ctor).preSaving.push(entity => {
        for (const fp of FilePathEmbeddedLogic.filesOf(entity, paths)) {
            // A file that is already stored (has a suffix) and carries no new bytes is untouched.
            if (fp.binaryFile == null || fp.suffix != null)
                continue;

            const algorithm = FileTypeLogic.getAlgorithm(fp.fileType);
            // SYNC: validate + fill suffix/hash/length so the row can be written with them…
            algorithm.prepareSuffix(fp as IFilePath);
            // …and defer the actual bytes to just before the commit (no orphan file if it rolls back).
            Transaction.preRealCommit(async () => {
                await algorithm.writePrepared(fp as IFilePath);
            });
        }
    });
}

function registerDeleteHook(sb: SchemaBuilder, ctor: Type<Entity>, paths: string[][]): void {
    sb.schema.entityEvents(ctor).preUnsafeDelete.push(async query => {
        // Read the rows that are about to go (ungated — this is a cleanup pass, not a user read) and remember
        // their files; they are removed from the store only after the delete commits.
        const doomed = await ExecutionMode.global(async () => await query.toArray() as Entity[]);

        for (const entity of doomed)
            for (const fp of FilePathEmbeddedLogic.filesOf(entity, paths))
                FilePathEmbeddedLogic.deleteFileOnCommit(fp);
    });
}

// ---- schema scan ---------------------------------------------------------------------------------------

/** ctor → the field paths (each a list of field names, nested embeddeds included) holding a FilePathEmbedded. */
function filePathFieldsByType(schema: Schema): Map<Type<Entity>, string[][]> {
    const result = new Map<Type<Entity>, string[][]>();

    for (const table of schema.tables.values()) {
        const paths: string[][] = [];
        collectPaths(table.fields as Record<string, { field: unknown }>, [], paths, new Set());

        if (paths.length > 0)
            result.set(table.type as unknown as Type<Entity>, paths);
    }

    return result;
}

function collectPaths(
    fields: Record<string, { field: unknown }>,
    prefix: string[],
    result: string[][],
    seen: Set<object>,
): void {
    for (const [name, ef] of Object.entries(fields)) {
        const field = ef.field;
        if (!(field instanceof FieldEmbedded))
            continue;

        if (seen.has(field))
            continue;
        seen.add(field);

        const path = [...prefix, name];
        if (isFilePathEmbedded(field))
            result.push(path);
        else
            collectPaths(field.embeddedFields as Record<string, { field: unknown }>, path, result, seen);
    }
}

// A FieldEmbedded knows its columns, not its ctor, so identify the type by its field SHAPE — the four columns
// only FilePathEmbedded has. (Cheaper and more robust than threading the embedded ctor through the schema.)
function isFilePathEmbedded(field: FieldEmbedded): boolean {
    const names = Object.keys(field.embeddedFields);
    return ["fileName", "suffix", "fileLength", "fileType"].every(n => names.includes(n));
}

function readPath(entity: Entity, path: readonly string[]): unknown {
    let current: unknown = entity;
    for (const step of path) {
        if (current == null)
            return undefined;
        current = (current as Record<string, unknown>)[step];
    }
    return current;
}
