import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ModelConverterSymbol, QueryModel, TemplateApplicableSymbol, type GlobalVariableTS } from "../data/Templating";

// The templating module's client registration (Signum has no TemplatingClient — its two views were
// registered by whichever module consumed them, e.g. MailingClient). altea keeps the module's own
// registrations here so a consumer only has to call `TemplatingClient.start(cb)`.

export namespace TemplatingClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(QueryModel).withView(() => import("./Templates/QueryModel"));

        cb.configure(ModelConverterSymbol)
            .withQuerySettings(token => ({ defaultColumns: [token(s => s.id), token(s => s.key)] }));
        cb.configure(TemplateApplicableSymbol)
            .withQuerySettings(token => ({ defaultColumns: [token(s => s.id), token(s => s.key)] }));
    }

    export namespace API {
        /** The `@[g:Key]` variables the server has registered (Signum's getGlobalVariables). */
        export function getGlobalVariables(signal?: AbortSignal): Promise<GlobalVariableTS[]> {
            return ajaxGet({ url: "/api/templating/getGlobalVariables", signal });
        }
    }
}
