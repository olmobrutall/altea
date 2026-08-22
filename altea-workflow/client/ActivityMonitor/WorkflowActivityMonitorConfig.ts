import type { Lite } from "@altea/altea/data/lite";
import type { ColumnOptionParsed, FilterOptionParsed } from "@altea/altea/client/FindOptions";
import type { WorkflowEntity } from "../../data/Workflow";

// Signum declares this interface inside ActivityMonitor/WorkflowActivityMonitorPage.tsx. altea splits it out
// so the RENDERER (client/Bpmn) and the STATS MODAL can import it without importing the page — a page module
// pulls in bpmn-js and the whole viewer, which is exactly what a lazily-imported route is meant to avoid.
export interface WorkflowActivityMonitorConfig {
    workflow: Lite<WorkflowEntity>;
    filters: FilterOptionParsed[];
    columns: ColumnOptionParsed[];
}
