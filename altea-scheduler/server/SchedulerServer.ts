import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { SchedulerPermission } from "../data/Scheduler";
import type { SchedulerState, SchedulerHealth } from "../data/SchedulerState";
import { ScheduleTaskRunner } from "./ScheduleTaskRunner";

// The panel's three calls and the shutdown hook.
//
// The health check is ANONYMOUS — a load balancer polls it — and the other two assert ViewSchedulerPanel.
// The shutdown hook rides the process SIGNALS (`stopAt`), since there is no host lifetime object to
// register on; an app may also call it directly.
//
// See docs/port/Scheduler.md.

export namespace SchedulerServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        ws.get("/api/scheduler/view",
            { res: CustomType<SchedulerState>() },
            async (_req, res) => {
                await assertAuthorized();
                res.jsonTyped(ScheduleTaskRunner.getSchedulerState());
            });

        // Anonymous ON PURPOSE: this is what a load balancer or monitor polls.
        ws.get("/api/scheduler/healthCheck",
            { res: CustomType<SchedulerHealth>(), allowAnonymous: true },
            async (_req, res) => {
                const health = ScheduleTaskRunner.getHealthStatus();
                res.status(health.status === "Healthy" ? 200 : 503).jsonTyped(health);
            });

        ws.post("/api/scheduler/start",
            { req: CustomType<void>(), res: CustomType<SchedulerState>() },
            async (_req, res) => {
                await assertAuthorized();
                await ScheduleTaskRunner.startScheduledTasks();
                res.jsonTyped(ScheduleTaskRunner.getSchedulerState());
            });

        ws.post("/api/scheduler/stop",
            { req: CustomType<void>(), res: CustomType<SchedulerState>() },
            async (_req, res) => {
                await assertAuthorized();
                ScheduleTaskRunner.stopScheduledTasks();
                res.jsonTyped(ScheduleTaskRunner.getSchedulerState());
            });

        installShutdownHook();
    }

    // Stop the timer and cancel whatever is running, so a
    // restart does not leave half-finished work claiming to be in flight.
    let shutdownInstalled = false;
    export function installShutdownHook(): void {
        if (shutdownInstalled)
            return;
        shutdownInstalled = true;

        const stop = (): void => {
            if (ScheduleTaskRunner.running())
                ScheduleTaskRunner.stopScheduledTasks();
            ScheduleTaskRunner.stopRunningTasks();
        };

        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        process.once("beforeExit", stop);
    }
}

// The same shape @altea/altea-user-queries uses for its permission gate.
async function assertAuthorized(): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(SchedulerPermission.ViewSchedulerPanel)))
        throw new UnauthorizedAccessException(`Not authorized for '${SchedulerPermission.ViewSchedulerPanel.key}'`);
}
