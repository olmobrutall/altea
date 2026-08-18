import type { Lite } from "@altea/altea/data/lite";
import type { ScheduledTaskEntity, ScheduledTaskLogEntity } from "./Scheduler";

// The scheduler panel's wire shapes — Signum's SchedulerState / SchedulerItemState /
// SchedulerRunningTaskState (declared in ScheduleTaskRunner.cs) and its health result. Declared ONCE here,
// in the isomorphic layer, so the runner that fills them and the page that renders them share one
// definition (the convention altea-omnibox established for its wire DTOs).
//
// Dates are ISO STRINGS rather than Temporal values: this is a read-only snapshot for display, and the page
// formats them relative to now — the same reason Signum's DTO uses `string ServerLocalTime`.

export interface SchedulerState {
    running: boolean;
    initialDelayMilliseconds: number | null;
    /** Signum sends a TimeSpan; altea sends the milliseconds it actually is. */
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

/** Signum's SignumHealthResult, reduced to what the panel's status link shows. */
export interface SchedulerHealth {
    status: "Healthy" | "Unhealthy";
    description: string;
}
