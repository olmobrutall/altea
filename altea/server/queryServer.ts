// The query HTTP API (Signum's QueriesController.cs), on altea's typed `ws` wrapper (./webApi).
// Register on a SchemaBuilder's webBuilder alongside EntitiesServer:
//   if (sb.webBuilder) QueryServer.start(sb.webBuilder);
//
// Today it serves the SERVER-ONLY sub-tokens (extensions — later manual / operations). The client
// generates the metadata sub-tokens locally off the shared token model and fetches only these,
// merging them in via getSubTokens (see entities/dynamicQuery/tokens/queryToken). The response is a
// plain-JSON array (ServerTokenJson — no entity graph), so it goes out via res.json, not the
// entity Serializer.

import { resolveCleanType } from "../entities/registration";
import { SubTokensOptionsAll } from "../entities/dynamicQuery/tokens";
import {
    isServerOnlyToken, serializeServerToken, type ServerTokenJson,
} from "../entities/dynamicQuery/tokenSerializer";
import { QueryLogic } from "./dynamicQuery/queryLogic";
import { WebBuilder, CustomType } from "./webApi";

export namespace QueryServer {

    export function start(ws: WebBuilder): void {

        // GET /api/query/:queryKey/serverTokens?token=<fullKey>&options=<bitflags>
        // The server-only sub-tokens of the parent token (empty `token` ⇒ children of the entity root).
        ws.get("/api/query/:queryKey/serverTokens",
            { params: CustomType<{ queryKey: string }>(), res: CustomType<ServerTokenJson[]>() },
            async (req, res) => {
                const queryName = QueryLogic.tryToQueryName(req.params.queryKey) ?? resolveCleanType(req.params.queryKey);
                if (queryName == undefined) {
                    res.status(404).json({ error: `Query '${req.params.queryKey}' not found` });
                    return;
                }
                const tokenString = (req.query.token as string | undefined) ?? "";
                const options = req.query.options != undefined ? Number(req.query.options) : SubTokensOptionsAll;

                const parent = QueryLogic.getToken(queryName, tokenString, options);
                const serverTokens = parent.subTokens(options).filter(isServerOnlyToken).map(serializeServerToken);
                res.json(serverTokens);
            });
    }
}
