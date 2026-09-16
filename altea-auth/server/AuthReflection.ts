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
                        // DELETE, not `= false`: absent is how the builder says "no query" already, so a
                        // shipped `false` is eleven bytes spent restating the default.
                        if (tm != null) delete tm.hasQuery;
                    }
                });
            }

            // ---- Types -----------------------------------------------------------------------------
            // A type the role cannot read AT ALL is REMOVED — Signum's TypeExtension returning null, and
            // the reason a readable type keeps an entry even with nothing in it: presence in `types` is
            // what says "you may read this", so the client's gates read an absent entry as forbidden.
            //
            // Everything such an entry used to hold — the nice names, the route labels, the operations,
            // the registered expressions — described a type no page can open, no query can return and no
            // control can render. The anonymous role is where that is felt: /publicCatalog is served to a
            // logged-out visitor, and its boot blob described all 267 entity types, every one of them None.
            //
            // Only the remaining RESTRICTED types (Read, i.e. < Write) are stamped; an unrestricted one
            // says nothing, because the reader's default for a present entry is Write.
            if (TypeAuthLogic.isStarted()) {
                const caches = await TypeLogic.caches();
                for (const [ctor] of Connector.current().schema.tables) {
                    if (typeof ctor !== "function") continue;
                    // undefined for an enum side-table / view — not type-auth'd.
                    const typeId = caches.tryTypeToId(ctor);
                    if (typeId == null) continue;
                    const maxUI = await TypeAuthLogic.maxTypeAllowedUI(typeId, roleKey);
                    if (maxUI >= TypeAllowedBasic.Write) continue;

                    if (maxUI === TypeAllowedBasic.None) {
                        delete meta.types[ctor.name];
                        continue;
                    }
                    const tm = meta.types[ctor.name];
                    // COARSE: one number, the best case across every type-condition slice — which is what
                    // the UI gates on, having no row to evaluate a condition against.
                    if (tm != null) tm.maxTypeAllowed = maxUI;
                }
            }

            // ---- Properties ------------------------------------------------------------------------
            // NEW vs the pre-Metadata blob, which had no property channel at all: the property dimension
            // was enforced only in the server serializer, so a hidden field still rendered (empty) and a
            // read-only one still looked editable until save. The Lines layer reads these.
            //
            // A property entry exists only where the property is STRICTER THAN ITS TYPE (Signum's
            // `if (!pac.Equals(tac))`). A rule that merely repeats the type's own answer tells the client
            // nothing: the type entry is right there, and the reader falls back to it. Two cases, both of
            // them common, collapse to nothing at all:
            //
            //  - a type the role cannot READ is gone from the blob entirely (the pass above), and with it
            //    every property of it. For the ANONYMOUS blob — fetched by every client at boot, before
            //    login, to render the login page — that was 1951 of 1971 property entries;
            //  - a Read-only type whose properties are Read. Every one of them used to be spelled out.
            if (PropertyAuthLogic.isStarted()) {
                for (const [typeName, byPath] of await PropertyAuthLogic.restrictedRoutesForRole(roleKey)) {
                    const tm = meta.types[typeName];
                    if (tm == null) continue; // the role cannot read the type — the absent entry says it all

                    // The type's own allowance, read as a property one: TypeAllowedBasic and
                    // PropertyAllowed are the same three ascending levels (None 0, Read 1, Write 2), and
                    // an absent `maxTypeAllowed` means unrestricted.
                    const typeAllowed: number = tm.maxTypeAllowed ?? TypeAllowedBasic.Write;

                    for (const [path, allowed] of byPath) {
                        // MAX — the best case across every type-condition slice. The client has no row to
                        // evaluate conditions against, and hiding a property the user may well be allowed
                        // to edit for THIS row is the worse error; the serializer still enforces the exact
                        // per-instance answer on the way in and out. `fallback` and `min` were shipped
                        // beside it and read by nothing.
                        if (allowed.max as number === typeAllowed) continue;
                        // `routes`, keyed by the owner-rooted path the rule is written against — NOT
                        // `fields`, which is keyed by (declaring type, member) and knows nothing of paths.
                        ((tm.routes ??= {})[path] ??= {}).propertyAllowed = allowed.max;
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
