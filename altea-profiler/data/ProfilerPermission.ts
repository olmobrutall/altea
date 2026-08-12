import { init } from "@altea/altea/data/reflection";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum's ProfilerPermission (Signum.Profiler/ProfilerPermissions.cs). Reuses altea-auth's ONE
// PermissionSymbol class/table (Signum keeps all permissions in the PermissionSymbol table too) — the
// quote-transformer rewrites each `init()` into `init(PermissionSymbol, "ProfilerPermission.<Member>", …)`,
// registering it in the declared-symbols set that SymbolLogic.start(sb, PermissionSymbol) seeds. So just
// importing this module (ProfilerLogic does) is enough for these to be seeded and authorizable — no extra
// SymbolLogic.start is needed (the auth module already starts PermissionSymbol).
export namespace ProfilerPermission {
    export const ViewTimeTracker: PermissionSymbol = init();
    export const ViewHeavyProfiler: PermissionSymbol = init();
    export const OverrideSessionTimeout: PermissionSymbol = init();
}
