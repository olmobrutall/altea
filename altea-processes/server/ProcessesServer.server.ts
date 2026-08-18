import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { ProcessPermission } from "../data/Processes";
import type { ProcessLogicState, ProcessHealth } from "../data/ProcessLogicState";
import { ProcessRunner } from "./ProcessRunner.server";

// Port of Signum.Processes' ProcessController.cs — the panel's calls, plus the shutdown hook Signum puts on
// the host's ApplicationStopping token (altea's web host has no lifetime object, so it hooks the signals).
//
// altea divergence: Signum's start/stop sleep a second so the panel's immediate reload sees the new state;
// `startRunningProcesses` is awaited here, so there is nothing to sleep for.

export namespace ProcessesServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        ws.get("/api/processes/view",
            { res: CustomType<ProcessLogicState>() },
            async (_req, res) => {
                await assertAuthorized();
                res.jsonTyped(ProcessRunner.executionState());
            });

        // Anonymous on purpose (Signum's [SignumAllowAnonymous]): this is what a monitor polls.
        ws.get("/api/processes/healthCheck",
            { res: CustomType<ProcessHealth>(), allowAnonymous: true },
            async (_req, res) => {
                const health = ProcessRunner.getHealthStatus();
                res.status(health.status === "Healthy" ? 200 : 503).jsonTyped(health);
            });

        ws.post("/api/processes/start",
            { req: CustomType<void>(), res: CustomType<ProcessLogicState>() },
            async (_req, res) => {
                await assertAuthorized();
                await ProcessRunner.startRunningProcesses();
                res.jsonTyped(ProcessRunner.executionState());
            });

        ws.post("/api/processes/stop",
            { req: CustomType<void>(), res: CustomType<ProcessLogicState>() },
            async (_req, res) => {
                await assertAuthorized();
                ProcessRunner.stopRunningProcesses();
                res.jsonTyped(ProcessRunner.executionState());
            });

        installShutdownHook();
    }

    let shutdownInstalled = false;
    export function installShutdownHook(): void {
        if (shutdownInstalled)
            return;
        shutdownInstalled = true;

        const stop = (): void => {
            if (ProcessRunner.running())
                ProcessRunner.stopRunningProcesses();
        };

        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        process.once("beforeExit", stop);
    }
}

async function assertAuthorized(): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(ProcessPermission.ViewProcessPanel)))
        throw new UnauthorizedAccessException(`Not authorized for '${ProcessPermission.ViewProcessPanel.key}'`);
}
