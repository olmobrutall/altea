// SafeConsole moved to @altea/altea (server/safeConsole) when core's own sync flow needed it — see the
// header there. Re-exported unchanged so this package's callers, and any app importing it from here,
// keep working.
export { SafeConsole, Color } from "@altea/altea/server/safeConsole";
