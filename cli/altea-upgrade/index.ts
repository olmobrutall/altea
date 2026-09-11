// The source-editing toolkit an UPGRADE is written with, as one import.
//
// Only what THIS package owns. Locating the application, git, the console and argument parsing are
// shared with the other CLIs and live in `@altea/altea-cli-utils` — a CLI must not depend on another
// CLI, so the common half has a package of its own.

export { UpgradeContext } from "./UpgradeContext.js";
export { CodeFile, WarningLevel, type LinePredicate, type SpanOption } from "./CodeFile.js";
export { UpgradeBase, UpgradeRunner, LEDGER_FILE } from "./UpgradeRunner.js";
