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
import { FieldRoute, isMixinType } from "@altea/altea/data/fieldRoute";
import { storedMemberName } from "@altea/altea/data/propertyRoute";
import type { Quoted } from "quote-transformer/quoted";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { FieldInfo } from "@altea/altea/data/reflection";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { FilePathEmbedded } from "../data/Files";
import type { FileTypeSymbol } from "../data/Files";
import { BigStringMixin } from "../data/BigString";
import { FilePathEmbeddedLogic } from "./FilePathEmbeddedLogic";

// Port of Signum.Files' BigStringLogic.cs — see port/Files.md.
//
// Decides, PER PROPERTY ROUTE, whether a BigStringEmbedded's text lives in its own column or in a file, and
// moves it across when a route is migrated. Readers and writers of `bigString.text` never change: the text
// is written to the file on save and read back on retrieve.
//
// A route must be registered BEFORE its root type is included in the schema, because registration is what
// removes the column the chosen mode does not use (see SchemaSettings.ignoreFieldRoute):
//
//   MixinDeclarations.register(BigStringEmbedded, BigStringMixin);      // once, on BOTH tiers
//   BigStringLogic.register(sb, ExceptionEntity, e => e.stackTrace, new BigStringConfiguration("File", MyFileType.Logs));
//   BigStringLogic.registerAll(sb, ExceptionEntity, new BigStringConfiguration("Database", null));
//   BigStringLogic.start(sb);
//   ... sb.include(ExceptionEntity) ...
//
// The configuration is keyed by the FieldRoute of the BigStringEmbedded in its table's row, and the walk goes
// DOWN from the entity the hook fires on, so nothing has to track an embedded's parent. Writing goes through
// `FilePathEmbeddedLogic.prepareAndWriteOnCommit` — the ONE code path that also serves an ordinary file
// field — and a SUPERSEDED file is deleted on commit rather than left behind.
//
// BigStringMode is a plain string union, not an entity enum: engine configuration, never persisted.

export type BigStringMode =
    /** Text column only — the mixin's file column is not even created. */
    | "Database"
    /** File only — the text column is not created; the text is read back on retrieve. */
    | "File"
    /** Both columns exist; every save moves the text into the file. */
    | "Migrating_FromDatabase_ToFile"
    /** Both columns exist; every save moves the file's text back into the column. */
    | "Migrating_FromFile_ToDatabase";

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

/** One configured route: where its BigStringEmbedded sits in its table's row, and what to do with it. */
interface BigStringRoute {
    readonly route: FieldRoute;
    readonly config: BigStringConfiguration;
}

export namespace BigStringLogic {

    // Keyed by the route's one spelling (FieldRoute.toString); read and written through the route.
    const configurations = new Map<string, BigStringRoute>();

    /** The configuration of one BigStringEmbedded route, if it was registered. */
    export function configurationOf(route: FieldRoute): BigStringConfiguration | undefined {
        return configurations.get(route.toString())?.config;
    }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // The declaration has to happen on BOTH tiers — it is what makes the serializer carry `file` — which
        // is why it is the app's call and not ours.
        if (!MixinDeclarations.isDeclared(BigStringEmbedded, BigStringMixin))
            throw new Error("BigStringLogic.start: BigStringMixin is not declared. Call MixinDeclarations.register(BigStringEmbedded, BigStringMixin) from a "
                + "module BOTH the client and the server load (next to the app's other entity overrides).");

        // The file save / delete plumbing the mixin's `file` rides on.
        FilePathEmbeddedLogic.start(sb);

