import "@altea/altea/data/globals/arrayExtensions";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    Column, FilterCondition, FilterOperation, Pagination, QueryRequest, type Filter,
} from "@altea/altea/server/dynamicQuery/requests";
import { AggregateToken } from "@altea/altea/data/dynamicQuery/tokens/aggregateToken";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { Lite } from "@altea/altea/data/lite";
import { CaseActivityEntity } from "../data/CaseActivity";
import type { IWorkflowNodeEntity, WorkflowEntity } from "../data/Workflow";
import type { WorkflowActivityMonitor } from "../data/WorkflowDtos";

// Port of Signum.Workflow's WorkflowActivityMonitorLogic.cs — "how many cases sit on each activity of this
// workflow, and what do my aggregate columns say about them". ONE grouped query over CaseActivity, with
// `WorkflowActivity` + `Count` prepended to whatever aggregates the client asked for.
//
// altea divergences:
//  - `QueryLogic.Queries.QueryDescription(...)` + `QueryUtils.Parse(...)` become `QueryLogic.getToken` (there
//    is no QueryDescription DTO), and the request's filters / columns arrive ALREADY PARSED — the route does
//    the wire → engine translation with the shared `parseQueryRequest` machinery.

/** The parsed request (Signum's WorkflowActivityMonitorRequest). */
export interface ParsedWorkflowActivityMonitorRequest {
    workflow: Lite<WorkflowEntity>;
    /** Filters over the CASE ACTIVITY query (the client builds them rootless, over `case.…`). */
    filters: Filter[];
    /** Aggregate columns over the case activity — anything else is rejected. */
    columns: Column[];
}

export namespace WorkflowActivityMonitorLogic {

    export async function getWorkflowActivityMonitor(
        request: ParsedWorkflowActivityMonitorRequest): Promise<WorkflowActivityMonitor> {

        // Signum: `if (request.Columns.Any(c => !(c.Token is AggregateToken))) throw`.
        if (request.columns.some(c => !(c.token instanceof AggregateToken)))
            throw new Error("Invalid columns: the activity monitor only accepts aggregates");

        const token = (s: string): ReturnType<typeof QueryLogic.getToken> =>
            QueryLogic.getToken(CaseActivityEntity, s, SubTokensOptionsAll);

        // Signum's token strings are `"Entity.Case.Workflow"` / `"Entity.WorkflowActivity"` / `"Count"`.
        // altea's grammar is ROOTLESS and its entity-property keys are the FIELD names (camelCase), while the
        // system tokens stay PascalCase — so `case.workflow` / `workflowActivity` / `Count`.
        const filters: Filter[] = [
            new FilterCondition(token("case.workflow"), FilterOperation.EqualTo, request.workflow),
            ...request.filters,
        ];

        const columns: Column[] = [
            new Column(token("workflowActivity")),
            new Column(token("Count")),
            ...request.columns,
        ];

        const rt = await QueryLogic.queries.executeQueryAsync(
            new QueryRequest(CaseActivityEntity, filters, [], columns, new Pagination.All(), true));

        const customCols = rt.columns.slice(2);

        return {
            workflow: request.workflow,
            customColumns: request.columns.map(a => a.token.fullKey()),
            activities: rt.rows.map(row => ({
                workflowActivity: row.value(0) as Lite<IWorkflowNodeEntity>,
                caseActivityCount: row.value(1) as never,
                customValues: customCols.map(c => row.value(c.index)),
            })),
        };
    }
}
