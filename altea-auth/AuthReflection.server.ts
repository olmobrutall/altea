import { table } from "@altea/altea/server/table";
import { ReflectionServer, type ServerMetadata } from "@altea/altea/server/reflectionServer";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { AuthLogic } from "./AuthLogic.server";
import { TypeAuthLogic } from "./TypeAuthLogic.server";
import { TypeAllowedBasic } from "./Rules.data";

// Role-filtering overlay on the reflection blob (Signum's AuthServer reflection extensions) — COARSE
// type slice: for the current role, drop the queries whose underlying entity type is not UI-readable.
// (Query/property/operation-auth overlays + per-type annotations land with their slices.) Installed
// once at web-host startup; runs inside each request's user scope, so it sees the current role.
export namespace AuthReflectionServer {
    let _typeByClean: Map<string, PrimaryKey> | undefined;

    async function typeByCleanName(): Promise<Map<string, PrimaryKey>> {
        if (_typeByClean != null)
            return _typeByClean;
        const rows = await table(TypeEntity).toArray() as TypeEntity[];
        _typeByClean = new Map(rows.map(t => [t.cleanName, t.id]));
        return _typeByClean;
    }

    export function invalidate(): void {
        _typeByClean = undefined;
    }

    export function install(): void {
        ReflectionServer.setMetadataFilter(async (meta: ServerMetadata): Promise<ServerMetadata> => {
            const roleKey = AuthLogic.currentRoleKey();
            if (roleKey == null)
                return meta; // no role (pre-login / auth off) → unfiltered; the client guard gates the UI

            const byClean = await typeByCleanName();
            const queries: string[] = [];
            for (const q of meta.queries) {
                const typeId = byClean.get(q);
                if (typeId == null) {
                    queries.push(q); // not an entity-ctor query → leave it (coarse)
                    continue;
                }
                if (await TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Read, true, roleKey))
                    queries.push(q);
            }
            return { ...meta, queries };
        });
    }
}