        sb.schema.initializing.push(() => schemaCompleted(sb.schema));
    }

    /** Configure ONE route. The selector is written INLINE (that is where the transformer stamps its AST) and
     *  may walk EMBEDDEDs and name a mixin (`e => e.requestContext.form`, `e => e.mixin(DiffLogMixin).initialState`). */
    export function register<T extends Entity>(sb: SchemaBuilder, type: Type<T>, selector: Quoted<(entity: T) => BigStringEmbedded>, config: BigStringConfiguration): void {
        registerRoute(sb, FieldRoute.from(type, selector), config);
    }

    /** {@link register} for a route already in hand — what `registerAll` calls, having read the routes off the
     *  model rather than off a lambda. */
    export function registerRoute(sb: SchemaBuilder, route: FieldRoute, config: BigStringConfiguration): void {
        const key = route.toString();

        if (configurations.has(key))
            throw new Error(`BigStringLogic.register: '${key}' is already registered`);

        // Registration removes a COLUMN, so it is too late once the table is generated.
        if (sb.schema.tables.has(route.rootType as Type<Entity>))
            throw new Error(`BigStringLogic.register: ${cleanTypeName(route.rootType as Type<Entity>)} is already included in the Schema. `
                + "Call BigStringLogic.register earlier in your starter, before the type is included.");

        assertBigStringRoute(route);

        // Drop the column this mode does not use. `Database` (the default everywhere) keeps the row column and
        // costs nothing; `File` keeps only the file. A Migrating_* mode needs BOTH.
        if (config.mode === "Database")
            sb.settings.ignoreFieldRoute(route.addLambda((b: BigStringEmbedded) => b.mixin(BigStringMixin).file));
        else if (config.mode === "File")
            sb.settings.ignoreFieldRoute(route.addLambda((b: BigStringEmbedded) => b.text));

        configurations.set(key, { route, config });
    }

    /** Configure EVERY BigStringEmbedded route of `type` the same way. */
    export function registerAll<T extends Entity>(sb: SchemaBuilder, type: Type<T>, config: BigStringConfiguration): void {
        for (const route of bigStringRoutesOf(type))
            registerRoute(sb, route, config);
    }

    /** Re-save every row so the configured mode is applied to its text.
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

    /** Every BigStringEmbedded route in the schema must be configured, and
     *  every configured route must exist — then hook the owning types. */
    function schemaCompleted(schema: Schema): void {
        const inSchema = bigStringRoutesInSchema(schema);

        const present = new Map<string, FieldRoute>();
        for (const routes of inSchema.values())
            for (const route of routes)
                present.set(route.toString(), route);

        const missing = [...present.keys()].filter(k => !configurations.has(k)).sort();
        const extra = [...configurations.keys()].filter(k => !present.has(k)).sort();

        if (missing.length > 0 || extra.length > 0)
            throw new Error("BigStringLogic's configurations are not synchronized with the Schema. In your starter you need to...\n"
                + (extra.length > 0 ? `Remove something like:\n${extra.map(k => example(configurations.get(k)!.route)).join("\n")}\n\n` : "")
                + (missing.length > 0 ? `Add something like:\n${missing.map(k => example(present.get(k)!)).join("\n")}\n\n` : ""));

        for (const [ctor, routes] of inSchema) {
            const configured: BigStringRoute[] = routes.map(route => configurations.get(route.toString())!);

            const events = schema.entityEvents(ctor);
            events.preSaving.push(entity => {
                for (const bsr of configured)
                    preSavingRoute(entity, bsr);
            });
            events.retrieved.push(entity => {
                for (const bsr of configured)
                    postRetrievingRoute(entity, bsr);
            });
        }
    }

    // The registration a missing / extra route would need, as the starter would write it.
    function example(route: FieldRoute): string {
        const body = route.steps.map(s => s.type == "Mixin" ? `.mixin(${s.name})` : `.${s.name}`).join("");
        return `  BigStringLogic.register(sb, ${cleanTypeName(route.rootType as Type<Entity>)}, e => e${body}, new BigStringConfiguration("Database", null));`;
    }
}

// ---- the two lifecycle handlers -------------------------------------------------------------------------

function preSavingRoute(entity: Entity, route: BigStringRoute): void {
    const bs = readBigString(entity, route.route);
    if (bs == null)
        return;

    const mixin = bs.mixin(BigStringMixin);
    const hasText = bs.text != null && bs.text !== "";
    // An embedded with no baseline reads as CLEAN — that is what an absent snapshot means for a
    // Modifiable — so the owner being NEW is the other half of the same question. Without it an INSERT
    // writes no file at all and the text is silently lost.
    const modified = isModifiedSelf(bs) || entity.isNew;

    switch (route.config.mode) {
        case "Database":
            break;

        case "File":
            if (modified)
                writeTextToFile(bs, mixin, route);
            break;

        case "Migrating_FromDatabase_ToFile":
            // Either the text just changed, or this row has never been migrated.
            if (modified || (hasText && mixin.file == null))
                writeTextToFile(bs, mixin, route);
            break;

        case "Migrating_FromFile_ToDatabase":
            // Either the text just changed (the row now wins), or this row still only has the file.
            if (modified || (!hasText && mixin.file != null)) {
                if (!modified && mixin.file != null)
                    bs.text = decodeUtf8(FilePathEmbeddedLogic.readAllBytesSync(mixin.file));

                // Drop the file AND the reference to it, so the row never keeps a suffix pointing at bytes
                // that are gone.
                const previous = mixin.file;
                mixin.file = null;
                if (previous != null)
                    FilePathEmbeddedLogic.deleteFileOnCommit(previous);
            }
            break;
    }
}

