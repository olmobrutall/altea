// The source-editing toolkit, re-exported so `altea-clone` and `altea-simplify` can use it.
//
// It lives HERE rather than in a fourth package because it IS the upgrade-writing API — an upgrade
// script's whole vocabulary is `UpgradeContext` + `CodeFile`. The other two CLIs need only a corner of
// it (finding the application, the three-casing rename, git, the prompts), which is not enough to earn
// a package of its own; the cost is that they depend on `altea-upgrade` for something that is not an
// upgrade.

export { UpgradeContext } from "./UpgradeContext.js";
export { CodeFile, WarningLevel, type LinePredicate, type SpanOption } from "./CodeFile.js";
export { Git } from "./Git.js";
export { Prompt, type Choice } from "./Prompt.js";
export { UpgradeBase, UpgradeRunner, LEDGER_FILE } from "./UpgradeRunner.js";
export { parseArguments, type Arguments } from "./Arguments.js";
