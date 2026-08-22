import { AsyncLocalStorage } from "node:async_hooks";
import type { CaseActivityEntity } from "../data/CaseActivity";
import { WorkflowActivityEntity, type WorkflowConnectionEntity } from "../data/WorkflowNodes";

// Port of Signum.Workflow's WorkflowActivityInfo (WorkflowActivity.cs) — the AMBIENT "which workflow step is
// running right now", so app code reached from a save or an action can ask what it is part of
// (`WorkflowActivityInfo.current().is("Order approval", "Approve")`), and so the CaseActivityMixin can stamp
// whatever the step produces.
//
// altea divergence: Signum backs it with an `AsyncThreadVariable` + an IDisposable scope; altea uses a Node
// AsyncLocalStorage, exactly as `UserHolder` and `systemTime` do — concurrent requests each get their own.
// `Scope(...)` (a `using`) becomes `withScope(info, fn)`, which is why every engine call site that used to
// open a `using` block now wraps its body in a callback.

export interface WorkflowActivityInfo {
    readonly caseActivity: CaseActivityEntity | null;
    readonly connection: WorkflowConnectionEntity | null;
    readonly decision: string | null;
}

const empty: WorkflowActivityInfo = { caseActivity: null, connection: null, decision: null };

const storage = new AsyncLocalStorage<WorkflowActivityInfo>();

export namespace WorkflowActivityInfo {

    /** Signum's `WorkflowActivityInfo.Current` — never null (an empty info outside any scope). */
    export function current(): WorkflowActivityInfo {
        return storage.getStore() ?? empty;
    }

    /** Signum's `WorkflowActivityInfo.Scope(wa)`, as a callback scope. */
    export function withScope<R>(info: Partial<WorkflowActivityInfo>, fn: () => R): R {
        return storage.run({ ...empty, ...info }, fn);
    }

    /** The workflow ACTIVITY (not the case activity) currently running, when it is a real activity — a case
     *  activity may also sit on an intermediate-timer EVENT, and then this is null. */
    export function workflowActivity(): WorkflowActivityEntity | null {
        const node = current().caseActivity?.workflowActivity;
        return node instanceof WorkflowActivityEntity ? node : null;
    }

    /**
     * Signum's `WorkflowActivityInfo.Is(workflowName, activityName)` — "am I inside THIS step of THAT
     * workflow?", the check app code uses to branch inside a shared save.
     *
     * Signum also validates these two strings at COMPILE time (`WorkflowLogic.GetCustomErrors` scans the
     * eval'd C# with a regex and reports an unknown workflow / activity name as a compiler error). That
     * check goes with the Eval deferral: there is no script to scan, and a caller here is ordinary
     * TypeScript that a reviewer reads.
     */
    export function is(workflowName: string, activityName: string): boolean {
        const wa = workflowActivity();
        return wa != null && wa.name === activityName && wa.lane.pool.workflow.name === workflowName;
    }
}
