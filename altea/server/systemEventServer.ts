import { SystemEventLogLogic } from './systemEventLogLogic';

// Port of Signum's SystemEventServer (old/Framework/Signum/Basics/SystemEventServer.cs) — the two events
// the framework itself records: "Application Start" now, and "Application Stop" when the process is going
// away. The app calls it from its host, as Southwind does.
//
// altea divergences, documented inline:
//  - `IHostApplicationLifetime.ApplicationStopping` has no Node counterpart, so the stop event hangs off
//    the process SIGNALS plus `beforeExit`. That is NOT a like-for-like substitute, and the gap is
//    platform-shaped rather than uniform — see `stopSignals` below. What it means in practice: a MISSING
//    "Application Stop" row says "this process did not shut down through a route we can observe", which
//    is usable information rather than a hole, as long as you know which routes those are.
//  - the stop row is written by the SAME `SystemEventLogLogic.log`, so it inherits that function's
//    never-throw contract: a shutdown is not a good moment to start failing.

export namespace SystemEventServer {
    let installed = false;

    /**
     * The signals this platform can actually deliver to a Node process, with the exit status each should
     * produce (the conventional `128 + signal number`).
     *
     * Windows has no POSIX signals: Node emulates SIGINT / SIGBREAK for a real console Ctrl+C / Ctrl+Break,
     * and **SIGTERM does not exist there at all** — a `taskkill`, a service stop, or another process's
     * `process.kill(pid, "SIGTERM")` terminates the target outright without running any handler. Verified
     * while porting this: a self-`process.kill(pid, "SIGTERM")` on Windows killed the process with no
     * handler entered and no row written. Registering the handler anyway would be a lie about what is
     * covered, so the list is per-platform and the doc above says what falls outside it.
     */
    const stopSignals: readonly (readonly [NodeJS.Signals, number])[] = process.platform === "win32"
        ? [["SIGINT", 2], ["SIGBREAK", 21]]
        : [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]];

    /**
     * Signum's `LogStartStop(lifetime)` — logs the start immediately and arranges for the stop.
     *
     * Idempotent, because a host that restarts its server in place would otherwise stack handlers.
     */
    export async function logStartStop(): Promise<void> {
        await SystemEventLogLogic.log("Application Start");

        if (installed)
            return;
        installed = true;

        let stopping = false;
        const logStop = async (): Promise<void> => {
            // LOAD-BEARING, and not only against a second signal. `beforeExit` fires whenever the event
            // loop drains — and scheduling asynchronous work inside it (which writing a row is) keeps the
            // loop alive, so it drains and fires AGAIN, forever. Verified: an async beforeExit handler
            // without this guard re-entered until it was killed. This is what makes the second firing a
            // no-op, so the process can actually leave.
            if (stopping)
                return;
            stopping = true;
            await SystemEventLogLogic.log("Application Stop");
        };

        for (const [signal, number] of stopSignals) {
            process.on(signal, () => {
                void logStop().finally(() => {
                    // `process.exit(128 + n)` rather than re-raising the signal: a self-`process.kill` is
                    // not portable (see stopSignals), and this produces the same status a shell reports
                    // for a signal death on either platform. Not `exit(0)` — that would file a `kill` as a
                    // clean shutdown.
                    process.exit(128 + number);
                });
            });
        }

        // The event loop drained on its own — a terminal command or a script, never a listening web host.
        // It does not fire on an explicit `process.exit()` or on a signal, so it does not double up with
        // the handlers above; see the guard for why it cannot loop.
        process.on("beforeExit", () => { void logStop(); });
    }
}
