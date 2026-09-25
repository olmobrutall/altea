import "@altea/altea/server";
import { hostname } from "node:os";
import { Temporal } from "@altea/altea/data/basics";
import { toInt, type int } from "@altea/altea/data/basics";
import { Saver } from "@altea/altea/server/saver";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { QueryStringValueEntity, RestLogEntity } from "../data/Rest";
import { RestLogLogic } from "./RestLogLogic";
import { RestApiKeyLogic } from "./RestApiKeyLogic";
import { Clock } from "@altea/altea/data/utils/clock";

// "Log every request that reaches this API." Express middleware the app mounts on the path prefix its
// public API lives under — one mount per logged API, each with its own options:
//
//     ws.app.use("/api/catalog", RestLogFilter.middleware({ name: "CatalogAPI", allowReplay: true }));
//
// MOUNT IT AFTER `AuthLogic.start`: that is what installs the per-request user scope, and
// `UserHolder.current()` is read here. Express runs middleware in registration order.
//
// Port of Signum.Rest's RestLogFilter.cs (an MVC action filter there) — see port/Rest.md.
export namespace RestLogFilter {

    export interface RestLogOptions {
        /** How this API shows up in the log — what its rows group by. */
        name: string;
        /** Whether these requests may be re-sent from the log view. */
        allowReplay?: boolean;
        ignoreRequestBody?: boolean;
        /** A streamed or binary response would be buffered in memory; set this to skip capturing it. */
        ignoreResponseBody?: boolean;
    }

    // The slice of Express we need, spelled out so this module needn't depend on @types/express.
    interface ReqLike {
        method: string;
        path: string;
        baseUrl: string;
        originalUrl: string;
        ip?: string;
        body?: unknown;
        query: Record<string, unknown>;
        route?: { path?: string };
        header(name: string): string | undefined;
        get(name: string): string | undefined;
    }
    interface ResLike {
        write(chunk: unknown, ...rest: unknown[]): boolean;
        end(chunk?: unknown, ...rest: unknown[]): unknown;
        statusCode: number;
    }
    type NextLike = (err?: unknown) => void;

    export function middleware(options: RestLogOptions): (req: ReqLike, res: ResLike, next: NextLike) => void {
        return (req, res, next) => {
            const startDate = Clock.now;

            // Capture the response body by intercepting the two methods that produce it. Kept as Buffers so
            // a multi-chunk response reassembles byte-exactly before being decoded once as UTF-8.
            const chunks: Buffer[] = [];
            const originalWrite = res.write.bind(res);
            const originalEnd = res.end.bind(res);

            if (options.ignoreResponseBody !== true) {
                res.write = (chunk: unknown, ...rest: unknown[]): boolean => {
                    collect(chunks, chunk);
                    return originalWrite(chunk, ...rest);
                };
                res.end = (chunk?: unknown, ...rest: unknown[]): unknown => {
                    collect(chunks, chunk);
                    return originalEnd(chunk, ...rest);
                };
            }

            // `end` is the one event that always fires — a normal response, an error response written by
            // the exception filter, and an aborted one. Saving from here (rather than from a wrapper around
            // `next()`) is what makes the log cover a request that threw.
            let saved = false;
            const save = (): void => {
                if (saved)
                    return;
                saved = true;

                // Restore the originals so a later listener on the same response is unaffected.
                res.write = originalWrite;
                res.end = originalEnd;

                const body = options.ignoreResponseBody === true ? null : Buffer.concat(chunks).toString("utf8");
                void writeLog(options, req, startDate, body);
            };

            (res as unknown as { on(ev: string, fn: () => void): void }).on("finish", save);
            (res as unknown as { on(ev: string, fn: () => void): void }).on("close", save);

            next();
        };
    }

    function collect(chunks: Buffer[], chunk: unknown): void {
        if (chunk == null)
            return;
        if (typeof chunk === "string")
            chunks.push(Buffer.from(chunk, "utf8"));
        else if (Buffer.isBuffer(chunk))
            chunks.push(chunk);
    }

    async function writeLog(
        options: RestLogOptions,
        req: ReqLike,
        startDate: Temporal.PlainDateTime,
        responseBody: string | null,
    ): Promise<void> {
        try {
            const log = RestLogEntity.create({
                allowReplay: options.allowReplay ?? false,
                httpMethod: req.method,
                url: req.originalUrl.split("?")[0] ?? req.originalUrl,
                user: UserHolder.currentUserLite(),
                controller: cap(100, req.route?.path ?? req.baseUrl + req.path),
                controllerName: cap(100, options.name),
                action: cap(100, req.method),
                machineName: cap(100, hostname()),
                applicationName: cap(100, RestLogLogic.applicationName),
                startDate,
                endDate: Clock.now,
                userHostAddress: req.ip ?? null,
                userHostName: req.get("host") ?? null,
                // Browsers send the misspelled "referer"; read both spellings.
                referrer: req.header("referer") ?? req.header("referrer") ?? null,
            });

            log.requestBody.text = options.ignoreRequestBody === true ? null : requestBody(req);
            log.responseBody.text = responseBody;
            log.queryString = queryStringRows(req);

            // Its own transaction, in global mode: a log must not roll back with the request it describes,
            // nor be subject to the caller's rules.
            await Transaction.forceNew(() => ExecutionMode.global(() => Saver.save([log])));
        } catch (e) {
            // A failure to LOG must never fail the request (already sent).
            try { await Transaction.forceNew(() => ExceptionLogic.logException(e)); } catch { /* never mask */ }
        }
    }

    function requestBody(req: ReqLike): string | null {
        const body = req.body;
        if (body == null)
            return null;
        return typeof body === "string" ? body
            : Buffer.isBuffer(body) ? body.toString("utf8")
                : JSON.stringify(body);
    }

    function queryStringRows(req: ReqLike): QueryStringValueEntity[] {
        return Object.entries(req.query).map(([key, value]) => QueryStringValueEntity.create({
            key,
            value: redact(key, value),
        }));
    }

    /**
     * An API key passed as `?apiKey=…` is REDACTED. A key is a long-lived credential and this table is
     * readable by anyone who can read RestLog, so logging it in the clear would turn a request log into a
     * credential store. Nothing needs the logged value: the replay resolves the key from the log's USER
     * (see RestLogServer), and the url the replay sends has `apiKey=` stripped anyway.
     */
    function redact(key: string, value: unknown): string | null {
        if (key === RestApiKeyLogic.apiKeyQueryParameter)
            return "***";
        return value == null ? null : Array.isArray(value) ? value.map(String).join(", ") : String(value);
    }

    /** A column-sized field must never fail the log because a value is long. */
    function cap(size: number, value: string | null | undefined): string {
        return (value ?? "").slice(0, size);
    }
}
