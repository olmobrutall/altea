import type { Request, Response, NextFunction } from "express";
import type { WebBuilder } from "./webApi";
import { ExceptionLogic } from "./exceptionLogic";
import type { ExceptionEntity } from "../data/exception";
import { IntegrityCheckException } from "../data/validation";
import { EntityNotFoundException, UnauthorizedAccessException, AuthenticationException } from "./exceptions";
import { UserHolder } from "./userHolder";

// Port of Signum's SignumExceptionFilterAttribute + HttpError (old/Framework/Signum/API/Filters/
// SignumExceptionFilterAttribute.cs), as Express error-handling middleware. Signum's attribute runs
// as an IAsyncResourceFilter around every action; altea has no MVC filter pipeline, so this is the
// terminal Express error handler (registered AFTER the routes, replacing the old ad-hoc
// `useDefaultErrorHandler` that emitted a bare `{ error }`).
//
// On any unhandled error it: (1) logs an ExceptionEntity (ExceptionLogic.logException, enriched with
// request context), then (2) writes an `HttpError` JSON — the exact shape the client's
// Services.ThrowErrorFilter parses into a `ServiceError` (WebApiHttpError): exceptionType /
// exceptionMessage / stackTrace / exceptionId / innerException. `exceptionId` is the saved row's id,
// so the ErrorModal can surface (and, once wired, link to) the persisted exception.

// The client's WebApiHttpError (altea/client/Services.ts).
export interface HttpError {
    exceptionType: string;
    exceptionMessage: string | null;
    stackTrace: string | null;
    exceptionId: string | null;
    model?: unknown;
    innerException: HttpError | null;
}

// Signum's HttpError.IncludeErrorDetails / SignumExceptionFilterAttribute.ShouldLogException — kept as
// mutable hooks so a host can suppress stack traces in production or skip logging for some errors.
export let includeErrorDetails: (e: unknown) => boolean = () => true;
export let shouldLogException: (e: unknown) => boolean =
    e => !(e instanceof Error && (e.name === "AbortError" || e.name === "OperationCanceledException"));

// Signum's GetStatus(Type): map well-known exception kinds to HTTP status codes; everything else 500.
// Matched with `instanceof` against the real framework exception classes (server/exceptions.ts +
// data/validation.ts), not by string name.
function getStatus(error: unknown): number {
    if (error instanceof UnauthorizedAccessException || error instanceof AuthenticationException)
        return 403; // Unauthorized would trigger the login dialog in mixed mode
    if (error instanceof EntityNotFoundException)
        return 404;
    if (error instanceof IntegrityCheckException)
        return 400;
    return 500;
}

// Signum's `new HttpError(e, includeErrorDetails, includeId)`: message + type + (optionally) id, and
// when details are included the stack trace + a recursive InnerException from `.cause`.
function toHttpError(error: unknown, exceptionId: string | null, includeDetails: boolean): HttpError {
    const err = error instanceof Error ? error : undefined;
    const httpError: HttpError = {
        exceptionType: err ? (err.constructor?.name ?? err.name) : "Error",
        exceptionMessage: err ? err.message : String(error),
        stackTrace: null,
        exceptionId,
        innerException: null,
    };
    if (includeDetails) {
        httpError.stackTrace = err?.stack ?? null;
        const cause = (err as { cause?: unknown } | undefined)?.cause;
        httpError.innerException = cause != null ? toHttpError(cause, null, includeDetails) : null;
    }
    return httpError;
}

// Register the terminal JSON error handler on the Express app (Signum's SignumServer wiring).
export function useExceptionFilter(ws: WebBuilder): void {
    ws.app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
        // If the response already started streaming, defer to Express's default handler.
        if (res.headersSent) {
            next(err);
            return;
        }
        handle(err, req, res).catch(e => {
            console.error("exceptionFilter: error handler itself failed:", e);
            if (!res.headersSent)
                res.status(500).type("application/json").send(JSON.stringify(
                    toHttpError(err, null, true)));
        });
    });
}

