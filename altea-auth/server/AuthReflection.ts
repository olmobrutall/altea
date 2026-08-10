import { ReflectionServer, type ServerMetadata } from "@altea/altea/server/reflectionServer";
import { AuthLogic } from "./AuthLogic";
import { QueryAuthLogic } from "./QueryAuthLogic";
import { QueryAllowed } from "../data/Rules";

// Role-filtering overlay on the reflection blob (Signum's AuthServer reflection extensions): for the
// current role, drop the queries it isn't allowed to see. Installed once at web-host startup; runs inside
// each request's user scope, so it sees the current role.
//
// Depends ONLY on QueryAuthLogic — the query dimension already COERCES a no-rule query to its root type's
// UI-read allowance (the type-read auto-upgrade, Signum's AutomaticUpgradeOfQueries), so honouring type
// authorization falls out transitively; there is no separate TypeAuthLogic pass here.
export namespace AuthReflectionServer {
    export function install(): void {
        ReflectionServer.setMetadataFilter(async (meta: ServerMetadata): Promise<ServerMetadata> => {
            const roleKey = AuthLogic.currentRoleKey();
            if (roleKey == null || !QueryAuthLogic.isStarted())
                return meta; // no role (pre-login / auth off) or query auth not started → unfiltered

            // Resolve every query's allowance up-front (no await inside the filter), then drop the `None` ones.
            const allowed = await Promise.all(meta.queries.map(q => QueryAuthLogic.getQueryAllowedByKey(q, roleKey)));
            const queries = meta.queries.filter((_, i) => allowed[i] !== QueryAllowed.None);
            return { ...meta, queries };
        });
    }
}
