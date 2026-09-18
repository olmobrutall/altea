import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { RestLogEntity, RestLogMessage } from "../data/Rest";
import { RestApiKeyLogic } from "./RestApiKeyLogic";

// The log table, its four indexes, and the "send this request again and let me diff the answer" replay.
//
// Port of Signum.Rest's RestLogLogic.cs — see port/Rest.md.
export namespace RestLogLogic {

    /** What the log records as the application that served the request. */
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
            RestLogMessage.Duration);
    }

    /**
     * Re-send a logged request to `url` and hand back the response body, so the client can diff it against
     * what was stored.
     *
     * The api key rides as the `X-ApiKey` header and is STRIPPED from the url. A logged GET is replayed as
     * a GET; a logged request that had a body is replayed as a POST of that body.
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

    /** Drop the `apiKey=` query parameter, keeping every other one. */
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
