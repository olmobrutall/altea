import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { OpenIDConfigurationEmbedded } from "../data/OpenID";

// Registers the configuration UI. Called from MainAdmin: it touches the Navigator registry, so an
// anonymous visitor never loads this chunk.

export namespace OpenIDAdminClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(OpenIDConfigurationEmbedded).withView(() => import("./OpenIDConfiguration"));
    }
}
