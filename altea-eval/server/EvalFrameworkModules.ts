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
import type { EvalImports } from "../data/EvalImports";

// The FRAMEWORK's own surface, seeded by the eval module ITSELF: every `@altea/altea` module a stored
// script can reasonably need. A module OUTSIDE the framework contributes its own from its own
// `Logic.start` (altea-workflow does), and the APP contributes only what only it can know.
//
// EAGER is kept to four lines on purpose. They are the vocabulary nearly every script uses — a decimal, a
// query, an operation, the current user — and an eager name is in scope in EVERY script, so a long eager
// list is a long list of names an author cannot use for anything else. Everything else is LAZY: the name
// is importable, and the import is written for the author when a script actually says it.
//
// Every module hands over its VALUE as well as its specifier. That is not redundancy: it pins the module
// a script reaches to the one the server is already running, rather than to whatever a fresh `import()`
// would resolve to — which matters for anything holding ambient state (a transaction, the user holder).
//
// See port/Eval.md.
export function frameworkImports(imports: EvalImports): EvalImports {
    return imports
        // ---- Eager: in scope in every script -------------------------------------------------------------
        .eager("@altea/altea/data/basics", ["Decimal", "Temporal", "toInt"], { value: basics })
        .eager("@altea/altea/server/table", ["table"], { value: table })
        .eager("@altea/altea/server/operationLogic", ["Operations"], { value: operationLogic })
        .eager("@altea/altea/server/userHolder", ["UserHolder"], { value: userHolder })

        // ---- Lazy: importable by name, loaded only when a script names one -------------------------------
        .lazy("@altea/altea/data/basics", "*", { value: basics })
        .lazy("@altea/altea/data/lite", "*", { value: lite })
        .lazy("@altea/altea/data/entity", "*", { value: entity })
        .lazy("@altea/altea/data/validators", "*", { value: validators })
        // FieldInfo / TypeInfo / PropertyRoute-adjacent reflection: a script HANDED one of these needs its
        // type, which is what @altea/altea-dynamic's DynamicValidation does (its evaluator receives the
        // FieldInfo being validated).
        .lazy("@altea/altea/data/reflection", "*", { value: reflection })
        .lazy("@altea/altea/data/utils/clock", "*", { value: clock })       // Clock.now / Clock.today
        .lazy("@altea/altea/server/table", "*", { value: table })
        .lazy("@altea/altea/server/Database", "*", { value: database })
        .lazy("@altea/altea/server/operationLogic", "*", { value: operationLogic })
        .lazy("@altea/altea/server/userHolder", "*", { value: userHolder })
        .lazy("@altea/altea/server/executionMode", "*", { value: executionMode });
}
