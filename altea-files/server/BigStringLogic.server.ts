import type { SchemaBuilder, Schema } from "@altea/altea/server/schema";
import { FieldEmbedded } from "@altea/altea/server/schema/field";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Saver } from "@altea/altea/server/saver";
import { table } from "@altea/altea/server/table";
import { retrieveList } from "@altea/altea/server/Database";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import type { Type } from "@altea/altea/data/entity";
import { isModifiedSelf } from "@altea/altea/data/changes";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { cleanTypeName } from "@altea/altea/data/registration";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { FilePathEmbedded } from "../data/Files";
import type { FileTypeSymbol } from "../data/Files";
import { BigStringMixin } from "../data/BigString";
import { FilePathEmbeddedLogic } from "./FilePathEmbeddedLogic.server";

// Port of Signum.Files' BigStringLogic.cs — decides, PER PROPERTY ROUTE, whether a BigStringEmbedded's text
// lives in its own column or in a file, and moves it across when a route is migrated. Readers and writers of
// `bigString.text` never change: the text is written to the file on save and read back on retrieve.
//
// A route must be registered BEFORE its root type is included in the schema, because registration is what
// removes the column the chosen mode does not use (see SchemaSettings.ignoreFieldRoute):
//
//   BigStringMixin.declare();                                       // once, on BOTH tiers
//   BigStringLogic.register(sb, ExceptionEntity, "stackTrace", new BigStringConfiguration("File", MyFileType.Logs));
//   BigStringLogic.registerAll(sb, ExceptionEntity, new BigStringConfiguration("Database", null));
//   BigStringLogic.start(sb);
//   ... sb.include(ExceptionEntity) ...
//
// altea divergences, documented inline:
//  - Signum keys its configuration by PropertyRoute and reaches the owning embedded through
//    `bs.GetParentEntity()` (hence its `[BindParent]` requirement). altea keys by the MEMBER PATH from the
//    root entity and walks DOWN from the entity the hook fires on, so no parent tracking is needed and the
//    `[BindParent]` check has no counterpart.
//  - Signum's mixin overrides PreSaving / PostRetrieving. altea's lifecycle events are per ENTITY TYPE, so
//    the handlers are registered on each OWNING type (the same shape FilePathEmbeddedLogic uses).
//  - Signum writes the file itself; here the created FilePathEmbedded is handed to
//    `FilePathEmbeddedLogic.prepareAndWriteOnCommit`, so the bytes land through the ONE code path that also
//    serves an ordinary file field (suffix + hash assigned now, bytes written just before the commit).
//  - Signum's `RegisterPreUnsafeDelete` has no counterpart: FilePathEmbeddedLogic's own delete hook already
//    finds the mixin's file (altea flattens an embedded's mixin fields into the embedded — see
//    SchemaBuilder.generateEmbedded), so deleting the owner deletes the file.
//  - Signum LEAVES the previous file in place when a route's text is rewritten, and leaves `mixin.File` set
//    after migrating a file back into the database. Both leak a file / dangle a suffix, so this port deletes
//    the superseded file on commit and clears the field.
//  - BigStringMode is a plain string union, not an altea entity enum: it is engine configuration, never
//    persisted (cf. the engine-only enums in server/dynamicQuery).

/** Signum's BigStringMode. */
export type BigStringMode =
    /** Text column only — the mixin's file column is not even created. */
    | "Database"
    /** File only — the text column is not created; the text is read back on retrieve. */
    | "File"
    /** Both columns exist; every save moves the text into the file. */
    | "Migrating_FromDatabase_ToFile"
    /** Both columns exist; every save moves the file's text back into the column. */
    | "Migrating_FromFile_ToDatabase";

/** Signum's BigStringConfiguration. */
export class BigStringConfiguration {
    constructor(
        readonly mode: BigStringMode,
        /** The store the text file goes to. Required for every mode except `Database`. */
        readonly fileType: FileTypeSymbol | null,
    ) {
        if (mode !== "Database" && fileType == null)
            throw new Error(`BigStringConfiguration: mode '${mode}' requires a fileType`);
    }
}

/** One configured route: where its BigStringEmbedded sits inside the root entity, and what to do with it. */
interface BigStringRoute {
    readonly path: string[];
    readonly config: BigStringConfiguration;
}

