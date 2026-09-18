import { hostname } from "node:os";
import { Temporal, type int } from "../data/basics";
import type { Entity, Type } from "../data/entity";
import { ExceptionEntity, ExceptionOrigin } from "../data/exception";
// The parameter types have no table of their own (their owner is an application's, see data/deleteLogs.ts),
// so nothing else would load the module — and an unloaded module registers no type, which costs it its
// reflection and its translations.
import "../data/deleteLogs";
import type { DeleteLogParametersEmbedded } from "../data/deleteLogs";
import type { ClientErrorModel } from "../data/clientError";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import { Saver } from "./saver";
import { Transaction } from "./connection/transaction";
import { Connector } from "./connection/connector";
import { ExecutionMode } from "./executionMode";
import { table } from "./table";
import type { Query } from "./query";
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery

// Port of Signum's ExceptionLogic (old/Framework/Signum/Basics/ExceptionLogic.cs), trimmed to the
// pieces eastwind needs: schema registration, the `logException` extension that builds, fills and
// persists an ExceptionEntity, and the log-cleanup registry + runner below. Deferred (as in Signum but
// not needed yet): OnExceptionLogged event, per-environment overrides, and the User/auth wiring.
//
// The engine ownership is the same as Signum: an error anywhere on the server is turned into a row
// here by the API exception filter (exceptionFilter.ts, Signum's SignumExceptionFilterAttribute).

// Where an in-flight Error stashes its already-built ExceptionEntity, so a second handler (the
// HttpError factory) reuses the same row / id instead of logging twice. Signum uses
// `ex.Data[ExceptionEntity.ExceptionDataKey]`; JS Errors have no `.Data`, so a symbol property.
const ExceptionDataKey = Symbol.for("altea:exceptionEntity");

export namespace ExceptionLogic {
    export function start(sb: SchemaBuilder): void {
        // Signum: sb.Include<ExceptionEntity>() + WithQuery(...). altea's WithQuery is parameterless.
        // Signum's `.WithIndex(a => a.CreationDate)` — the exception page is browsed newest-first.
        sb.include(ExceptionEntity).withIndex(a => a.creationDate).withQuery();
    }

    // ---- Log cleanup ------------------------------------------------------------------------------------
    //
    // Signum's `ExceptionLogic.DeleteLogs` event (`+= ExceptionLogic_DeleteLogs`), which is the seam that
    // lets a module trim ITS OWN log table without core ever naming it — core holds the list, each module
    // pushes onto it from its `start`, and `deleteLogsAndExceptions` walks it.

    /** What a handler writes progress to and watches for cancellation. `ScheduledTaskContext` satisfies
     *  it structurally, so the scheduled task hands its own context straight through. */
    export interface DeleteLogsContext {
        writeLine(line: string): void;
        readonly signal: AbortSignal;
    }

    export type DeleteLogsHandler = (parameters: DeleteLogParametersEmbedded, ctx: DeleteLogsContext) => Promise<void>;

    const deleteLogsHandlers: DeleteLogsHandler[] = [];

    /** Trim this module's log table when the cleanup runs. */
    export function registerDeleteLogs(handler: DeleteLogsHandler): void {
        deleteLogsHandlers.push(handler);
    }

    /**
     * One run of the cleanup: every registered handler, then the exceptions themselves.
     *
     * The exceptions go LAST and only once nothing points at them any more, which is what
     * `ExceptionEntity.referenced` is for — it is recomputed here rather than maintained on write:
     * blanked, then set again from every column in the schema that is a foreign key to the exception
     * table. A handler that hit its `maxChunks` budget leaves rows behind, so their exceptions stay
     * referenced and survive this run; the next one takes them.
     *
     * `Transaction.none`, deliberately: each chunk has to COMMIT, or the whole point of chunking (a short
     * lock, released between bites) is lost to one transaction that holds every row it deleted.
     */
    export async function deleteLogsAndExceptions(parameters: DeleteLogParametersEmbedded, ctx: DeleteLogsContext): Promise<void> {
        await ExecutionMode.global(() => Transaction.none(async () => {
            for (const handler of deleteLogsHandlers) {
                ctx.signal.throwIfAborted();
                await handler(parameters, ctx);
            }

            await writeRows(ctx, "Updating ExceptionEntity.referenced = false",
                () => table(ExceptionEntity).executeUpdate(_ => ({ referenced: false })));

            await markReferencedExceptions(ctx);

            ctx.signal.throwIfAborted();

            const dateLimit = parameters.getDateLimitDelete(ExceptionEntity.toTypeEntity());
            if (dateLimit != null)
                await deleteChunksLog(ExceptionEntity, table(ExceptionEntity)
                    .filter(e => !e.referenced && Temporal.PlainDateTime.compare(e.creationDate, dateLimit) < 0),
                    parameters, ctx);
        }));
    }

