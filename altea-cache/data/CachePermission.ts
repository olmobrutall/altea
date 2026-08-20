import { init } from "@altea/altea/data/reflection";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum's CachePermission (Signum.Caching/CachePermissions.cs). Reuses altea-auth's ONE
// PermissionSymbol class/table — the quote-transformer rewrites each `init()` into
// `init(PermissionSymbol, "CachePermission.<Member>", …)`, registering it in the declared-symbols set that
// `SymbolLogic.start(sb, PermissionSymbol)` seeds. Importing this module (CacheLogic does) is enough for
// these to be seeded and authorizable.
export namespace CachePermission {
    export const ViewCache: PermissionSymbol = init();
    export const InvalidateCache: PermissionSymbol = init();
}
