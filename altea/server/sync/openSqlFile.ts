import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Connector } from "../connection/connector";
import { Transaction } from "../connection/transaction";
import { SafeConsole, Color } from "../safeConsole";
import type { SqlPreCommand } from "./sqlPreCommand";

// Port of Signum's `SqlPreCommandExtensions.OpenSqlFileRetry` (Engine/Sync/SqlPreCommand.cs) — the console
// flow every Signum terminal uses to apply a synchronization script: SAVE it, PRINT it, say WHERE it is,
// and only then offer run / open / exit.
//
// The point is the file. A sync script is the one thing a developer is expected to READ before it touches
// a database, and "open" exists so it can be edited first — which is why the run step re-reads the file
// rather than executing the in-memory command tree. altea's terminal used to print the script and execute
// it in the same breath, leaving nothing to review and nothing to keep.
//
// It lives in core, where Signum keeps it, so every host gets the same flow — and it is why SafeConsole
// moved out of @altea/altea-migrations (see server/safeConsole).
//
// Divergences from Signum:
//  - no NoTransactionMode: altea's SqlPreCommand carries no such marker (the note @altea/altea-migrations'
//    SqlMigrationRunner already makes), so this always writes ONE file and always runs it in a transaction.
//  - the saved script is executed as TEXT through `Connector.executeNonQuery`, the same path a .sql
//    migration takes. That is what makes an edit made in "open" actually take effect, and it works because
//    `plainSql()` inlines the parameter literals.
//  - `Process.Start(fileName) { UseShellExecute = true }` → the platform's own opener.

export interface OpenSqlFileResult {
    /** Absolute path of the saved script — always written, whatever the answer. */
    readonly fileName: string;
    /** Whether the script was executed against the database. */
    readonly executed: boolean;
}

/**
 * Save `command` as `fileName` inside `directory`, show it, and ask run / open / exit. Returns where it
 * was saved and whether it ran, so the caller can decide what to do next (Signum's terminal re-initializes
 * the schema only when something was applied).
 *
 * The directory is created if missing, and it is the CALLER's — Signum drops the script in the process's
 * working directory, which puts generated SQL wherever the terminal happened to be launched from. A host
 * naming its own folder can gitignore it once (eastwind: `terminal/sync`) instead of ignoring a
 * `Sync *.sql` pattern across the whole repository.
 */
export async function openSqlFileRetry(command: SqlPreCommand, directory: string, fileName: string): Promise<OpenSqlFileResult> {
    const fullDirectory = resolve(directory);
    mkdirSync(fullDirectory, { recursive: true });
    const fullFileName = join(fullDirectory, fileName);
    writeFileSync(fullFileName, command.plainSql(), "utf8");

    SafeConsole.writeLineColor(Color.yellow, "There are changes!");
    SafeConsole.writeLine();
    SafeConsole.writeLineColor(Color.darkGray, command.plainSql());
    SafeConsole.writeLine();
    SafeConsole.writeLine("Script saved in:  " + fullFileName);
    SafeConsole.writeLineColor(Color.yellow, "Check the synchronization script before running it!");

    // Non-interactive (a piped or CI run): the script is on disk and named above — say so and stop, rather
    // than applying something nobody could review. askOptions answers undefined there.
    const answer = await SafeConsole.askOptions("Open or run?", "run", "open", "exit");

    if (answer === "open") {
        openInShell(fullFileName);
        if (!await SafeConsole.ask("run now?"))
            return { fileName: fullFileName, executed: false };
    } else if (answer !== "run") {
        return { fileName: fullFileName, executed: false };
    }

    return { fileName: fullFileName, executed: await executeRetry(fullFileName) };
}

// Signum's ExecuteRetry: run the FILE (so an edit made in "open" counts), and on failure offer
// retry / open / exit rather than losing the script.
async function executeRetry(fullFileName: string): Promise<boolean> {
    for (; ;) {
        try {
            const script = await readFile(fullFileName, "utf8");
            // One transaction for the whole script: a mid-script failure rolls back, so the database is
            // never left half-migrated. Postgres runs DDL transactionally; on SQL Server most DDL is too.
            await Transaction.create(async () => {
                await Connector.current().executeNonQuery(script);
            });
            return true;
        } catch (e) {
            SafeConsole.writeLine();
            SafeConsole.writeLineColor(Color.red, (e as Error)?.message ?? String(e));
            SafeConsole.writeLine();
            SafeConsole.writeLine("The current script is saved in:  " + fullFileName);

            const answer = await SafeConsole.askOptions("Open or retry?", "retry", "open", "exit");
            if (answer === "retry")
                continue;
            if (answer !== "open")
                return false;

            openInShell(fullFileName);
            if (!await SafeConsole.ask("run now?"))
                return false;
        }
    }
}

// Signum's `new Process { StartInfo = new ProcessStartInfo(fileName) { UseShellExecute = true } }.Start()`
// — hand the file to whatever the desktop has registered for .sql. Detached and unref'd so the terminal
// is not held open by the editor, and failures are ignored: the path was printed above, so a headless or
// opener-less box loses nothing.
function openInShell(fullFileName: string): void {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", fullFileName]]
        : process.platform === "darwin" ? ["open", [fullFileName]]
            : ["xdg-open", [fullFileName]];
    try {
        spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).unref();
    } catch {
        // no opener — the path is printed above
    }
}

/** Signum's `Sync {0:yyyy-MM-dd HH_mm_ss}.sql` file name. */
export function syncFileName(now: Date): string {
    const p = (n: number, len = 2): string => String(n).padStart(len, "0");
    return `Sync ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} `
        + `${p(now.getHours())}_${p(now.getMinutes())}_${p(now.getSeconds())}.sql`;
}
