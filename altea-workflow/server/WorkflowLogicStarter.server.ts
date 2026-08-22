import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { WorkflowConfigurationEmbedded } from "../data/Workflow";
import { WorkflowLogic } from "./WorkflowLogic.server";
import { CaseActivityLogic } from "./CaseActivityLogic.server";
import { WorkflowEventTaskLogic } from "./WorkflowEventTaskLogic.server";
import { WorkflowServer } from "./WorkflowServer.server";

// Port of Signum.Workflow's WorkflowLogicStarter.cs — the ONE call an app makes.
//
// altea divergence: Signum starts `TypeHelpLogic` here (the C#-source browser that fed the eval editors); it
// goes with the Eval deferral. The HTTP surface is mounted from here rather than from WorkflowLogic.start,
// because it needs all three logic layers to be registered first.

export namespace WorkflowLogicStarter {
    export function start(sb: SchemaBuilder, getConfiguration: () => WorkflowConfigurationEmbedded): void {
        WorkflowLogic.start(sb, getConfiguration);
        CaseActivityLogic.start(sb);
        WorkflowEventTaskLogic.start(sb);

        if (sb.webBuilder)
            WorkflowServer.start(sb.webBuilder);
    }
}
