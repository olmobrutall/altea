import { init } from "@altea/altea/data/reflection";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum.Caching's CachePermissions.cs — see docs/port/Cache.md.
//
// IMPORTING this module (CacheLogic does) is what seeds these: the transformer rewrites each `init()` into
// `init(PermissionSymbol, "CachePermission.<Member>", …)`, registering it in the declared-symbols set
// `SymbolLogic.start(sb, PermissionSymbol)` reads.
export namespace CachePermission {
    export const ViewCache: PermissionSymbol = init();
    export const InvalidateCache: PermissionSymbol = init();
}
