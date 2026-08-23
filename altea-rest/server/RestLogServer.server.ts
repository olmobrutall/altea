import "@altea/altea/server";
import { table } from "@altea/altea/server/table";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { RestApiKeyEntity, RestLogEntity, RestLogMessage } from "../data/Rest";
import { RestLogLogic } from "./RestLogLogic.server";

// Port of Signum.Rest's RestLogController.cs — replay one logged request against a live host.
//
// ALTEA: the url is a QUERY parameter here as it is in Signum, but the id is the route's own path segment
// (`/api/restLog/:id`) rather than a second query parameter — that is the shape every other altea
// entity-addressed route uses, and it makes the id typed by the router.
export namespace RestLogServer {

    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        ws.get("/api/restLog/:id",
            { params: CustomType<{ id: string }>(), res: CustomType<string>() },
            async (req, res) => {
                const url = req.query["url"] as string | undefined;
                if (url == null || url === "")
                    throw new Error("The 'url' query parameter is required.");

                const id = RestLogEntity.parseId(req.params.id);
                const oldRequest = await table(RestLogEntity).filter(l => l.id == id).single() as RestLogEntity;

                if (!oldRequest.allowReplay)
                    throw new Error(RestLogMessage.ReplayNotAllowedForThisRestLog.niceToString());

                // Replay AS the user who made the original call: their key, so their rules apply. Signum
                // takes the first key of that user for the same reason.
                const userId = oldRequest.user?.id;
                const credentials = userId == null ? []
                    : await table(RestApiKeyEntity).filter(k => k.user.id == userId).toArray();

                const result = await RestLogLogic.getRestDiffResult(
                    oldRequest.httpMethod ?? "GET",
                    decodeURIComponent(url),
                    credentials.length === 0 ? null : credentials[0]!.apiKey,
                    oldRequest.requestBody.text);

                res.jsonTyped(result);
            });
    }
}
