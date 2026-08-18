import { overrideImplementedBy } from "@altea/altea/data/decorators";
import type { Entity, Type } from "@altea/altea/data/entity";
import { ScheduledTaskEntity } from "@altea/altea-scheduler/data/Scheduler";
import { ProcessAlgorithmSymbol } from "./Processes";

// The DATA half of "a scheduled task can BE a process" (Signum makes ProcessAlgorithmSymbol an ITaskEntity):
// widening ScheduledTaskEntity.task so it accepts a process algorithm.
//
// It lives here, not in the server bridge, because an implementedBy override changes what the SERIALIZER and
// the SCHEMA see — so both tiers must apply it, before anything is (de)serialized or the schema is built.
// An app calls it from its shared entity-overrides module; the server half (what actually happens when the
// scheduler fires one) is ProcessSchedulerBridge.start.

export namespace ProcessSchedulerBridgeOverrides {
    /** Add ProcessAlgorithmSymbol (plus whatever else this app schedules) to ScheduledTaskEntity.task. Pass
     *  every OTHER task type the app uses: an override REPLACES the declared list, so omitting
     *  SimpleTaskSymbol would unschedule the simple tasks. */
    export function overrideTaskImplementations(otherTaskTypes: Type<Entity>[]): void {
        overrideImplementedBy(ScheduledTaskEntity, "task",
            () => [ProcessAlgorithmSymbol as unknown as Type<Entity>, ...otherTaskTypes]);
    }
}
