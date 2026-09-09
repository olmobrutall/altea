import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { QueryString } from "@altea/altea/client/QueryString";
import { RestLogEntity } from "../data/Rest";

// The log's view plus the replay call.
export namespace RestClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(RestLogEntity)
            .withView(() => import("./Templates/RestLog"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.startDate),
                    token(a => a.url),
                    token(a => a.user),
                    token(a => a.exception),
                ],
            }));
    }

    export namespace API {

        /** Re-send the logged request to `host` and return the response body verbatim. */
        export function replayRestLog(restLogId: string | number, host: string): Promise<string> {
            // The id is a path segment, the url a query parameter — encoded by QueryString rather than by
            // the caller.
            return ajaxGet({ url: `/api/restLog/${restLogId}?` + QueryString.stringify({ url: host }) });
        }
    }
}
