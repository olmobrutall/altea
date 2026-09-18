import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { DeleteLogsTaskEntity, DeleteLogsTaskOperation } from "../data/DeleteLogsTask";
import { SchedulerLogic } from "./SchedulerLogic";

// Makes the log cleanup schedulable: the task entity's table plus the handler that runs
// `ExceptionLogic.deleteLogsAndExceptions` with the parameters stored on it.
//
// OPT-IN — an app calls this from its Starter, next to `SchedulerLogic.start`, and adds
// `DeleteLogsTaskEntity` to `ScheduledTaskEntity.task` in its EntityOverrides (that list is the app's, as
// `ProcessSchedulerBridgeOverrides` documents). It is not folded into SchedulerLogic.start because it adds
// two tables — the task and its per-type override rows — that an application which never schedules a
// cleanup should not have to carry or synchronize, and because the retention policy is the app's to set.

export namespace DeleteLogsTaskLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        SchedulerLogic.start(sb);

        sb.include(DeleteLogsTaskEntity)
            .withSave(DeleteLogsTaskOperation.Save)
            .withQuery();

        // `ScheduledTaskContext` satisfies ExceptionLogic.DeleteLogsContext structurally, so the run's
        // remarks ARE the cleanup's report and cancelling the task stops it between chunks.
        SchedulerLogic.registerExecuteTask(DeleteLogsTaskEntity, async (task, ctx) => {
            await ExceptionLogic.deleteLogsAndExceptions(task.parameters, ctx);
            return null;
        });
    }
}
