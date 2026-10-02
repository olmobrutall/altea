import { OperationCanceledException } from "../cancellation";
import type { RequestFilter } from "./requestFilter";

/**
 * Turn "the client went away" into an `AbortSignal` on the context — ASP.NET's
 * `HttpContext.RequestAborted`, which Signum's controllers receive as a `CancellationToken` parameter.
 *
 * Express has no equivalent, but Node does: when a `fetch` is aborted the socket is destroyed, and the
 * response emits `close` before anything was written. `writableEnded` is what separates that from the
 * ordinary close at the end of every successful response.
 *
 * OUTERMOST, so the signal exists for the whole request — including the filters that run before the
 * handler. The signal is only ever OFFERED: nothing is cancelled unless a call site passes it on, which
 * is why a write path (save, an operation) can never be half-aborted by a user navigating away.
 */
export const cancellationFilter: RequestFilter = async (ctx, next) => {
    const controller = new AbortController();
    const onClose = (): void => {
        if (!ctx.res.writableEnded)
            controller.abort(new OperationCanceledException(
                `The client disconnected before ${ctx.req.method} ${ctx.req.originalUrl} finished`));
    };
    ctx.res.on("close", onClose);
    ctx.signal = controller.signal;
    try {
        await next();
    } finally {
        ctx.res.off("close", onClose);
    }
};
