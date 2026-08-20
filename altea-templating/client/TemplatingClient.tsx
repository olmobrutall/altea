import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ModelConverterSymbol, QueryModel, TemplateApplicableSymbol, type GlobalVariableTS } from "../data/Templating";

// The templating module's client registration (Signum has no TemplatingClient — its two views were
// registered by whichever module consumed them, e.g. MailingClient). altea keeps the module's own
// registrations here so a consumer only has to call `TemplatingClient.start(cb)`.

export namespace TemplatingClient {

    // This module is a SHARED dependency — @altea/altea-email and @altea/altea-office-template both call
    // start(), as the header above intends. Registration is not idempotent on its own (configuring the same
    // type twice throws "Key … already added"), so the second caller must be a no-op. Signum guards the
    // same collision at each CALL SITE (`if (!Navigator.getSettings(QueryModel))`); guarding once here fixes
    // it for every consumer, and matches the `let started` idiom the module's server halves already use.
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
        cb.configure(TemplateApplicableSymbol)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(s => s.id),
                    token(s => s.key),
                ],
            }));
    }

    export namespace API {
        /** The `@[g:Key]` variables the server has registered (Signum's getGlobalVariables). */
        export function getGlobalVariables(signal?: AbortSignal): Promise<GlobalVariableTS[]> {
            return ajaxGet({ url: "/api/templating/getGlobalVariables", signal });
        }
    }
}
