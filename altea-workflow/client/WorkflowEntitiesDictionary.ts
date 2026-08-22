import type { ModelEntity } from "@altea/altea/data/entity";

// Signum declares this in Signum.Workflow.t4s (the hand-written half of its generated client twin):
// the designer's working set — one MODEL per bpmn element id, mutated in place as the user edits shapes and
// posted back inside a WorkflowModel when the workflow is saved.
export interface WorkflowEntitiesDictionary {
    [bpmnElementId: string]: ModelEntity;
}
