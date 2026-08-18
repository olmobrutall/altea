import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { Clock } from "@altea/altea/data/utils/clock";
import { ProcessStateEnum } from "../data/Processes";
import { ProcessEntity, ProcessAlgorithmSymbol } from "../data/Processes";
import { ProcessLogic } from "./ProcessLogic.server";
import { ProcessRunner } from "./ProcessRunner.server";
import { SchedulerLogic } from "@altea/altea-scheduler/server/SchedulerLogic.server";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic.server";



// Port of Signum's "a scheduled task can BE a process" bridge. In Signum, ProcessLogic makes
// ProcessAlgorithmSymbol an ITaskEntity: a ScheduledTask can point straight at an algorithm, and when the
// scheduler fires it, a Process is CREATED and QUEUED rather than run inline — so the work lands in the
// process runner (progress, suspend, retry, the panel) instead of blocking a scheduler tick.
//
// altea divergences:
//  - Signum registers the ITaskEntity handler through its Polymorphic ExecuteTask; altea's registry is keyed
//    by constructor, so this is one `SchedulerLogic.registerExecuteTask(ProcessAlgorithmSymbol, ...)`.
//  - The APP still has to widen `ScheduledTaskEntity.task`'s implementations to include
//    ProcessAlgorithmSymbol — `@implementedBy` lives on the field and the scheduler cannot know about
//    processes. `overrideTaskImplementations()` does that, and MUST run on BOTH TIERS (it changes what the
//    serializer and the schema see), so an app calls it from a shared data module.

export namespace ProcessSchedulerBridge {

    // The DATA half of this bridge — widening ScheduledTaskEntity.task — lives in
    // data/ProcessSchedulerBridge.ts, because both tiers must apply it.

    /** Wire the handler: a scheduled ProcessAlgorithmSymbol creates + queues a process. Call AFTER both
     *  SchedulerLogic.start and ProcessLogic.start. */
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        SchedulerLogic.registerExecuteTask(ProcessAlgorithmSymbol, async task => {
            // Signum: the scheduled task's PRODUCT is the process it queued, so the scheduler's log links to
            // it and the process panel takes over from there.
            const process = await ProcessLogic.create(task as ProcessAlgorithmSymbol, null);
            await queue(process);
            return process.toLite() as Lite<Entity>;
        });

        // A SimpleTask and a process algorithm are the two task kinds; both are already registered by their
        // own modules, so nothing else is needed here.
        void SimpleTaskLogic;
    }

    /** Queue a freshly created process the way ProcessOperation.Execute does, without going through the
     *  operation (the scheduler runs as the task's user and has no operation context). */
    async function queue(process: ProcessEntity): Promise<void> {
        process.state = ProcessStateEnum.Queued;
        process.queuedDate = Clock.now;
        await process.save();

        ProcessRunner.wakeUp("scheduled process queued");
    }
}
