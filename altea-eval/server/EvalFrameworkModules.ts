import * as basics from "@altea/altea/data/basics";
import * as lite from "@altea/altea/data/lite";
import * as entity from "@altea/altea/data/entity";
import * as validators from "@altea/altea/data/validators";
import * as reflection from "@altea/altea/data/reflection";
import * as clock from "@altea/altea/data/utils/clock";
import * as table from "@altea/altea/server/table";
import * as database from "@altea/altea/server/Database";
import * as operationLogic from "@altea/altea/server/operationLogic";
import * as userHolder from "@altea/altea/server/userHolder";
import * as executionMode from "@altea/altea/server/executionMode";

// The FRAMEWORK's own surface, seeded by the eval module ITSELF: every `@altea/altea` module a stored
// script can reasonably need. A module OUTSIDE the framework registers its own from its own `Logic.start`
// (altea-workflow does), and the APP registers only its entity domains.
//
// See docs/port/Eval.md.
export const frameworkModules: Record<string, unknown> = {
    "@altea/altea/data/basics": basics,               // Decimal, Temporal, toInt, int
    "@altea/altea/data/lite": lite,
    "@altea/altea/data/entity": entity,
    "@altea/altea/data/validators": validators,
    // FieldInfo / TypeInfo / PropertyRoute-adjacent reflection: a script HANDED one of these needs its
    // type, which is what @altea/altea-dynamic's DynamicValidation does (its evaluator receives the
    // FieldInfo being validated, Signum's PropertyInfo).
    "@altea/altea/data/reflection": reflection,
    "@altea/altea/data/utils/clock": clock,           // Clock.now / Clock.today — Signum seeds DateTime too
    "@altea/altea/server/table": table,               // table(X) — the query entry point
    "@altea/altea/server/Database": database,
    "@altea/altea/server/operationLogic": operationLogic, // Operations.execute / construct
    "@altea/altea/server/userHolder": userHolder,
    "@altea/altea/server/executionMode": executionMode,
};

/**
 * The import lines every generated eval gets for free. Kept small on
 * purpose: these four cover almost every script (a decimal comparison, a query, an operation, the user).
 */
export const frameworkPreamble: readonly string[] = [
    `import { Decimal, Temporal, toInt } from "@altea/altea/data/basics";`,
    `import { table } from "@altea/altea/server/table";`,
    `import { Operations } from "@altea/altea/server/operationLogic";`,
    `import { UserHolder } from "@altea/altea/server/userHolder";`,
];
