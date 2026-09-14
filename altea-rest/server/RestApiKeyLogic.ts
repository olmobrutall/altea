import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import { randomBytes } from "node:crypto";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import type { ResetLazy } from "@altea/altea/server/resetLazy";
import { RestApiKeyEntity, RestApiKeyOperation } from "../data/Rest";

// The key table plus the process-wide cache the authenticator reads on every request.
//
// Port of Signum.Rest's RestApiKeyLogic.cs — see port/Rest.md.
export namespace RestApiKeyLogic {

    /** A caller may pass the key either way. */
    export const apiKeyQueryParameter = "apiKey";
    export const apiKeyHeader = "X-ApiKey";

    /** apiKey → the row. Reset whenever a RestApiKey is saved, deleted or touched by set-based DML. */
    export let restApiKeyCache: ResetLazy<Map<string, RestApiKeyEntity>> = undefined!;

    /** Overridable. */
    export let generateRestApiKey: () => string = defaultGenerateRestApiKey;

    let started = false;

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        sb.include(RestApiKeyEntity)
            .withSave(RestApiKeyOperation.Save)
            .withDelete(RestApiKeyOperation.Delete)
            .withQuery();

        restApiKeyCache = sb.globalLazy(
            async () => new Map((await table(RestApiKeyEntity).toArray()).map(k => [k.apiKey, k])),
            { invalidateWith: [RestApiKeyEntity] });
    }

    /** 32 cryptographically random bytes, base64url-encoded. */
    function defaultGenerateRestApiKey(): string {
        return randomBytes(32).toString("base64url");
    }

    /** The key belonging to a user, if any — what the client's "open Swagger / MCP with my key" needs. */
    export async function apiKeyOf(userId: RestApiKeyEntity["user"]["id"]): Promise<string | null> {
        const found = await table(RestApiKeyEntity).filter(k => k.user.id == userId).toArray();
        return found.length === 0 ? null : found[0]!.apiKey;
    }
}