export namespace BigStringLogic {

    /** Signum's `BigStringLogic.Configurations`, keyed by "<CleanRootType>.<member path>". */
    export const configurations: Map<string, { type: Type<Entity>; path: string[]; config: BigStringConfiguration }> = new Map();

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's `MixinDeclarations.AssertDeclared(typeof(BigStringEmbedded), typeof(BigStringMixin))`. The
        // declaration has to happen on BOTH tiers (it is what makes the serializer carry `file`), which is why
        // it is the app's call and not ours.
        if (!BigStringMixin.isDeclared())
            throw new Error("BigStringLogic.start: BigStringMixin is not declared. Call BigStringMixin.declare() from a "
                + "module BOTH the client and the server load (next to the app's other entity overrides).");

        // The file save / delete plumbing the mixin's `file` rides on.
        FilePathEmbeddedLogic.start(sb);

        sb.schema.initializing.push(() => schemaCompleted(sb.schema));
    }

    /** Signum's `Register(sb, (T a) => a.BigString, config)` — configure ONE route. `memberPath` is dotted
     *  ("requestContext.form"); it must name a BigStringEmbedded member of `type`. */
    export function register<T extends Entity>(sb: SchemaBuilder, type: Type<T>, memberPath: string, config: BigStringConfiguration): void {
        const key = routeKey(type, memberPath);

        if (configurations.has(key))
            throw new Error(`BigStringLogic.register: '${key}' is already registered`);

        // Signum's same guard: registration removes a COLUMN, so it is too late once the table is generated.
        if (sb.schema.tables.has(type as unknown as Type<Entity>))
            throw new Error(`BigStringLogic.register: ${cleanTypeName(type)} is already included in the Schema. `
                + "Call BigStringLogic.register earlier in your starter, before the type is included.");

        assertBigStringRoute(type, memberPath.split("."));

        // Drop the column this mode does not use. `Database` (the default everywhere) keeps the row column and
        // costs nothing; `File` keeps only the file. A Migrating_* mode needs BOTH.
        if (config.mode === "Database")
            sb.settings.ignoreFieldRoute(type as unknown as Type<Entity>, `${memberPath}.file`);
        else if (config.mode === "File")
            sb.settings.ignoreFieldRoute(type as unknown as Type<Entity>, `${memberPath}.text`);

        configurations.set(key, { type: type as unknown as Type<Entity>, path: memberPath.split("."), config });
    }

    /** Signum's `RegisterAll<T>` — configure EVERY BigStringEmbedded route of `type` the same way. */
    export function registerAll<T extends Entity>(sb: SchemaBuilder, type: Type<T>, config: BigStringConfiguration): void {
        for (const path of bigStringRoutesOf(type))
            register(sb, type, path.join("."), config);
    }

    /** Signum's `MigrateBigStrings<T>` — re-save every row so the configured mode is applied to its text.
     *  Batched, and one transaction per batch (a migration of a large table must not be one giant write). */
    export async function migrateBigStrings<T extends Entity>(type: Type<T>, batchSize = 100): Promise<void> {
        const ids = await ExecutionMode.global(async () => await table(type).map(e => e.id).toArray());

        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            await Transaction.forceNew(async () => {
                const rows = await ExecutionMode.global(async () => await retrieveList(type, batch));
                await Saver.save(rows);
            });
        }
    }

    /** Signum's Schema_SchemaCompleted: every BigStringEmbedded route in the schema must be configured, and
     *  every configured route must exist — then hook the owning types. */
    function schemaCompleted(schema: Schema): void {
        const inSchema = bigStringFieldsByType(schema);

        const present = new Set<string>();
        for (const [ctor, paths] of inSchema)
            for (const path of paths)
                present.add(`${cleanTypeName(ctor)}.${path.join(".")}`);

        const example = (key: string): string =>
            `  BigStringLogic.register(sb, ${key.substring(0, key.indexOf("."))}, "${key.substring(key.indexOf(".") + 1)}", `
            + `new BigStringConfiguration("Database", null));`;

        const missing = [...present].filter(k => !configurations.has(k)).sort();
        const extra = [...configurations.keys()].filter(k => !present.has(k)).sort();

        if (missing.length > 0 || extra.length > 0)
            throw new Error("BigStringLogic's configurations are not synchronized with the Schema. In your starter you need to...\n"
                + (extra.length > 0 ? `Remove something like:\n${extra.map(example).join("\n")}\n\n` : "")
                + (missing.length > 0 ? `Add something like:\n${missing.map(example).join("\n")}\n\n` : ""));

        for (const [ctor, paths] of inSchema) {
            const routes: BigStringRoute[] = paths.map(path => ({
                path,
                config: configurations.get(`${cleanTypeName(ctor)}.${path.join(".")}`)!.config,
            }));

            const events = schema.entityEvents(ctor);
            events.preSaving.push(entity => {
                for (const route of routes)
                    preSavingRoute(entity, route);
            });
            events.retrieved.push(entity => {
                for (const route of routes)
                    postRetrievingRoute(entity, route);
            });
        }
    }
}

