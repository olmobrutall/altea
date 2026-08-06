import { hostname } from "node:os";
import { Temporal, type int } from "../data/basics";
import { ExceptionEntity, ExceptionOrigin } from "../data/exception";
import type { ClientErrorModel } from "../data/clientError";
import type { SchemaBuilder } from "./schema/schemaBuilder";
import { Saver } from "./saver";
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery

// Port of Signum's ExceptionLogic (old/Framework/Signum/Basics/ExceptionLogic.cs), trimmed to the
// pieces eastwind needs: schema registration + the `logException` extension that builds, fills and
// persists an ExceptionEntity. Deferred (as in Signum but not needed yet): OnExceptionLogged event,
// the log-cleanup/DeleteLogs machinery, per-environment overrides, and the User/auth wiring.
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
        sb.include(ExceptionEntity).withQuery();
    }

    // Signum's `Exception.LogException(this Exception, Action<ExceptionEntity>? completeContext)`:
    // build/reuse the entity, let the caller enrich it (request context), then persist it. Returns
    // the saved entity so the HttpError factory can read its id.
    export async function logException(error: unknown, completeContext?: (e: ExceptionEntity) => void): Promise<ExceptionEntity> {
        const entity = getEntity(error);
        completeContext?.(entity);
        try {
            await Saver.save([entity]);
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
        entity.origin = ExceptionOrigin.Backend_Node;

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
        entity.origin = ExceptionOrigin.Frontend_React;
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
    entity.exceptionMessage = message;
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
