import { ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";

// Port of Signum.Eval's EvalClient.tsx — the client half: the eval-errors API and (in Signum) the dynamic
// panel's route + omnibox action.
//
// altea divergences:
//  - the PANEL page and its omnibox action belong to @altea/altea-dynamic, which owns the admin pages; this
//    module only exposes the endpoint they call. That is why `start` registers nothing today — it exists so
//    the module has the same shape as every other altea client (and so `ChangeLogClient`-style registrations
//    have a home if they land).
//  - `Options.checkEvalFindOptions` / `registerDynamicPanelSearch` are not here: the eval-check registry is
//    SERVER-side in altea (see EvalLogic.evalSources), and the panel-search registry was re-homed onto
//    @altea/altea-dynamic's DynamicClient when Signum.Eval looked unportable.
//  - `HighlightText` (Signum's search-hit renderer for Code / JSon columns) goes with that panel search.

export namespace EvalClient {

    export function start(_cb: ClientBuilder): void {
        // Nothing to register yet — see the header.
    }

    /** Signum's EvalEntityError, plus which registered source the row came from (see EvalServer). */
    export interface EvalEntityError {
        source: string;
        lite: Lite<Entity>;
        error: string;
    }

    export namespace API {
        /**
         * Compiles every stored script the server knows about and answers the ones that fail. Signum takes a
         * QueryEntitiesRequest per registered FindOptions; altea's registry lives on the server, so this is
         * one parameterless call.
         */
        export function getEvalErrors(): Promise<EvalEntityError[]> {
            return ajaxPost({ url: "/api/eval/evalErrors" }, undefined);
        }
    }
}
