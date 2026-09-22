import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { StablePromise } from "@altea/altea/server/stablePromise";
import type { WorkflowConfigurationEmbedded } from "../data/Workflow";
import { WorkflowLogic } from "./WorkflowLogic";
import { CaseActivityLogic } from "./CaseActivityLogic";
import { WorkflowEventTaskLogic } from "./WorkflowEventTaskLogic";
import { WorkflowServer } from "./WorkflowServer";

// Port of Signum.Workflow's WorkflowLogicStarter.cs — the ONE call an app makes. See
// port/Workflow.md.
//
// `TypeHelpLogic` (the C#-source browser that fed Signum's eval editors) is not started here; it
// goes with the Eval deferral. The HTTP surface is mounted from here rather than from WorkflowLogic.start,
// because it needs all three logic layers to be registered first.

export namespace WorkflowLogicStarter {
    export function start(sb: SchemaBuilder,
        getConfiguration: () => StablePromise<WorkflowConfigurationEmbedded>): void {
        WorkflowLogic.start(sb, getConfiguration);
        CaseActivityLogic.start(sb);
        WorkflowEventTaskLogic.start(sb);

        if (sb.webBuilder)
            WorkflowServer.start(sb.webBuilder);
    }
}
