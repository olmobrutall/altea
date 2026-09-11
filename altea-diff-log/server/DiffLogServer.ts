import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { table as tableQuery } from "@altea/altea/server/table";
import * as Database from "@altea/altea/server/Database";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { ObjectDumper } from "@altea/altea/data/objectDumper";
import { DiffLogMixin } from "../data/DiffLog";

// The two routes that let the OperationLog view walk the chain: "the log before this one on the same
// target" and "the log after it, or the entity's CURRENT state when this is the last log".
//
// The current-entity dump runs under `ExecutionMode.global`: reading the target to dump it is an audit
// read, and the user is looking at a log they were already allowed to open.
//
// Port of Signum.DiffLog's DiffLogController.cs — see port/DiffLog.md.
export namespace DiffLogServer {

    export interface PreviousLog {
        operationLog: Lite<OperationLogEntity>;
        dump: string | null;
    }

    export interface NextLog {
        operationLog?: Lite<OperationLogEntity>;
        dump: string | null;
    }

    export function start(ws: WebBuilder): void {

        ws.get("/api/diffLog/previous/:id",
            { params: CustomType<{ id: string }>(), res: CustomType<PreviousLog | null>() },
            async (req, res) => {
                const { id } = req.params;
                const logId = OperationLogEntity.parseId(id);

                const log = await tableQuery(OperationLogEntity)
                    .filter(a => a.id == logId)
                    .map(a => ({ target: a.target, start: a.start }))
                    .singleOrNull();

                if (log == null || log.target == null) {
                    res.jsonTyped(null);
                    return;
                }

                const target = log.target;
                const start = log.start;
                const prev = await tableQuery(OperationLogEntity)
                    .filter(a => a.exception == null && a.target!.is(target) && a.end! < start)
                    .orderByDescending(a => a.end)
                    .firstOrNull();

                if (prev == null) {
                    res.jsonTyped(null);
                    return;
                }

                res.jsonTyped({
                    operationLog: prev.toLite(),
                    dump: prev.mixin(DiffLogMixin).finalState.text,
                } satisfies PreviousLog);
            });

        ws.get("/api/diffLog/next/:id",
            { params: CustomType<{ id: string }>(), res: CustomType<NextLog>() },
            async (req, res) => {
                const { id } = req.params;
                const logId = OperationLogEntity.parseId(id);

                const log = await tableQuery(OperationLogEntity)
                    .filter(a => a.id == logId)
                    .map(a => ({ target: a.target, end: a.end }))
                    .singleOrNull();

                if (log == null || log.target == null) {
                    res.jsonTyped({ dump: null } satisfies NextLog);
                    return;
                }

                const target = log.target;
                const end = log.end;
                const next = end == null ? null : await tableQuery(OperationLogEntity)
                    .filter(a => a.exception == null && a.target!.is(target) && a.start > end)
                    .orderBy(a => a.start)
                    .firstOrNull();

                if (next != null) {
                    res.jsonTyped({
                        operationLog: next.toLite(),
                        dump: next.mixin(DiffLogMixin).initialState.text,
                    } satisfies NextLog);
                    return;
                }

                // No later log: diff against the entity as it stands NOW, unless it is gone.
                res.jsonTyped({ dump: await dumpCurrent(target) } satisfies NextLog);
            });
    }

    /** The target's dump today, or null when the row no longer exists. */
    async function dumpCurrent(target: Lite<Entity>): Promise<string | null> {
        try {
            const entity = await ExecutionMode.global(() => Database.retrieve(target.entityType as never, target.id));
            return ObjectDumper.dump(entity);
        } catch {
            // A failed retrieve is the existence check, in one query.
            return null;
        }
    }
}
