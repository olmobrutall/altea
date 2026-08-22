import * as basics from "@altea/altea/data/basics";
import * as lite from "@altea/altea/data/lite";
import * as entity from "@altea/altea/data/entity";
import * as validators from "@altea/altea/data/validators";
import * as clock from "@altea/altea/data/utils/clock";
import * as table from "@altea/altea/server/table";
import * as database from "@altea/altea/server/Database";
import * as operationLogic from "@altea/altea/server/operationLogic";
import * as userHolder from "@altea/altea/server/userHolder";
import * as executionMode from "@altea/altea/server/executionMode";

// Port of Signum's `EvalLogic.AssemblyTypes` / `EvalLogic.Namespaces` — the FRAMEWORK's own surface, which
// Signum seeds ITSELF (mscorlib, System.Linq, Signum.Utilities, …) so an application's Starter registers
// only what is app-specific. Southwind calls `EvalLogic.Start(sb)` and adds nothing.
//
// altea's registry is module-based (a TypeScript import names a module, not a namespace — see EvalLogic's
// header), so the equivalent is this table: every `@altea/altea` module a stored script can reasonably need,
// registered by the eval module itself at start. A module OUTSIDE the framework registers its own from its
// own `Logic.start` (altea-workflow does), and the APP registers only its entity domains.
export const frameworkModules: Record<string, unknown> = {
    "@altea/altea/data/basics": basics,               // Decimal, Temporal, toInt, int
    "@altea/altea/data/lite": lite,
    "@altea/altea/data/entity": entity,
    "@altea/altea/data/validators": validators,
    "@altea/altea/data/utils/clock": clock,           // Clock.now / Clock.today — Signum seeds DateTime too
    "@altea/altea/server/table": table,               // table(X) — the query entry point
    "@altea/altea/server/Database": database,
    "@altea/altea/server/operationLogic": operationLogic, // Operations.execute / construct
    "@altea/altea/server/userHolder": userHolder,
    "@altea/altea/server/executionMode": executionMode,
};

/**
 * Signum's `GetUsingNamespaces()` — the import lines every generated eval gets for free. Kept small on
 * purpose: these four cover almost every script (a decimal comparison, a query, an operation, the user).
 */
export const frameworkPreamble: readonly string[] = [
    `import { Decimal, Temporal, toInt } from "@altea/altea/data/basics";`,
    `import { table } from "@altea/altea/server/table";`,
    `import { Operations } from "@altea/altea/server/operationLogic";`,
    `import { UserHolder } from "@altea/altea/server/userHolder";`,
];
