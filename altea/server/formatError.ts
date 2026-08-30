import { inspect } from "node:util";

// Turns an unknown throwable into text a console can be read from. This exists because the obvious
// `err?.message ?? err` prints NOTHING for two shapes a host meets constantly:
//  - an AggregateError, whose OWN message is empty — node's happy-eyeballs dial rejects with one when
//    every resolved address refuses the connection, and the detail lives in `.errors`. That is how "the
//    PostgreSQL server is not running" reached the eastwind console as a bare `[FAILED]`;
//  - a thrown non-Error (a string, a plain object), which has no `.message` at all.
// So: the name, then the message (or the driver's `code` when there is no message), the stack frames,
// each aggregated error, and the `cause` chain — the last two indented under their parent.
export function formatError(err: unknown): string {
    if (!(err instanceof Error))
        return inspect(err, { depth: 4 });

    const code = (err as { code?: unknown }).code;
    const detail = err.message !== "" ? `: ${err.message}` :
        code != null ? ` (${String(code)})` : "";
    const parts = [`${err.name}${detail}`];

    // The error's own enumerable properties — everything the driver attached and the message does not
    // repeat: `errno` / `syscall` / `address` / `port` on a socket error, `detail` / `hint` / `constraint`
    // / `table` on a pg one. `message`, `stack`, `cause` and AggregateError's `errors` are non-enumerable,
    // so they are not repeated here; each is printed in its own right below.
    const own = Object.keys(err);
    if (own.length > 0)
        parts.push(inspect(Object.fromEntries(own.map(k => [k, (err as unknown as Record<string, unknown>)[k]])), { depth: 2, breakLength: 120 }));

    // Only the `at …` frames: the stack's own first line repeats the head, and for an empty-message
    // error it repeats it in the mangled form (`AggregateError [ECONNREFUSED]: `).
    const frames = (err.stack ?? "").split("\n").filter(l => l.trimStart().startsWith("at "));
    if (frames.length > 0)
        parts.push(frames.join("\n"));

    const inner = (err as AggregateError).errors;
    if (Array.isArray(inner) && inner.length > 0) {
        parts.push(`${inner.length} inner error${inner.length === 1 ? "" : "s"}:`);
        parts.push(...inner.map(e => indent(formatError(e))));
    }

    if (err.cause != null) {
        parts.push("caused by:");
        parts.push(indent(formatError(err.cause)));
    }

    return parts.join("\n");
}

function indent(text: string): string {
    return text.split("\n").map(l => "    " + l).join("\n");
}
