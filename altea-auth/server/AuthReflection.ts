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

// Role-filtering overlay on the reflection metadata blob.
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
            // to its root type's UI-read allowance, so honouring type
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
            // The role's coarse MAX UI-read allowance per type. Only RESTRICTED types (< Write) are
            // stamped; the client treats an absent value as unrestricted.
            //
            // A type the role cannot read AT ALL is reduced to that one fact. Everything else the entry
            // holds — the nice names, the route labels, the operations, the registered expressions — is
            // describing a type no page can open, no query can return and no control can render. Signum
            // drops such a type from the blob outright (its TypeExtension returns null, and for an
            // anonymous user it does so for EVERY entity); altea keeps the husk because its client reads
            // "no entry" as UNRESTRICTED, so dropping it would turn a forbidden type into an allowed one.
            // The husk says the opposite, in about forty bytes.
            //
            // The anonymous role is where this is felt: /publicCatalog is served to a logged-out visitor,
            // and its boot blob described all 267 entity types — 78KB of 122KB — every one of them None.
            if (TypeAuthLogic.isStarted()) {
                const caches = await TypeLogic.caches();
                for (const [ctor] of Connector.current().schema.tables) {
                    if (typeof ctor !== "function") continue;
                    // undefined for an enum side-table / view — not type-auth'd.
                    const typeId = caches.tryTypeToId(ctor);
                    if (typeId == null) continue;
                    const maxUI = await TypeAuthLogic.maxTypeAllowedUI(typeId, roleKey);
                    if (maxUI >= TypeAllowedBasic.Write) continue;

                    const tm = meta.types[ctor.name];
                    if (tm == null) continue;
                    // COARSE: min == max == the shipped value, so only `max` is written — the same rule
                    // the property allowances follow, and the reader falls back min → max.
                    if (maxUI === TypeAllowedBasic.None)
                        meta.types[ctor.name] = { kind: tm.kind, fields: {}, maxTypeAllowed: maxUI };
                    else
                        tm.maxTypeAllowed = maxUI;
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

                    // A property rule on a type the role cannot READ AT ALL says nothing new: the retrieve
                    // gate refuses the entity, so no instance ever reaches a control that could consult it.
                    // The type pass above has already stamped that answer, so it is known here.
                    //
                    // This is not a micro-optimisation. For the ANONYMOUS blob — which every client fetches
                    // at boot, before login, to render the login page — every type is None, and these were
                    // 1951 of 1971 property entries: 170KB of a 276KB response spent restating "you cannot
                    // read this" once per property of something you already cannot read.
                    if (tm.maxTypeAllowed === TypeAllowedBasic.None)
                        continue;

                    for (const [path, allowed] of byPath) {
                        const fm = tm.fields[path] ??= {};
                        fm.propertyAllowed = allowed.fallback;
                        // The range is shipped only where there IS a range. The coarse case — no type
                        // condition, so min == max == fallback — is every property of most roles, and
                        // saying one number three times is the shape the reader defaults away anyway.
                        if (allowed.min !== allowed.fallback) fm.minPropertyAllowed = allowed.min;
                        if (allowed.max !== allowed.fallback) fm.maxPropertyAllowed = allowed.max;
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
