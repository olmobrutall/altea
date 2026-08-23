import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { RestLogEntity } from "../data/Rest";
import { RestApiKeyLogic } from "./RestApiKeyLogic.server";

// Port of Signum.Rest's RestLogLogic.cs — the log table, its four indexes, and the "send this request
// again and let me diff the answer" replay.
//
// altea divergences:
//  - **`ExceptionLogic.DeleteLogs` is not ported.** altea has no log-deletion machinery yet — the same
//    note @altea/altea-scheduler, -processes, -migrations, -email and -workflow all carry — so the
//    per-type retention hook is deferred with it.
//  - **`HttpClient` → `fetch`**, and the replay drops the API key from the URL it re-sends: Signum strips
//    the `apiKey=` query parameter and passes the key as the `X-ApiKey` HEADER instead, so the replayed
//    request authenticates the same way without leaking the key into a log of the replay.
//  - **`Duration` is a registered EXPRESSION over a `@quoted` member** (see data/Rest.ts), which is what
//    makes it an orderable column on the log's search page.
export namespace RestLogLogic {

    /** Signum's `AppDomain.CurrentDomain.FriendlyName`, which Node has no counterpart for. */
    export let applicationName: string = process.env["ALTEA_APPLICATION_NAME"] ?? "altea";

    let started = false;

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        sb.include(RestLogEntity)
            .withIndex(e => e.startDate)
            .withIndex(e => e.endDate)
            .withIndex(e => e.controller)
            .withIndex(e => e.action)
            .withQuery();

        QueryLogic.expressions.register(RestLogEntity, e => e.durationMilliseconds(),
            { key: "Duration", niceName: () => RestLogEntity.nicePropertyName(e => e.durationMilliseconds()) });
    }

    /**
     * Signum's `GetRestDiffResult` — re-send a logged request to `url` and hand back the response body, so
     * the client can diff it against what was stored.
     *
     * ALTEA: the api key rides as the `X-ApiKey` header and is STRIPPED from the url (Signum does the same
     * surgery on the query string, by hand). A logged GET is replayed as a GET; a logged request that had a
     * body is replayed as a POST of that body, which is Signum's own branch — a request whose body matters
     * is a POST in practice.
     */
    export async function getRestDiffResult(
        httpMethod: string,
        url: string,
        apiKey: string | null,
        oldRequestBody: string | null,
    ): Promise<string> {
        const headers: Record<string, string> = {};
        if (apiKey != null)
            headers[RestApiKeyLogic.apiKeyHeader] = apiKey;

        const hasBody = oldRequestBody != null && oldRequestBody.trim() !== "";
        if (hasBody)
            headers["Content-Type"] = "application/json";

        const response = await fetch(withoutApiKey(url), {
            method: hasBody ? "POST" : httpMethod,
            headers,
            body: hasBody ? oldRequestBody : undefined,
        });

        return await response.text();
    }

    /** Drop the `apiKey=` query parameter, keeping every other one (Signum's before/after surgery). */
    function withoutApiKey(url: string): string {
        const q = url.indexOf("?");
        if (q < 0)
            return url;

        const params = new URLSearchParams(url.slice(q + 1));
        params.delete(RestApiKeyLogic.apiKeyQueryParameter);
        const rest = params.toString();
        return rest === "" ? url.slice(0, q) : `${url.slice(0, q)}?${rest}`;
    }
}
