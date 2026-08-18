import type { Lite } from "@altea/altea/data/lite";
import type { ProcessEntity, ProcessStateEnum } from "./Processes";

// The process panel's wire shapes — Signum's ProcessLogicState / ExecutionState (ProcessRunner.cs) and its
// health result. Declared once in the isomorphic layer so the runner that fills them and the page that
// renders them share one definition (as in the scheduler port).

export interface ProcessLogicState {
    running: boolean;
    initialDelayMilliseconds: number | null;
    maxDegreeOfParallelism: number;
    nextPlannedExecution: string | null;
    justMyProcesses: boolean;
    machineName: string;
    applicationName: string;
    /** Signum's rolling in-memory log of the runner's own decisions, when enabled. */
    log: string | null;
    executing: ExecutionState[];
}

export interface ExecutionState {
    process: Lite<ProcessEntity>;
    state: ProcessStateEnum;
    /** 0..1, as a string so the decimal survives the wire unrounded. */
    progress: string | null;
    isCancellationRequested: boolean;
    machineName: string;
    applicationName: string;
}

/** Signum's SignumHealthResult, reduced to what the panel's status link shows. */
export interface ProcessHealth {
    status: "Healthy" | "Unhealthy";
    description: string;
}