// ---- the two lifecycle handlers (Signum's PreSaving / PostRetrieving) -----------------------------------

/** Signum's `BigStringLogic.PreSaving` for one route. */
function preSavingRoute(entity: Entity, route: BigStringRoute): void {
    const bs = readBigString(entity, route.path);
    if (bs == null)
        return;

    const mixin = bs.mixin(BigStringMixin);
    const hasText = bs.text != null && bs.text !== "";

    switch (route.config.mode) {
        case "Database":
            break;

        case "File":
            if (isModifiedSelf(bs))
                writeTextToFile(bs, mixin, route);
            break;

        case "Migrating_FromDatabase_ToFile":
            // Either the text just changed, or this row has never been migrated.
            if (isModifiedSelf(bs) || (hasText && mixin.file == null))
                writeTextToFile(bs, mixin, route);
            break;

        case "Migrating_FromFile_ToDatabase":
            // Either the text just changed (the row now wins), or this row still only has the file.
            if (isModifiedSelf(bs) || (!hasText && mixin.file != null)) {
                if (!isModifiedSelf(bs) && mixin.file != null)
                    bs.text = decodeUtf8(FilePathEmbeddedLogic.readAllBytesSync(mixin.file));

                // DIVERGENCE (Signum leaves the field set): drop the file AND the reference to it, so the row
                // never keeps a suffix pointing at bytes that are gone.
                const previous = mixin.file;
                mixin.file = null;
                if (previous != null)
                    FilePathEmbeddedLogic.deleteFileOnCommit(previous);
            }
            break;
    }
}

/** Signum's `BigStringLogic.PostRetrieving` for one route — substitute the file's content for the text. */
function postRetrievingRoute(entity: Entity, route: BigStringRoute): void {
    const bs = readBigString(entity, route.path);
    if (bs == null)
        return;

    const file = bs.mixin(BigStringMixin).file;

    switch (route.config.mode) {
        case "Database":
            break;

        case "File":
            bs.text = file == null ? null : decodeUtf8(FilePathEmbeddedLogic.readAllBytesSync(file));
            break;

        case "Migrating_FromDatabase_ToFile":
            // The file is authoritative once it exists.
            if (file != null)
                bs.text = decodeUtf8(FilePathEmbeddedLogic.readAllBytesSync(file));
            break;

        case "Migrating_FromFile_ToDatabase":
            // The column is authoritative once it has been filled.
            if (bs.text == null && file != null)
                bs.text = decodeUtf8(FilePathEmbeddedLogic.readAllBytesSync(file));
            break;
    }
}

/** Signum's `mixin.File = new FilePathEmbedded(fileType, <member> + ".txt", UTF8(text))`. */
function writeTextToFile(bs: BigStringEmbedded, mixin: BigStringMixin, route: BigStringRoute): void {
    // DIVERGENCE (Signum just overwrites the field): the file being replaced must be removed, or every save
    // of the property leaves another orphan in the store.
    const previous = mixin.file;

    if (bs.text == null || bs.text === "") {
        mixin.file = null;
    } else {
        const fp = new FilePathEmbedded();
        fp.fileName = `${route.path[route.path.length - 1]}.txt`;
        fp.binaryFile = encodeUtf8(bs.text);
        fp.fileType = route.config.fileType!;
        // Assign the suffix NOW and write the bytes just before the commit. Doing it here rather than leaving
        // it to FilePathEmbeddedLogic's own save hook makes this independent of hook order: whichever runs
        // first, the other one sees a file that already has a suffix and skips it.
        FilePathEmbeddedLogic.prepareAndWriteOnCommit(fp);
        mixin.file = fp;
    }

    if (previous != null && previous !== mixin.file)
        FilePathEmbeddedLogic.deleteFileOnCommit(previous);
}

