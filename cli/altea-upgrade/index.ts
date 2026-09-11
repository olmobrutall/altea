// The source-editing toolkit an UPGRADE is written with, as one import.
//
// altea-clone and altea-simplify reach the same modules by RELATIVE path (`../altea-upgrade/Git.js`)
// rather than through this barrel or a package dependency — see the tsconfigs. These tools declare no
// dependencies at all, so that nothing has to be installed before they can run.

export { UpgradeContext } from "./UpgradeContext.js";
export { CodeFile, WarningLevel, type LinePredicate, type SpanOption } from "./CodeFile.js";
export { Git } from "./Git.js";
export { Prompt, type Choice } from "./Prompt.js";
export { UpgradeBase, UpgradeRunner, LEDGER_FILE } from "./UpgradeRunner.js";
export { parseArguments, type Arguments } from "./Arguments.js";
