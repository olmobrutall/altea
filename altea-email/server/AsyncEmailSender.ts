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
import { EmailMessageEntity, EmailMessageState } from "../data/EmailMessage";
import type { AsyncEmailSenderState, AsyncEmailSenderHealth } from "../data/AsyncEmailSenderState";
import { EmailLogic } from "./EmailLogic";

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

    // A pass that fails is retried on the next wake-up, which is right for a transient SMTP or network
    // fault. What it is NOT right for is a fault that will never clear — a bad configuration, a dropped
    // connection string — where the sender would go on failing every period for ever, one logged exception
    // at a time. After this many failures in a row it stops itself, which is what the panel and the health
    // probe then report.
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;

    let timer: NodeJS.Timeout | undefined;
    let pumping = false;
    let pumpAgain = false;

    /** Signum's ExecutionState — what the panel shows. */
    export function executionState(): AsyncEmailSenderState {
        return {
            running,
            initialDelayMilliseconds: initialDelayMilliseconds ?? null,
            machineName: hostname(),
            asyncSenderPeriod: EmailLogic.configuration().asyncSenderPeriod,
            isCancelationRequested: cancellationRequested,
            nextPlannedExecution: nextPlannedExecution?.toString() ?? null,
            lastExecutionFinishedOn: lastExecutionFinishedOn?.toString() ?? null,
            queuedItems,
            currentProcessIdentifier: processIdentifier ?? null,
            consecutiveErrors,
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
        consecutiveErrors = 0;
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
                consecutiveErrors = 0;
            } catch (e) {
                consecutiveErrors++;
                await Transaction.forceNew(() => ExceptionLogic.logException(e, ex => {
                    ex.controllerName = "AsyncEmailSender";
                    ex.actionName = "wakeUp: " + reason;
                })).catch(() => { /* logging must never take the host down */ });

                if (consecutiveErrors >= maxConsecutiveErrors) {
                    // stop() clears the timer and flips `running`, so the finally below re-arms nothing
                    // and getHealthStatus starts answering Unhealthy — which is the point: something has
                    // to notice, and a log line every period was not doing it.
                    stop();
                    await Transaction.forceNew(() => ExceptionLogic.logException(
                        new Error(`AsyncEmailSender stopped after ${maxConsecutiveErrors} consecutive errors.`), ex => {
                            ex.controllerName = "AsyncEmailSender";
                            ex.actionName = "wakeUp: " + reason;
                        })).catch(() => { /* as above */ });
                }
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

                const chunkSize = config.chunkSizeSendingEmails;
                const items = await table(EmailMessageEntity)
                    .filter(m => m.processIdentifier == processIdentifier! && m.state == EmailMessageState.RecruitedForSending)
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
                    .filter(m => m.processIdentifier == processIdentifier! && m.state == EmailMessageState.RecruitedForSending)
                    .toArray()).length;

                // Nothing left in this claim: look for anything queued while we were sending.
                if (queuedItems === 0 && !(await recruitQueuedItems()))
                    break;
            }

            lastExecutionFinishedOn = Clock.now;
        });
    }

    /**
     * Signum's RecruitQueuedItems — claim a CHUNK of the due ReadyToSend messages for this pass.
     *
     * `.top(chunkSizeSendingEmails)`, like Signum: claiming the whole ready queue in one statement writes
     * every matching row under one lock, which on a backlog is the longest write the sender ever makes and
     * blocks anything else touching those rows for its duration. A chunk is bounded, and the pump
     * re-recruits as soon as it has drained one — so the queue still empties in the same pass, in claims
     * the database can interleave.
     *
     * The limit lands inside the source subquery the UPDATE joins (`LIMIT n` on Postgres, `TOP (n)` on
     * SQL Server), which is exactly what is wanted and is covered by UnsafeUpdateTest.UpdateValueTop on
     * both dialects.
     */
    async function recruitQueuedItems(): Promise<boolean> {
        const config = EmailLogic.configuration();
        const now = Clock.now;
        const firstDate = config.avoidSendingEmailsOlderThan == null ? undefined
            : now.subtract({ hours: config.avoidSendingEmailsOlderThan });

        const pid = processIdentifier!;
        const chunkSize = config.chunkSizeSendingEmails;

        queuedItems = firstDate == undefined
            ? await table(EmailMessageEntity)
                .filter(m => m.state == EmailMessageState.ReadyToSend && m.creationDate < now)
                .top(chunkSize)
                .executeUpdate(() => ({ processIdentifier: pid, state: EmailMessageState.RecruitedForSending }))
            : await table(EmailMessageEntity)
                .filter(m => m.state == EmailMessageState.ReadyToSend && m.creationDate < now && m.creationDate >= firstDate)
                .top(chunkSize)
                .executeUpdate(() => ({ processIdentifier: pid, state: EmailMessageState.RecruitedForSending }));

        return queuedItems > 0;
    }

    /** Signum's retry branch: put the message back in ReadyToSend until maxEmailSendRetries is spent. */
    async function retryLater(email: EmailMessageEntity): Promise<void> {
        const max = EmailLogic.configuration().maxEmailSendRetries;
        if (email.sendRetries >= max)
            return;

        await Transaction.forceNew(async () => {
            const fresh = await table(EmailMessageEntity).filter(m => m.id == email.id).toArray() as EmailMessageEntity[];
            const nm = fresh[0];
            if (nm == undefined)
                return;
            nm.sendRetries = (nm.sendRetries + 1) as EmailMessageEntity["sendRetries"];
            nm.state = EmailMessageState.ReadyToSend;
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
            .filter(m => m.state == EmailMessageState.ReadyToSend && m.creationDate < firstDate)
            .executeUpdate(() => ({ state: EmailMessageState.Outdated })));
    }

    /** Signum's SetTimer — re-arm for the configured period. */
    function setTimer(): void {
        const seconds = EmailLogic.configuration().asyncSenderPeriod;
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
