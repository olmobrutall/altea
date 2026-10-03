/** One HeavyProfiler span, flattened for the flame chart (Signum's HeavyProfilerEntryTS). */
export interface HeavyProfilerEntryInfo {
    beforeStart: number;
    start: number;
    end: number;
    totalMax: number;
    elapsed: string;
    kind: string;
    color: string;
    depth: number;
    /** The lane a span is stacked in so that concurrent siblings do not draw on top of each other. */
    asyncDepth: number;
    additionalData: string | undefined;
    fullIndex: string;
    isFinished: boolean;
}

export interface StackTrace {
    color: string | undefined;
    namespace: string;
    type: string | undefined;
    method: string;
    fileName: string | undefined;
    lineNumber: number;
}

export interface TimeTrackerTimeInfo {
    duration: number;
    /** ISO instant. */
    date: string;
    url: string | undefined;
    /** The user's label, not a Lite. */
    user: string | undefined;
}

export interface TimeTrackerEntryInfo {
    identifier: string;
    count: number;
    averageDuration: number;
    totalDuration: number;
    max: TimeTrackerTimeInfo;
    max2: TimeTrackerTimeInfo | undefined;
    max3: TimeTrackerTimeInfo | undefined;
    min: TimeTrackerTimeInfo;
    last: TimeTrackerTimeInfo;
}

/** A previously exported HeavyProfiler XML, `content` base64-encoded. */
export interface HeavyProfilerUpload {
    fileName: string;
    content: string;
}
