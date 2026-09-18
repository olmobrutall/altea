import './index'; // installs Entity.save()/delete()
import './dynamicQuery/fluentIncludeQuery'; // FluentInclude.withQuery
import { hostname } from 'node:os';
import type { SchemaBuilder } from './schema';
import { Transaction } from './connection/transaction';
import { ExecutionMode } from './executionMode';
import { UserHolder } from './userHolder';
import { ExceptionLogic } from './exceptionLogic';
import { Clock } from '../data/utils/clock';
import { Temporal } from '../data/basics';
import { table } from './table';
import type { ExceptionEntity } from '../data/exception';
import { SystemEventLogEntity } from '../data/systemEventLog';

// Port of Signum's SystemEventLogLogic (old/Framework/Signum/Basics/SystemEventLogLogic.cs) — write a line
// about the PROCESS. Two properties are the whole design, and both are Signum's:
//
//  1. it writes in its OWN transaction (`Transaction.forceNew`), because the interesting events happen
//     while something else is going wrong, and a row that rolls back with the ambient transaction records
//     nothing about exactly the moment worth recording;
//  2. it NEVER throws — a failure to log is reported through ExceptionLogic and answered as `false`. The
//     caller is "the application is starting"; there is nothing useful it could do with an exception, and
//     failing a boot because the boot could not be logged would be worse than not logging it.
//
// altea divergences, documented inline:
//  - `Schema.Current.MachineName` → `node:os`'s `hostname()`, which is what ExceptionLogic already uses
//    for the same column on ExceptionEntity.
//  - `e.LogException(ex => ex.ControllerName = "SystemEventLog.Log")` → `ExceptionLogic.logException(e,
//    e => { e.controllerName = … })`, and the inner `catch {}` is kept: if logging the failure to log also
//    fails, there is nowhere left to report it.

export namespace SystemEventLogLogic {
    let started = false;
    export function isStarted(): boolean { return started; }

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's projection is (Entity, Id, Date, MachineName, EventType, Exception). altea's server
        // registration takes none (no QueryDescription), so those are CLIENT default columns — see
        // client/Basics (registered by SignumClient).
        sb.include(SystemEventLogEntity).withQuery();

        // Signum registers TWO limits here — one for plain rows and one for rows WITH an exception.
        ExceptionLogic.registerDeleteLogs(async (parameters, ctx) => {
            const typeEntity = SystemEventLogEntity.toTypeEntity();

            const dateLimit = parameters.getDateLimitDelete(typeEntity);
            if (dateLimit != null)
                await ExceptionLogic.deleteChunksLog(SystemEventLogEntity, table(SystemEventLogEntity)
                    .filter(s => Temporal.PlainDateTime.compare(s.date, dateLimit) < 0), parameters, ctx);

            const exceptionsDateLimit = parameters.getDateLimitDeleteWithExceptions(typeEntity);
            if (exceptionsDateLimit != null)
                await ExceptionLogic.deleteChunksLog(SystemEventLogEntity, table(SystemEventLogEntity)
                    .filter(s => Temporal.PlainDateTime.compare(s.date, exceptionsDateLimit) < 0 && s.exception != null),
                    parameters, ctx);
        });

        started = true;
    }

    /**
     * Signum's `Log(eventType, exception?)` — record one process event. Answers whether it was recorded:
     * `false` when the module was never started, or when writing the row failed (see the header).
     *
     * `await` it if you need the row to exist before you continue — the two calls this module ships do,
     * so that "Application Stop" is on disk before the process leaves.
     */
    export async function log(eventType: string, exception?: ExceptionEntity | null): Promise<boolean> {
        if (!started)
            return false;

        try {
            await Transaction.forceNew(() => ExecutionMode.global(async () => {
                await SystemEventLogEntity.create({
                    date: Clock.now,
                    machineName: machineName(),
                    user: UserHolder.current()?.user ?? null,
                    eventType,
                    exception: exception?.toLite() ?? null,
                }).save();
            }));

            return true;
        } catch (e) {
            try {
                await ExceptionLogic.logException(e, ex => { ex.controllerName = "SystemEventLog.Log"; });
            } catch {
                // Nowhere left to report it — see the header.
            }
            return false;
        }
    }

    /** Signum's `Schema.Current.MachineName`, and the column has a min length of 3, so never empty. */
    function machineName(): string {
        try {
            const name = hostname();
            return name != null && name.length >= 3 ? name : "unknown";
        } catch {
            return "unknown";
        }
    }
}
