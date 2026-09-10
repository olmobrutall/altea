import type { Lite } from "@altea/altea/data/lite";
import type { ScheduledTaskEntity, ScheduledTaskLogEntity } from "./Scheduler";

// The scheduler panel's wire shapes, declared ONCE in the isomorphic layer so the runner that fills them
// and the page that renders them share one definition (the convention altea-omnibox established).
//
// Dates are ISO STRINGS rather than Temporal values: this is a read-only snapshot for display, and the
// page formats them relative to now.

export interface SchedulerState {
    running: boolean;
    initialDelayMilliseconds: number | null;
    /** Milliseconds. */
    schedulerMarginMilliseconds: number;
    nextExecution: string | null;
    machineName: string;
    applicationName: string;
    serverTimeZone: string;
    serverLocalTime: string;
    queue: SchedulerItemState[];
    runningTask: SchedulerRunningTaskState[];
}

export interface SchedulerItemState {
    scheduledTask: Lite<ScheduledTaskEntity>;
    rule: string;
    nextDate: string;
}

export interface SchedulerRunningTaskState {
    schedulerTaskLog: Lite<ScheduledTaskLogEntity>;
    startTime: string;
    remarks: string;
}

/** Reduced to what the panel's status link shows. */
export interface SchedulerHealth {
    status: "Healthy" | "Unhealthy";
    description: string;
}
