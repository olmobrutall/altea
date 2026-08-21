import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { OpenIDConfigurationEmbedded } from "../data/OpenID";

// Port of Signum.Authorization.OpenID's OpenIDAdminClient.tsx — registers the configuration UI. Called from
// MainAdmin: it touches the Navigator registry, so an anonymous visitor never loads this chunk.
//
// altea divergence: `Navigator.addSettings(new EntitySettings(T, view))` → `cb.configure(T).withView(…)`,
// altea's one fluent registration surface (see ClientBuilder).

export namespace OpenIDAdminClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(OpenIDConfigurationEmbedded).withView(() => import("./OpenIDConfiguration"));
    }
}
