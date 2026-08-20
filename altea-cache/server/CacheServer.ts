import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { GlobalLazy } from "@altea/altea/server/globalLazy";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import type { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { CachePermission } from "../data/CachePermission";
import type { CacheStateTS, CacheTableTS, InvalidateAllRequest, InvalidateTableRequest, ResetLazyStatsTS } from "../data/CacheState";
import { CacheLogic } from "./CacheLogic";
import { CachedTableLite, type CachedTableBase } from "./CachedTable";
import { SimpleHttpBroadcast } from "./Broadcast/SimpleHttpBroadcast";

// Port of Signum's CacheController (Signum.Caching/CacheController.cs): the statistics panel's data plus
// the enable / disable / clear actions, and the two ANONYMOUS endpoints a SimpleHttpBroadcast peer posts to.
export namespace CacheServer {
    export function start(ws: WebBuilder): void {
        // GET /api/cache/view — the whole panel payload.
        ws.get("/api/cache/view", { res: CustomType<CacheStateTS>() }, async (_req, res) => {
            await assertAuthorized(CachePermission.ViewCache);
            res.json({
                isEnabled: !CacheLogic.globallyDisabled,
                // Always false: SQL Server query notifications are not portable to Node (see CacheLogic).
                // Kept so the panel reads like Signum's.
                sqlDependency: false,
                serverBroadcast: CacheLogic.serverBroadcast?.toString() ?? null,
                tables: CacheLogic.statistics().map(toTableTS),
                lazies: GlobalLazy.statistics().map(toLazyTS),
            });
        });

        ws.post("/api/cache/enable", {}, async (_req, res) => {
            await assertAuthorized(CachePermission.ViewCache);
            CacheLogic.globallyDisabled = false;
            res.status(204).end();
        });

        ws.post("/api/cache/disable", {}, async (_req, res) => {
            await assertAuthorized(CachePermission.ViewCache);
            CacheLogic.globallyDisabled = true;
            res.status(204).end();
        });

        // Signum's Clear: drop the cached tables AND every global lazy, here and (via the broadcast) on
        // every sibling process.
        ws.post("/api/cache/clear", {}, async (_req, res) => {
            await assertAuthorized(CachePermission.InvalidateCache);
            CacheLogic.invalidateAll();
            res.status(204).end();
        });

        // ---- The SimpleHttpBroadcast peer endpoints (Signum's [SignumAllowAnonymous] pair) ----------
        // ANONYMOUS on purpose: the caller is a sibling SERVER, not a user. Each body carries a hash of
        // the shared broadcast secret, which the transport verifies — a wrong hash throws.

        ws.post("/api/cache/invalidateTable",
            { req: CustomType<InvalidateTableRequest>(), allowAnonymous: true },
            async (req, res) => {
                httpBroadcast().invalidateTable(await req.jsonTyped() as InvalidateTableRequest);
                res.status(204).end();
            });

        ws.post("/api/cache/invalidateAll",
            { req: CustomType<InvalidateAllRequest>(), allowAnonymous: true },
            async (req, res) => {
                httpBroadcast().invalidateAllTables(await req.jsonTyped() as InvalidateAllRequest);
                res.status(204).end();
            });
    }
}

function httpBroadcast(): SimpleHttpBroadcast {
    const sb = CacheLogic.serverBroadcast;
    if (!(sb instanceof SimpleHttpBroadcast))
        throw new Error("The server broadcast is not a SimpleHttpBroadcast");
    return sb;
}

async function assertAuthorized(permission: PermissionSymbol): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(permission)))
        throw new UnauthorizedAccessException(`Not authorized for '${permission.key}'`);
}

function toTableTS(ct: CachedTableBase): CacheTableTS {
    return {
        tableName: ct.table.name.name,
        typeName: ct.typeName,
        count: ct.count,
        hits: ct.hits,
        invalidations: ct.invalidations,
        loads: ct.loads,
        sumLoadTime: niceTime(ct.sumLoadTime),
        subTables: ct.subTables.length === 0 ? undefined : ct.subTables.map(toTableTS),
        columns: ct instanceof CachedTableLite ? ct.cachedColumnNames : undefined,
    };
}

function toLazyTS(lazy: { name?: string, hits: number, invalidations: number, loads: number, sumLoadTime: number }): ResetLazyStatsTS {
    return {
        typeName: lazy.name ?? "?",
        hits: lazy.hits,
        invalidations: lazy.invalidations,
        loads: lazy.loads,
        sumLoadTime: niceTime(lazy.sumLoadTime),
    };
}

// Signum renders a TimeSpan through NiceToString; altea's stats are plain milliseconds.
function niceTime(ms: number): string {
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    if (ms < 60_000)
        return `${(ms / 1000).toFixed(2)}s`;
    const totalSeconds = Math.round(ms / 1000);
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