async function handle(error: unknown, req: Request, res: Response): Promise<void> {
    // A failed integrity check is not an "error" to surface as a crash modal: emit the flat ModelState
    // (no `exceptionType`) so the client's ThrowErrorFilter builds a ValidationError → field errors +
    // summary. Same body shape as res.modelState, so the operation-save path and /api/save agree.
    if (error instanceof IntegrityCheckException) {
        res.status(400).type("application/json").send(JSON.stringify(error.modelState));
        return;
    }

    const httpError = await logAndBuildHttpError(error, req);

    // Plain JSON (not the entity Serializer): the client parses the body with JSON.parse.
    res.status(getStatus(error)).type("application/json").send(JSON.stringify(httpError));
}

/**
 * Log the exception and build the very `HttpError` this filter would have written — for a route that can
 * no longer use the filter because it has already COMMITTED its response.
 *
 * Signum has no counterpart, and needs none: its streaming actions return an `IAsyncEnumerable` whose
 * first exception is raised before ASP.NET has begun the response, so its own exception filter still owns
 * the status code and the body and the client sees an ordinary failed call. An altea route writes as it
 * goes, and once the first line is out both are spent — so the failure has to travel IN-BAND, as one more
 * line the client turns back into an error (@altea/altea-office-template's excel import does exactly
 * that). Same log row, same shape, same `exceptionId`: only the transport differs.
 */
export async function logAndBuildHttpError(error: unknown, req?: Request): Promise<HttpError> {
    let exceptionId: string | null = null;
    if (shouldLogException(error)) {
        const exLog = await ExceptionLogic.logException(error, e => { if (req != null) fillContext(e, req); });
        exceptionId = exLog.id != null ? String(exLog.id) : null;
    }

    return toHttpError(error, exceptionId, includeErrorDetails(error));
}

// Signum's SignumExceptionFilterAttribute.LogException `completeContext`: fill the request-derived
// fields, each guarded + length-capped (Signum's `Try(size, …)`).
function fillContext(e: ExceptionEntity, req: Request): void {
    e.user = UserHolder.currentUserLite();
    e.actionName = tryStr(100, () => req.method);
    e.controllerName = tryStr(100, () => controllerName(req));
    e.userAgent = tryStr(300, () => header(req, "user-agent"));
    e.requestUrl = tryStr(undefined, () => fullUrl(req));
    e.urlReferer = tryStr(undefined, () => header(req, "referer"));
    e.userHostAddress = tryStr(100, () => req.ip ?? null);
    // queryString / form are BigStringEmbedded (non-null; write into `.text`).
    e.queryString.text = tryStr(undefined, () => {
        const q = req.originalUrl.indexOf("?");
        return q >= 0 ? req.originalUrl.slice(q) : "";
    });
    e.form.text = tryStr(undefined, () => typeof req.body === "string" ? req.body
        : req.body != null ? JSON.stringify(req.body) : "");

    for (const apply of applyMixins) {
        try { apply(e, req); } catch { /* an exception log must not fail while logging an exception */ }
    }
}

/**
 * Signum's `SignumExceptionFilterAttribute.ApplyMixins` — stamp a module's own mixin fields onto the
 * exception row being logged, with the request still in hand. Its only implementor is
 * @altea/altea-isolation, which records which isolation the failing request was running in (the ambient
 * scope may already have been torn down, so it falls back to what the middleware stashed on the request).
 *
 * Runs last, after the request-derived fields, and a throwing handler is swallowed: this code path is
 * already handling a failure.
 */
export const applyMixins: ((e: ExceptionEntity, req: Request) => void)[] = [];

function controllerName(req: Request): string {
    // No MVC controller concept — approximate with the matched route (or the path's first segment).
    const path = (req.route?.path as string | undefined) ?? req.path;
    return path;
}

function fullUrl(req: Request): string {
    return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl}`;
}

function header(req: Request, name: string): string | null {
    const v = req.headers[name];
    return Array.isArray(v) ? v.join(", ") : (v ?? null);
}

// Signum's `Try(size, getValue)`: run the getter, truncate to `size` (undefined → unbounded), and on
// any error fall back to the error's own text (also truncated) instead of throwing.
function tryStr(size: number | undefined, getValue: () => string | null): string | null {
    try {
        return truncate(getValue(), size);
    } catch (e) {
        return truncate(e instanceof Error ? `${e.name}:${e.message}` : String(e), size);
    }
}

function truncate(value: string | null, size: number | undefined): string | null {
    if (value == null)
        return null;
    return size != null && value.length > size ? value.slice(0, size) : value;
}
