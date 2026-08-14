import { ReflectionServer, type ServerMetadata } from "@altea/altea/server/reflectionServer";
import { Connector } from "@altea/altea/server/connection/connector";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { AuthLogic } from "./AuthLogic";
import { QueryAuthLogic } from "./QueryAuthLogic";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { QueryAllowed, TypeAllowedBasic } from "../data/Rules";

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

            // Per-type max UI-read allowance for the role (the source of Signum's TypeInfo.maxTypeAllowed):
            // ship only the RESTRICTED types (< Write) as the raw numeric TypeAllowedBasic — the auth client
            // projects it onto min/maxTypeAllowed and the client defaults everything else to unrestricted.
            const typeAllowed: Record<string, number> = { ...meta.typeAllowed };
            if (TypeAuthLogic.isStarted()) {
                for (const [ctor] of Connector.current().schema.tables) {
                    if (typeof ctor !== "function") continue;
                    let typeId: PrimaryKey;
                    try { typeId = TypeLogic.typeToId(ctor); } catch { continue; } // enum/view — not type-auth'd
                    const maxUI = await TypeAuthLogic.maxTypeAllowedUI(typeId, roleKey);
                    if (maxUI < TypeAllowedBasic.Write)
                        typeAllowed[cleanTypeName(ctor)] = maxUI;
                }
            }
            return { ...meta, queries, typeAllowed };
        });
    }
}
