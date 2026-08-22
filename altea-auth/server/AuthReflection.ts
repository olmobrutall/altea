import { ReflectionServer } from "@altea/altea/server/reflectionServer";
import type { MetadataBlob } from "@altea/altea/data/metadata";
import { Connector } from "@altea/altea/server/connection/connector";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { AuthLogic } from "./AuthLogic";
import { QueryAuthLogic } from "./QueryAuthLogic";
import { TypeAuthLogic } from "./TypeAuthLogic";
import { PropertyAuthLogic } from "./PropertyAuthLogic";
import { PermissionAuthLogic } from "./PermissionAuthLogic";
import { declaredSymbolsForType } from "@altea/altea/data/registration";
import { PermissionSymbol, QueryAllowed, TypeAllowedBasic } from "../data/Rules";

// Role-filtering overlay on the reflection metadata blob (Signum's AuthServer reflection extensions).
// Installed once at web-host startup; runs inside each request's user scope, so it sees the current role.
//
// Because the blob is now ONE TypeMetadata per type, this writes the role's answers onto the very objects
// that already carry the type's nice names, instead of shipping a parallel side-channel map. The extra
// fields come from an interface expansion in ../data/Rules, so altea's core never sees them.
//
// The blob buildMetadata hands over is a fresh deep copy per request — mutating it here can never leak a
// role's allowances into the shared per-culture store.
export namespace AuthReflectionServer {
    export function install(): void {
        ReflectionServer.setMetadataFilter(async (meta: MetadataBlob): Promise<MetadataBlob> => {
            const roleKey = AuthLogic.currentRoleKey();
            if (roleKey == null)
                return meta; // no role (pre-login / auth off) → unfiltered

            // ---- Queries ---------------------------------------------------------------------------
            // Drop the queries the role may not see. The query dimension already COERCES a no-rule query
            // to its root type's UI-read allowance (Signum's AutomaticUpgradeOfQueries), so honouring type
            // authorization falls out transitively — there is no separate TypeAuthLogic pass here.
            if (QueryAuthLogic.isStarted()) {
                const queryNames = QueryLogic.queries.getQueryNames();
                const allowed = await Promise.all(queryNames.map(qn => QueryAuthLogic.getQueryAllowedByKey(getKey(qn), roleKey)));
                queryNames.forEach((qn, i) => {
                    if (allowed[i] === QueryAllowed.None) {
                        const tm = meta.types[ReflectionServer.metadataNameForQuery(qn)];
                        if (tm != null) tm.hasQuery = false;
                    }
                });
            }

            // ---- Types -----------------------------------------------------------------------------
            // The role's coarse MAX UI-read allowance per type (Signum's TypeInfo.maxTypeAllowed). Only
            // RESTRICTED types (< Write) are stamped; the client treats an absent value as unrestricted.
            if (TypeAuthLogic.isStarted()) {
                for (const [ctor] of Connector.current().schema.tables) {
                    if (typeof ctor !== "function") continue;
                    let typeId: PrimaryKey;
                    try { typeId = TypeLogic.typeToId(ctor); } catch { continue; } // enum/view — not type-auth'd
                    const maxUI = await TypeAuthLogic.maxTypeAllowedUI(typeId, roleKey);
                    if (maxUI < TypeAllowedBasic.Write) {
                        const tm = meta.types[ctor.name];
                        // Coarse, like Signum's single-valued blob entry: min == max == the shipped value.
                        if (tm != null) { tm.minTypeAllowed = maxUI; tm.maxTypeAllowed = maxUI; }
                    }
                }
            }

            // ---- Properties ------------------------------------------------------------------------
            // NEW vs the pre-Metadata blob, which had no property channel at all: the property dimension
            // was enforced only in the server serializer, so a hidden field still rendered (empty) and a
            // read-only one still looked editable until save. The Lines layer reads these.
            if (PropertyAuthLogic.isStarted()) {
                for (const [typeName, byPath] of await PropertyAuthLogic.restrictedRoutesForRole(roleKey)) {
                    const tm = meta.types[typeName];
                    if (tm == null) continue;
                    for (const [path, allowed] of byPath) {
                        const fm = tm.fields[path] ??= {};
                        fm.propertyAllowed = allowed.fallback;
                        fm.minPropertyAllowed = allowed.min;
                        fm.maxPropertyAllowed = allowed.max;
                    }
                }
            }

            // ---- Permissions -----------------------------------------------------------------------
            // Signum ships a `permissions: { [key]: boolean }` side map in its reflection response and the
            // client reads it through AuthClient.Options.isPermissionAuthorized. altea has no side map: a
            // symbol container is already ONE Container TypeMetadata whose fields are its members, so the
            // role's answer goes on the member's own entry. Only DENIED permissions are stamped.
            if (PermissionAuthLogic.isStarted()) {
                for (const symbol of declaredSymbolsForType(PermissionSymbol)) {
                    const dot = symbol.key.indexOf(".");
                    if (dot < 0) continue;
                    if (await PermissionAuthLogic.isAuthorizedForRole(symbol as PermissionSymbol, roleKey))
                        continue;
                    const tm = meta.types[symbol.key.slice(0, dot)];
                    if (tm == null) continue;
                    (tm.fields[symbol.key.slice(dot + 1)] ??= {}).allowed = false;
                }
            }

            return meta;
        });
    }
}

// (The min/maxTypeAllowed + *PropertyAllowed fields stamped above are declared by interface expansion in
// ../data/Rules — the DATA layer, so client and server share one declaration.)