// ---- route discovery -----------------------------------------------------------------------------------

function routeKey<T extends Entity>(type: Type<T>, memberPath: string): string {
    return `${cleanTypeName(type)}.${memberPath}`;
}

/** Every BigStringEmbedded member path of a type, from its REFLECTION metadata (used by registerAll, which
 *  runs before the type is in the schema). */
function bigStringRoutesOf<T extends Entity>(type: Type<T>): string[][] {
    const result: string[][] = [];

    const walk = (ctor: Function, prefix: string[], seen: Set<Function>): void => {
        if (seen.has(ctor))
            return;
        seen.add(ctor);

        const typeInfo = getTypeInfo(ctor);
        if (typeInfo == null)
            return;

        for (const fi of Object.values(typeInfo.fields)) {
            if (fi.notMapped || fi.array === true || fi.lite === true)
                continue;
            if (fi.getTypeName() === "BigStringEmbedded") {
                result.push([...prefix, fi.name]);
                continue;
            }
            // Recurse through nested EMBEDDEDS only — a reference starts another root, not this route.
            const nested = fi.getFunction();
            if (nested != null && isEmbeddedCtor(nested))
                walk(nested, [...prefix, fi.name], seen);
        }
    };

    walk(type as unknown as Function, [], new Set());
    return result;
}

function assertBigStringRoute<T extends Entity>(type: Type<T>, path: string[]): void {
    const routes = bigStringRoutesOf(type).map(p => p.join("."));
    if (!routes.includes(path.join(".")))
        throw new Error(`BigStringLogic: '${cleanTypeName(type)}.${path.join(".")}' is not a BigStringEmbedded member.`
            + (routes.length > 0 ? ` Candidates: ${routes.join(", ")}.` : ""));
}

/** ctor → the BigStringEmbedded member paths actually PRESENT in the built schema. Identified by the field's
 *  reflected type name (an EntityField keeps its FieldInfo), not by column shape. */
function bigStringFieldsByType(schema: Schema): Map<Type<Entity>, string[][]> {
    const result = new Map<Type<Entity>, string[][]>();

    for (const table of schema.tables.values()) {
        const paths: string[][] = [];
        collectPaths(table.fields as EntityFieldMap, [], paths);
        for (const mixin of Object.values(table.mixins))
            collectPaths(mixin.fields as EntityFieldMap, [], paths);

        if (paths.length > 0)
            result.set(table.type as unknown as Type<Entity>, paths);
    }

    return result;
}

type EntityFieldMap = Record<string, { field: unknown; fieldInfo: { getTypeName(): string | undefined } }>;

function collectPaths(fields: EntityFieldMap, prefix: string[], result: string[][]): void {
    for (const [name, ef] of Object.entries(fields)) {
        if (!(ef.field instanceof FieldEmbedded))
            continue;

        const path = [...prefix, name];
        if (ef.fieldInfo.getTypeName() === "BigStringEmbedded")
            result.push(path);
        else
            collectPaths(ef.field.embeddedFields as EntityFieldMap, path, result);
    }
}

// ---- small helpers -------------------------------------------------------------------------------------

function readBigString(entity: Entity, path: readonly string[]): BigStringEmbedded | null {
    let current: unknown = entity;
    for (const step of path) {
        if (current == null)
            return null;
        current = (current as Record<string, unknown>)[step];
    }
    return current instanceof BigStringEmbedded ? current : null;
}

function isEmbeddedCtor(ctor: Function): boolean {
    return ctor === EmbeddedEntity || ctor.prototype instanceof EmbeddedEntity;
}

function encodeUtf8(text: string): Uint8Array {
    return new Uint8Array(Buffer.from(text, "utf8"));
}

function decodeUtf8(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("utf8");
}
