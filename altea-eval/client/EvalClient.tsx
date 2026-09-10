import { ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";

// The client half: the eval-errors API. The PANEL page and its omnibox action belong to
// @altea/altea-dynamic, which owns the admin pages, so this module only exposes the endpoint they call —
// which is why `start` registers nothing today.
//
// See docs/port/Eval.md.

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