    /**
     * The chunked delete every handler runs its query through: Signum's `UnsafeDeleteChunksLog`, which is
     * `UnsafeDeleteChunks` plus the line it writes into the task's remarks.
     */
    export async function deleteChunksLog<T extends Entity>(type: Type<T>, query: Query<T>,
        parameters: DeleteLogParametersEmbedded, ctx: DeleteLogsContext): Promise<void> {
        await writeRows(ctx, `Deleting ${type.name}`, () =>
            query.executeDeleteChunks(parameters.chunkSize, parameters.maxChunks, parameters.pauseTime, ctx.signal));
    }

    // Signum's WriteRows: run the statement, report rows + elapsed.
    async function writeRows(ctx: DeleteLogsContext, text: string, makeQuery: () => Promise<number>): Promise<void> {
        const start = performance.now();
        const rows = await makeQuery();
        ctx.writeLine(`${text}: ${rows} rows affected in ${Math.round(performance.now() - start)} ms`);
    }

    // Set `referenced` on every exception some other row still points at. Signum emits one
    // `UPDATE ex … FROM <table> JOIN` per referencing column; altea uses the `IN (SELECT …)` form of the
    // same statement, which needs no dialect branch (SQL Server and PostgreSQL spell UPDATE…JOIN
    // differently, as primaryKeyUpdater has to).
    async function markReferencedExceptions(ctx: DeleteLogsContext): Promise<void> {
        const connector = Connector.current();
        const schema = connector.schema;
        const exceptionTable = schema.tryTable(ExceptionEntity);
        if (exceptionTable == null)
            return;

        const sql = connector.sqlBuilder;
        const exceptionName = sql.objectName(exceptionTable.name);
        const idColumn = sql.sqlEscape(exceptionTable.primaryKey.column.name);
        const referencedColumn = sql.sqlEscape(exceptionTable.fields["referenced"]!.field.columns()[0]!.name);
        const trueLiteral = connector.isPostgres ? "true" : "1";

        for (const other of schema.tables.values()) {
            if (other === exceptionTable)
                continue;

            for (const column of Object.values(other.columns)) {
                if (column.referenceTable !== exceptionTable)
                    continue;

                ctx.signal.throwIfAborted();

                const otherName = sql.objectName(other.name);
                const fkColumn = sql.sqlEscape(column.name);
                await writeRows(ctx, `Updating ExceptionEntity.referenced from ${other.name.name}.${column.name}`, () =>
                    connector.executeNonQuery(`UPDATE ${exceptionName} SET ${referencedColumn} = ${trueLiteral}`
                        + ` WHERE ${idColumn} IN (SELECT ${fkColumn} FROM ${otherName} WHERE ${fkColumn} IS NOT NULL)`));
            }
        }
    }

    // Signum's `Exception.LogException(this Exception, Action<ExceptionEntity>? completeContext)`:
    // build/reuse the entity, let the caller enrich it (request context), then persist it. Returns
    // the saved entity so the HttpError factory can read its id.
    export async function logException(error: unknown, completeContext?: (e: ExceptionEntity) => void): Promise<ExceptionEntity> {
        const entity = getEntity(error);
        completeContext?.(entity);
        try {
            // In its OWN transaction, which is what Signum's `ex.LogException()` does. It matters because
            // this is nearly always called from a CATCH block whose transaction is about to roll back: the
            // row would go with it, while the entity — stashed on the Error by `getEntity` — would keep the
            // id that insert handed out. The next caller then reuses it as an EXISTING row, and anything
            // referencing `exception.toLite()` points at a phantom id.
            //
            // That is not hypothetical: it is how the process runner's per-item error path used to fail
            // ("insert or update on process_exception_line violates foreign key constraint"), the item's
            // exception having been logged inside the item transaction that then rolled back.
            await Transaction.forceNew(() => Saver.save([entity]));
        } catch (saveError) {
            // Never let logging mask the original error: a failed save is reported, not thrown.
            console.error("ExceptionLogic.logException: failed to persist ExceptionEntity:", saveError);
        }
        return entity;
    }