/** Substitute the file's content for the text, on retrieve. */
function postRetrievingRoute(entity: Entity, route: BigStringRoute): void {
    const bs = readBigString(entity, route.route);
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

function writeTextToFile(bs: BigStringEmbedded, mixin: BigStringMixin, route: BigStringRoute): void {
    // The file being replaced must be REMOVED, or every save of the property leaves another orphan in the
    // store.
    const previous = mixin.file;

    if (bs.text == null || bs.text === "") {
        mixin.file = null;
    } else {
        const fp = new FilePathEmbedded();
        // The suffix this produces is STORED, and in LEGACY mode has to be the one a Signum store already
        // holds — `InitialState.txt`, not `initialState.txt` — so it is spelled by the same
        // `storedMemberName` a stored property route goes through, never by a second rule that could drift
        // from it.
        fp.fileName = `${storedMemberName(route.route.fieldInfo!.name)}.txt`;
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

/** Every BigStringEmbedded route of a type, from its REFLECTION metadata (used by registerAll, which runs
 *  before the type is in the schema). A mixin's field is reached through its mixin step. */
function bigStringRoutesOf<T extends Entity>(type: Type<T>): FieldRoute[] {
    const result: FieldRoute[] = [];

    const walk = (ctor: Function, route: FieldRoute, seen: Set<Function>): void => {
        if (seen.has(ctor))
            return;
        seen.add(ctor);

        const visit = (owner: Function, ownerRoute: FieldRoute): void => {
            for (const fi of Object.values(getTypeInfo(owner)?.fields ?? {})) {
                if (fi.notMapped || fi.array === true || fi.lite === true)
                    continue;
                if (fi.getTypeName() === "BigStringEmbedded") {
                    result.push(ownerRoute.add(fi.name));
                    continue;
                }
                // Recurse through nested EMBEDDEDS only — a reference starts another table, not this route.
                const nested = fi.getFunction();
                if (nested != null && isEmbeddedCtor(nested))
                    walk(nested, ownerRoute.add(fi.name), seen);
            }
        };

        visit(ctor, route);
        for (const mixinCtor of MixinDeclarations.getMixins(ctor as Type<Entity>))
            if (mixinCtor !== BigStringMixin)
                visit(mixinCtor, route.addMixin(mixinCtor));
    };

    walk(type, FieldRoute.root(type), new Set());
    return result;
}

function assertBigStringRoute(route: FieldRoute): void {
    if (route.fieldInfo?.getTypeName() === "BigStringEmbedded")
        return;
    const candidates = bigStringRoutesOf(route.rootType as Type<Entity>).map(r => r.toString());
    throw new Error(`BigStringLogic: '${route}' is not a BigStringEmbedded member.`
        + (candidates.length > 0 ? ` Candidates: ${candidates.join(", ")}.` : ""));
}

/** ctor → the BigStringEmbedded routes actually PRESENT in the built schema. Identified by the field's
 *  reflected type name (an EntityField keeps its FieldInfo), not by column shape. An embedded's mixin fields
 *  are flattened into it in the schema, so a field declared by a mixin gets its mixin step back from its
 *  FieldInfo — the same route bigStringRoutesOf builds from reflection. */
function bigStringRoutesInSchema(schema: Schema): Map<Type<Entity>, FieldRoute[]> {
    const result = new Map<Type<Entity>, FieldRoute[]>();

    for (const table of schema.tables.values()) {
        const routes: FieldRoute[] = [];
        const root = FieldRoute.root(table.type);
        collectRoutes(table.fields as EntityFieldMap, root, routes);
        for (const [mixinName, mixin] of Object.entries(table.mixins))
            collectRoutes(mixin.fields as EntityFieldMap, root.addMixin(mixinName), routes);

        if (routes.length > 0)
            result.set(table.type as Type<Entity>, routes);
    }

    return result;
}

type EntityFieldMap = Record<string, { field: unknown; fieldInfo: FieldInfo }>;

function collectRoutes(fields: EntityFieldMap, owner: FieldRoute, result: FieldRoute[], inEmbedded = false): void {
    for (const [name, ef] of Object.entries(fields)) {
        if (!(ef.field instanceof FieldEmbedded))
            continue;

        const declaring = ef.fieldInfo.declaringType?.ctor;
        const route = (inEmbedded && isMixinType(declaring) ? owner.addMixin(declaring!) : owner).add(name);
        if (ef.fieldInfo.getTypeName() === "BigStringEmbedded")
            result.push(route);
        else
            collectRoutes(ef.field.embeddedFields as EntityFieldMap, route, result, true);
    }
}

// Mixin fields are inlined onto their owner (`mixin()` returns `this`), so the route's FIELD names are the path.
function readBigString(entity: Entity, route: FieldRoute): BigStringEmbedded | null {
    let current: unknown = entity;
    for (const step of route.fieldPath) {
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
