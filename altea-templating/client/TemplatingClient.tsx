import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ModelConverterSymbol, QueryModel, type GlobalVariableTS } from "../data/Templating";

// The templating module's own client registration, so a consumer only has to call
// `TemplatingClient.start(cb)` — see port/Templating.md.

export namespace TemplatingClient {

    // This module is a SHARED dependency — @altea/altea-email and @altea/altea-office-template both call
    // start(), as the header above intends. Registration is not idempotent on its own (configuring the same
    // type twice throws "Key … already added"), so the second caller must be a no-op. Guarded ONCE here
    // rather than at each call site, which fixes it for every consumer and matches the `let started`
    // idiom the module's server halves already use.
    let started = false;

    export function start(cb: ClientBuilder): void {
        if (started)
            return;
        started = true;

        cb.configure(QueryModel).withView(() => import("./Templates/QueryModel"));

        cb.configure(ModelConverterSymbol)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(s => s.id),
                    token(s => s.key),
                ],
            }));
    }

    export namespace API {
        /** The `@[g:Key]` variables the server has registered. */
        export function getGlobalVariables(signal?: AbortSignal): Promise<GlobalVariableTS[]> {
            return ajaxGet({ url: "/api/templating/getGlobalVariables", signal });
        }
    }
}
