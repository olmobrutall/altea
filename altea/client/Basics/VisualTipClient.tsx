import { ajaxGet, ajaxPost } from "../Services";
import * as AppContext from "../AppContext";

// Port of Signum's React/Basics/VisualTipClient.tsx — the two calls the "?" icon makes, with the read
// list cached for the session.
//
// The cache matters: every SearchControl on a page renders at least one tip icon, and each would otherwise
// ask the server which tips this user has read. One shared promise answers them all.
//
// altea divergences:
//  - `consume` POSTs `{ symbolKey }` rather than a bare JSON string — see VisualTipServer on why.
//  - Signum clears the cache from `AppContext.clearSettingsActions`; altea's counterpart is
//    `resetUI`-adjacent, so the reset is registered the way other per-user client caches are (see
//    `start`). It also clears on a user CHANGE, which Signum gets for free by reloading the page.
export namespace VisualTipClient {

    export function start(): void {
        // A different user has read a different set of tips.
        AppContext.currentUserChanged.push(() => { API.state.cached = null; });
    }

    export namespace API {
        export const state = {
            cached: null as Promise<string[] | null> | null | undefined,
        };

        /** The tips the current user has already read, or null when consuming is disabled server-side. */
        export function getConsumed(): Promise<string[] | null> {
            return (state.cached ??= ajaxGet({ url: "/api/visualtip/getConsumed" }));
        }

        export function consume(symbolKey: string): Promise<null> {
            state.cached = null;
            return ajaxPost({ url: "/api/visualtip/consume" }, { symbolKey });
        }
    }
}
