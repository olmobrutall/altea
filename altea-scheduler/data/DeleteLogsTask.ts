import { init, reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, overrideImplementedBy } from "@altea/altea/data/decorators";
import { DeleteLogParametersEmbedded, DeleteLogsTypeOverridesEmbedded } from "@altea/altea/data/deleteLogs";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import { type ITaskEntity } from "./Scheduler";

// The SCHEDULABLE half of core's log-cleanup machinery (altea/data/deleteLogs.ts + server/exceptionLogic.ts).
//
// It lives here because the parameters need a persistent, editable home and that home has to be an
// `ITaskEntity` — and ITaskEntity is this package's. Core cannot reach it (core may not depend on the
// scheduler), and Signum has the same split: the machinery is in Signum/Basics, while the entity that
// carries the parameters is left to whoever schedules it.

/** A ScheduledTask that trims every registered log table. One row per retention POLICY — an app that wants
 *  a gentle nightly sweep and an aggressive weekend one keeps two. */
@reflect
@entity("Main", "Master")
export class DeleteLogsTaskEntity extends Entity implements ITaskEntity {

    parameters: DeleteLogParametersEmbedded = new DeleteLogParametersEmbedded();

    toString(): string {
        return DeleteLogsTaskEntity.niceName();
    }
}

export namespace DeleteLogsTaskOperation {
    export const Save: ExecuteSymbol<DeleteLogsTaskEntity> = init();
}

// The per-type override rows hang off THIS entity — see the back reference's note in
// altea/data/deleteLogs.ts. Top-level, because an implementedBy override has to be applied on both tiers
// before anything is (de)serialized or the schema is built; there is exactly one possible owner, so unlike
// `ScheduledTaskEntity.task` it is not the application's choice to make.
overrideImplementedBy(DeleteLogsTypeOverridesEmbedded, o => o.parameters, () => [DeleteLogsTaskEntity]);
