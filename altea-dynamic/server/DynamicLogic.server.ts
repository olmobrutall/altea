import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { DynamicPanelPermission } from "../data/DynamicPanel";
import { DynamicViewLogic } from "./DynamicViewLogic.server";
import { DynamicCSSOverrideLogic } from "./DynamicCSSOverrideLogic.server";
import { DynamicSqlMigrationLogic } from "./DynamicSqlMigrationLogic.server";

// Port of Signum.Dynamic's DynamicLogic.cs — but only its ROLE as the module's entry point. The BODY of
// Signum's DynamicLogic does not port at all, and that is the single most important thing to know about this
// package, so it is written out here rather than buried in a commit message.
//
// ---- What Signum.Dynamic is, and why it splits in two --------------------------------------------------
//
// Signum.Dynamic lets an administrator define parts of the application from the running app itself. Its
// features fall into two groups, divided by ONE question: does the feature need a COMPILER?
//
//   INTERPRETED — ported, and this is the whole package:
//     DynamicView / DynamicViewOverride / DynamicViewSelector  a view is a JSON node TREE plus small
//                                                              JavaScript snippets; the client interprets
//                                                              it (client/View/NodeUtils + Nodes). Nothing
//                                                              is compiled, so it ports as-is.
//     DynamicCSSOverride                                       a stylesheet, as text.
//     DynamicSqlMigration                                      a schema-diff script, as text.
//
//   COMPILED — NOT ported:
//     DynamicType, DynamicExpression, DynamicValidation, DynamicApi, DynamicTypeCondition,
//     DynamicMixinConnection, DynamicIsolation
//
// Every member of the second group works the same way: it GENERATES C# source into a `CodeGen` directory,
// compiles it with Roslyn (`Microsoft.CodeAnalysis.CSharp`, via Signum.Eval) into `CodeGenAssembly.dll`,
// loads that assembly, and RESTARTS the application server so the new types take part in the schema. There
// is no counterpart for that here, and the gap is not the compiler itself — TypeScript has one, and altea
// already drives it (`tspc -b`). It is that altea's entity model is stamped onto each class at BUILD time by
// the quote-transformer, so a type invented at runtime would need the transformer to run over generated
// source, the process to restart, and the schema to be synchronized — a design project, not a port. If it is
// ever wanted, it belongs in its own package on top of this one.
//
// Consequently Signum.Eval does not port either (it IS the Roslyn host), and two of its pieces that this
// package would otherwise use are re-homed:
//   - `EvalPanelPermission.ViewDynamicPanel` becomes `DynamicPanelPermission.ViewDynamicPanel` (data/DynamicPanel).
//   - `EvalClient.Options.registerDynamicPanelSearch`, the registry behind the panel's search box, becomes
//     `DynamicClient.registerDynamicPanelSearch` (client/DynamicClient).
// And `DynamicPanelPermission.RestartApplication` is dropped: there is no compilation step to restart for.
export namespace DynamicLogic {

    export function start(sb: SchemaBuilder, options?: {
        views?: boolean;
        cssOverrides?: boolean;
        sqlMigrations?: boolean;
    }): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's `PermissionLogic.RegisterPermissions(…)`: in altea a symbol is seeded merely by being
        // declared and imported, so referencing it here is what registers it.
        void DynamicPanelPermission.ViewDynamicPanel;

        // Each sub-module is opt-in, because each is independently useful and they share nothing but the
        // panel. Signum starts them from the application's Starter one by one; the flags keep that choice
        // while giving the app a single call.
        if (options?.views ?? true)
            DynamicViewLogic.start(sb);

        if (options?.cssOverrides ?? true)
            DynamicCSSOverrideLogic.start(sb);

        if (options?.sqlMigrations ?? true)
            DynamicSqlMigrationLogic.start(sb);
    }
}
