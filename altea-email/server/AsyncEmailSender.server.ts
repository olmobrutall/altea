import "@altea/altea/server"; // installs Entity.save()/delete()
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { table } from "@altea/altea/server/table";
import { Temporal, type uuid } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { EmailMessageEntity, EmailMessageStateEnum } from "../data/EmailMessage";
import type { AsyncEmailSenderState, AsyncEmailSenderHealth } from "../data/AsyncEmailSenderState";
import { EmailLogic } from "./EmailLogic.server";

// Port of Signum.Mailing's AsyncEmailSender.cs — the IN-PROCESS background sender: it CLAIMS every message
// in ReadyToSend (stamping its own processIdentifier), sends them in chunks, retries a failure up to
// maxEmailSendRetries, and re-arms a timer for the configured period.
//
// altea divergences, documented inline:
//  - Signum blocks a dedicated thread on an `AutoResetEvent` and loops. Node has one event loop, so `wakeUp`
//    COALESCES into a single pending pass (an extra wake-up while a pass is in flight sets a flag and the pass
//    runs again) — the same "never miss a signal, never run two loops" property without a thread or a lock.
//    This is exactly what @altea/altea-processes' ProcessRunner does.
//  - `CacheLogic.WithSqlDependency` / `SetSqlDependency` (the SQL-push that notices another host's work) is
//    NOT ported: the periodic timer is the latency for a shared queue, as in a Signum deployment without it.
//  - `SystemEventLogLogic.Log` has no counterpart; the in-memory state the panel shows takes its place.
//  - `AuthLogic.Disable()` → `ExecutionMode.global`; a claimed batch is sent one message per `forceNew`
//    transaction, so one bad message cannot roll back the others (Signum does the same).
//  - Timers are `unref()`d so a pending pass never holds a CLI process open.

export namespace AsyncEmailSender {

    let running = false;
    let initialDelayMilliseconds: number | undefined;
    let nextPlannedExecution: Temporal.PlainDateTime | undefined;
    let lastExecutionFinishedOn: Temporal.PlainDateTime | undefined;
    let cancellationRequested = false;
    let queuedItems = 0;
    let processIdentifier: uuid | undefined;

    let timer: NodeJS.Timeout | undefined;
    let pumping = false;
    let pumpAgain = false;

    /** Signum's ExecutionState — what the panel shows. */
    export function executionState(): AsyncEmailSenderState {
        return {
            running,
            initialDelayMilliseconds: initialDelayMilliseconds ?? null,
            machineName: hostname(),
            asyncSenderPeriod: EmailLogic.configuration().asyncSenderPeriod as unknown as number,
            isCancelationRequested: cancellationRequested,
            nextPlannedExecution: nextPlannedExecution?.toString() ?? null,
            lastExecutionFinishedOn: lastExecutionFinishedOn?.toString() ?? null,
            queuedItems,
            currentProcessIdentifier: processIdentifier ?? null,
        };
    }

    /** Signum's GetHealthStatus — "Disabled" (never armed) reads healthy; armed-but-stopped does not. */
    export function getHealthStatus(): AsyncEmailSenderHealth {
        return running ? { status: "Healthy", description: "Running" }
            : initialDelayMilliseconds == undefined ? { status: "Healthy", description: "Disabled" }
                : { status: "Unhealthy", description: "Not Running!" };
    }

    /** Signum's StartAsyncEmailSenderAfter — arm the sender after a delay (so a host finishes booting first). */
    export function startAsyncEmailSenderAfter(delayMilliseconds: number): void {
        initialDelayMilliseconds = delayMilliseconds;
        const t = setTimeout(() => void startAsyncEmailSender(), delayMilliseconds);
        t.unref();
    }

    /** Signum's StartAsyncEmailSender. */
    export async function startAsyncEmailSender(): Promise<void> {
        if (running)
            throw new Error("AsyncEmailSender is already running");

        running = true;
        cancellationRequested = false;
        initialDelayMilliseconds ??= 0;

        // Signum's one-off "anything older than this was never going to be sent" sweep.
        await markOutdated();

        wakeUp("StartAsyncEmailSender");
    }

    /** Signum's Stop. */
    export function stop(): void {
        if (!running)
            throw new Error("AsyncEmailSender is not running");

        cancellationRequested = true;
        clearTimer();
        nextPlannedExecution = undefined;
        running = false;
    }

    /** Signum's WakeUp — coalescing (see the header). */
    export function wakeUp(reason: string): void {
        if (!running)
            return;

        if (pumping) {
            pumpAgain = true;
            return;
        }

        void (async (): Promise<void> => {
            using _ = HeavyProfiler.log("AsyncEmailSender WakeUp " + reason);
            pumping = true;
            try {
                do {
                    pumpAgain = false;
                    await pump();
                } while (pumpAgain && !cancellationRequested);
            } catch (e) {
                await Transaction.forceNew(() => ExceptionLogic.logException(e, ex => {
                    ex.controllerName = "AsyncEmailSender";
                    ex.actionName = "wakeUp: " + reason;
                })).catch(() => { /* logging must never take the host down */ });
            } finally {
                pumping = false;
                if (running && !cancellationRequested)
                    setTimer();
            }
        })();
    }

