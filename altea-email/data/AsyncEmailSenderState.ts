// The wire DTOs of the async-sender panel (Signum's AsyncEmailSenderState + SignumHealthResult). Declared
// once in the DATA layer so the server route and the React page share one shape — the pattern
// @altea/altea-scheduler's SchedulerState established.

export interface AsyncEmailSenderState {
    running: boolean;
    /** Non-null once the sender has been ARMED (an app that never arms it reads "Disabled", not "down"). */
    initialDelayMilliseconds: number | null;
    machineName: string;
    /** EmailConfiguration.asyncSenderPeriod, in seconds. */
    asyncSenderPeriod: number;
    isCancelationRequested: boolean;
    /** ISO PlainDateTime strings (the panel only displays them). */
    nextPlannedExecution: string | null;
    lastExecutionFinishedOn: string | null;
    queuedItems: number;
    currentProcessIdentifier: string | null;
}

/** The anonymous health probe's response (a monitor polls it). */
export interface AsyncEmailSenderHealth {
    status: "Healthy" | "Unhealthy";
    description: string;
}
