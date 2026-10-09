import { ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import type { EvalEntityError } from "../data/EvalDtos";

// The client half: the eval-errors API. The PANEL page and its omnibox action belong to
// @altea/altea-dynamic, which owns the admin pages, so this module only exposes the endpoint they call —
// which is why `start` registers nothing today.
//
// See port/Eval.md.

export namespace EvalClient {

    export function start(_cb: ClientBuilder): void {
        // Nothing to register yet — see the header.
    }

    export namespace API {
        /**
         * Compiles every stored script the server knows about and answers the ones that fail. The registry
         * lives on the SERVER, so this is one parameterless call.
         */
        export function getEvalErrors(): Promise<EvalEntityError[]> {
            return ajaxPost({ url: "/api/eval/evalErrors" }, undefined);
        }
    }
}