    /** One pass: claim what is ready, then send it in chunks until nothing is left. */
    async function pump(): Promise<void> {
        const config = EmailLogic.configuration();
        if (!config.sendEmails)
            throw new Error("EmailConfigurationEmbedded.sendEmails is set to false");

        clearTimer();
        nextPlannedExecution = undefined;
        processIdentifier = randomUUID() as uuid;

        await ExecutionMode.global(async () => {
            if (!(await recruitQueuedItems()))
                return;

            while (queuedItems > 0) {
                if (cancellationRequested)
                    return;

                const chunkSize = config.chunkSizeSendingEmails as unknown as number;
                const items = await table(EmailMessageEntity)
                    .filter(m => m.processIdentifier == processIdentifier! && m.state == EmailMessageStateEnum.RecruitedForSending)
                    .top(chunkSize)
                    .toArray() as EmailMessageEntity[];

                if (items.length === 0)
                    break;

                for (const email of items) {
                    if (cancellationRequested)
                        return;

                    try {
                        await Transaction.forceNew(() => EmailLogic.sendMail(email));
                    } catch {
                        await retryLater(email).catch(() => { /* a failed retry-bookkeeping is not fatal */ });
                    }
                    queuedItems--;
                }

                queuedItems = (await table(EmailMessageEntity)
                    .filter(m => m.processIdentifier == processIdentifier! && m.state == EmailMessageStateEnum.RecruitedForSending)
                    .toArray()).length;

                // Nothing left in this claim: look for anything queued while we were sending.
                if (queuedItems === 0 && !(await recruitQueuedItems()))
                    break;
            }

            lastExecutionFinishedOn = Clock.now;
        });
    }

    /** Signum's RecruitQueuedItems — claim every due ReadyToSend message for THIS pass. */
    async function recruitQueuedItems(): Promise<boolean> {
        const config = EmailLogic.configuration();
        const now = Clock.now;
        const firstDate = config.avoidSendingEmailsOlderThan == null ? undefined
            : now.subtract({ hours: config.avoidSendingEmailsOlderThan });

        const pid = processIdentifier!;

        queuedItems = firstDate == undefined
            ? await table(EmailMessageEntity)
                .filter(m => m.state == EmailMessageStateEnum.ReadyToSend && m.creationDate < now)
                .executeUpdate(() => ({ processIdentifier: pid, state: EmailMessageStateEnum.RecruitedForSending }))
            : await table(EmailMessageEntity)
                .filter(m => m.state == EmailMessageStateEnum.ReadyToSend && m.creationDate < now && m.creationDate >= firstDate)
                .executeUpdate(() => ({ processIdentifier: pid, state: EmailMessageStateEnum.RecruitedForSending }));

        return queuedItems > 0;
    }

    /** Signum's retry branch: put the message back in ReadyToSend until maxEmailSendRetries is spent. */
    async function retryLater(email: EmailMessageEntity): Promise<void> {
        const max = EmailLogic.configuration().maxEmailSendRetries as unknown as number;
        if ((email.sendRetries as unknown as number) >= max)
            return;

        await Transaction.forceNew(async () => {
            const fresh = await table(EmailMessageEntity).filter(m => m.id == email.id).toArray() as EmailMessageEntity[];
            const nm = fresh[0];
            if (nm == undefined)
                return;
            nm.sendRetries = ((nm.sendRetries as unknown as number) + 1) as EmailMessageEntity["sendRetries"];
            nm.state = EmailMessageStateEnum.ReadyToSend;
            await nm.save();
        });
    }

    /** Signum's one-off sweep on start: too old to be worth sending. */
    async function markOutdated(): Promise<void> {
        const hours = EmailLogic.configuration().avoidSendingEmailsOlderThan;
        if (hours == null)
            return;

        const firstDate = Clock.now.subtract({ hours });
        await ExecutionMode.global(() => table(EmailMessageEntity)
            .filter(m => m.state == EmailMessageStateEnum.ReadyToSend && m.creationDate < firstDate)
            .executeUpdate(() => ({ state: EmailMessageStateEnum.Outdated })));
    }

    /** Signum's SetTimer — re-arm for the configured period. */
    function setTimer(): void {
        const seconds = EmailLogic.configuration().asyncSenderPeriod as unknown as number;
        nextPlannedExecution = Clock.now.add({ seconds });
        clearTimer();
        timer = setTimeout(() => wakeUp("TimerNextExecution"), seconds * 1000);
        timer.unref();
    }

    function clearTimer(): void {
        if (timer != undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    }

    /** Stop the sender on host shutdown (the scheduler / process runners install the same hook). */
    let shutdownInstalled = false;
    export function installShutdownHook(): void {
        if (shutdownInstalled)
            return;
        shutdownInstalled = true;

        const doStop = (): void => { if (running) stop(); };
        process.once("SIGINT", doStop);
        process.once("SIGTERM", doStop);
        process.once("beforeExit", doStop);
    }
}
