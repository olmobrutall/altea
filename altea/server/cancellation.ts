// Request cancellation — altea's counterpart of the `CancellationToken` Signum's controllers take
// (old/Framework/Signum/API/Controllers/QueryController.cs) and thread down to `ExecuteReaderAsync`.
//
// The token is an `AbortSignal`, passed as an explicit trailing argument exactly as Signum passes
// its own, and produced per request by `filters/cancellationFilter`. It is COOPERATIVE: a statement
// already in flight runs to completion, and the check happens before the next round trip — see
// port/port.md ("Request cancellation").

/**
 * What a cancelled read throws. The name is load-bearing: `exceptionFilter.shouldLogException`
 * already excludes it, so an abandoned search writes no ExceptionEntity row.
 */
export class OperationCanceledException extends Error {
    constructor(message = "The operation was canceled") {
        super(message);
        this.name = "OperationCanceledException";
    }
}

/** The checkpoint. A missing signal means "not cancellable", never "cancelled". */
export function throwIfCanceled(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true)
        return;
    throw signal.reason instanceof Error ? signal.reason : new OperationCanceledException();
}

/** Whether an error is a cancellation — ours, or a bare `AbortController.abort()` from elsewhere. */
export function isCanceled(error: unknown): boolean {
    return error instanceof Error && (error.name === "OperationCanceledException" || error.name === "AbortError");
}
