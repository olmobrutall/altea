import { SchemaBuilder } from "@altea/altea/server/schema";
import { ProfilerServer } from "./ProfilerServer";
// Importing the permission module evaluates its `init()` declarations, registering the profiler
// PermissionSymbols in the declared-symbols set that SymbolLogic.start(sb, PermissionSymbol) — already
// called by the auth module — seeds. So they end up in the PermissionSymbol table and are authorizable
// without any extra SymbolLogic.start here (which would double-start).
import "../data/ProfilerPermission";

// Port of Signum's ProfilerLogic (Signum.Profiler/ProfilerLogic.cs). Wires the profiler module into the
// schema build: it declares no entities of its own (the profiler state is in-memory), so start() just
// mounts the HTTP surface when a web host is present — mirroring `if (sb.WebServerBuilder != null)
// ProfilerServer.Start(...)`. The `timeTracker`/`heavyProfiler` flags gate which permissions matter (both
// on by default); `overrideSessionTimeout` (Signum's session-timeout override) is deferred.
export namespace ProfilerLogic {
    export interface Options {
        timeTracker?: boolean;
        heavyProfiler?: boolean;
        overrideSessionTimeout?: boolean;
    }

    export function start(sb: SchemaBuilder, _options: Options = {}): void {
        if (sb.alreadyDefined(start))
            return;

        if (sb.webBuilder)
            ProfilerServer.start(sb.webBuilder);
    }
}