    // Reads back the ExceptionEntity stashed on an Error (Signum's Exception.GetExceptionEntity()).
    export function getExceptionEntity(error: unknown): ExceptionEntity | undefined {
        return error != null && typeof error === "object"
            ? ((error as Record<symbol, unknown>)[ExceptionDataKey] as ExceptionEntity | undefined)
            : undefined;
    }

    // Signum's ExceptionLogic.GetEntity: build the entity from the Error (flattening the
    // inner-exception chain into the message/stack), or reuse the one already stashed on it.
    function getEntity(error: unknown): ExceptionEntity {
        const existing = getExceptionEntity(error);
        if (existing != null)
            return existing;

        const err = error instanceof Error ? error : undefined;
        const entity = new ExceptionEntity();
        entity.creationDate = Temporal.Now.plainDateTimeISO();
        entity.exceptionType = err ? err.name : "Error";
        setMessage(entity, err ? (err.message ?? "") : String(error));
        setStackTrace(entity, flattenStack(err));
        entity.threadId = 0 as int; // Node is single-threaded; kept for Signum parity.
        entity.machineName = safe(() => hostname());
        entity.applicationName = process.env["ALTEA_APP_NAME"] ?? "eastwind";
        entity.environment = process.env["NODE_ENV"] ?? "Default";
        entity.origin = ExceptionOrigin.Backend;

        // Stash on the Error so a later HttpError(error) reuses this row / id.
        if (error != null && typeof error === "object")
            (error as Record<symbol, unknown>)[ExceptionDataKey] = entity;

        return entity;
    }

    // Signum's ExceptionEntity(ClientErrorModel) ctor + LogException: log a client-reported error.
    export async function logClientError(model: ClientErrorModel): Promise<ExceptionEntity> {
        const entity = new ExceptionEntity();
        entity.creationDate = Temporal.Now.plainDateTimeISO();
        entity.exceptionType = [model.errorType, model.name].filter(Boolean).join("/");
        setMessage(entity, model.message);
        setStackTrace(entity, model.stack);
        entity.requestUrl = model.url;
        entity.threadId = -1 as int;
        entity.machineName = safe(() => hostname());
        entity.applicationName = process.env["ALTEA_APP_NAME"] ?? "eastwind";
        entity.origin = ExceptionOrigin.Frontend;
        try {
            await Saver.save([entity]);
        } catch (saveError) {
            console.error("ExceptionLogic.logClientError: failed to persist ExceptionEntity:", saveError);
        }
        return entity;
    }
}

// Signum sets ExceptionMessageHash in the ExceptionMessage setter (value?.GetHashCode()).
function setMessage(entity: ExceptionEntity, message: string | null): void {
    // `exceptionMessage` is non-null (as Signum declares it), so an absent message stores as empty.
    entity.exceptionMessage = message ?? "";
    entity.exceptionMessageHash = stringHash(message);
}

function setStackTrace(entity: ExceptionEntity, stack: string | null): void {
    // stackTrace is a (non-null) BigStringEmbedded — write into its `text` (the field initializer
    // guarantees the embedded is present).
    entity.stackTrace.text = stack;
    entity.stackTraceHash = stringHash(stack);
}

// Flatten an Error's inner-exception chain (`.cause`) into one newline-joined stack, mirroring
// Signum's GetEntity walking `ex.InnerException`.
function flattenStack(err: Error | undefined): string | null {
    if (err == null)
        return null;
    const parts: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = (e as { cause?: unknown }).cause) {
        if (e.stack)
            parts.push(e.stack);
    }
    return parts.length ? parts.join("\n\n") : null;
}

// A stable 32-bit string hash (Java String.hashCode) standing in for .NET's string GetHashCode —
// only used for dedup grouping, so the exact algorithm is irrelevant as long as it's stable.
function stringHash(value: string | null): int {
    if (value == null || value.length === 0)
        return 0 as int;
    let hash = 0;
    for (let i = 0; i < value.length; i++)
        hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
    return hash as int;
}

function safe(getValue: () => string | undefined): string | null {
    try {
        return getValue() ?? null;
    } catch {
        return null;
    }
}
