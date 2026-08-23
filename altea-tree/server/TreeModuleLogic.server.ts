import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { OmniboxParser } from "@altea/altea-omnibox/server/OmniboxParser";
import { TreeServer } from "./TreeServer.server";
import { TreeOmniboxResultGenerator } from "./TreeOmniboxResultGenerator.server";
import { UserTreePartLogic } from "./UserTreePartLogic.server";

// The module's entry point (Signum's `TreeServer.Start` + `UserTreePartLogic.Start`, which its apps call
// separately). The tree ENGINE is not started here: it is per-type, and a type opts in with
// `sb.include(MyTree).withTree()` (Signum's same `WithTree`).
//
// altea divergence: `ReflectionServer.RegisterLike(typeof(TreeEntity), …)` has no counterpart — altea ships
// ONE metadata blob and a type is included by being registered, with no per-container visibility predicate
// to attach (the note every altea module's server carries).
export namespace TreeModuleLogic {

    let started = false;

    export function start(sb: SchemaBuilder, options?: { dashboardPart?: boolean }): void {
        if (started)
            return;
        started = true;

        if (options?.dashboardPart !== false)
            UserTreePartLogic.start(sb);

        if (sb.webBuilder != null) {
            TreeServer.start(sb.webBuilder);
            OmniboxParser.generators.push(new TreeOmniboxResultGenerator());
        }
    }
}
