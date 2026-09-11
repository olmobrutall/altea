import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import type { Replacements } from "@altea/altea/server/sync/synchronizer";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { table } from "@altea/altea/server/table";
import { Schema } from "@altea/altea/server/schema/schema";
import { TokenMigrationEntity } from "../data/TokenMigration";
import { TokenMigrationFile } from "./TokenMigrationFile";
import { TokenSyncContext } from "./TokenSyncContext";
import { TokenMigrationLogic, type MigrationInfo } from "./TokenMigrationLogic";

// Port of Signum.UserAssets' TokenMigrations/TokenMigrationRunner.cs — see port/UserAssets.md.
//
// The session: list what exists, apply what is pending, or record a new migration. The two modes are
// asymmetric ON PURPOSE. RECORDING is interactive and saves nothing — it walks every asset, asks about
// each token it cannot resolve, and writes the answers out. APPLYING is silent and saves per entity — it
// replays those answers and must not prompt, because it runs where nobody is watching. That is why a miss
// in Apply mode is an ERROR rather than a question (see TokenSyncContext.askRename).
//
// Async throughout, since every prompt is; the writes run through `ExecutionMode.global`. A recorded file
// is written BESIDE the sync script, which is where the migrations directory listing looks for it.

export namespace TokenMigrationRunner {

    /**
     * The loop the migration command lands in. Hooked onto
     * `SqlMigrationRunner.afterMigrationsCompleted`, so token migrations run in the same session as the
     * schema ones: the developer's muscle memory is one command, not two.
     */
    export async function tokenMigrations(autoRun: boolean): Promise<void> {
        await Schema.current.initialize();
        SafeConsole.writeLine();
        SafeConsole.writeLineColor(Color.cyan, "..:: Token Migrations ::..");

        for (;;) {
            const infos = TokenMigrationLogic.readMigrationsDirectory();
            await setExecuted(infos);
            draw(infos);

            const pending = infos.filter(a => !a.isExecuted && a.fileName != null);
            if (pending.length > 0) {
                if (!autoRun && !await SafeConsole.ask(`Apply ${pending.length} Token Migrations?`))
                    return;

                await applyPending(pending);
            } else {
                if (infos.length > 0)
                    SafeConsole.writeLine("All token migrations are applied.");

                if (autoRun)
                    return;

                if (!await SafeConsole.ask("Create new Token Migration?"))
                    return;

                if (!await recordNewMigration())
                    return;
            }
        }
    }

    /**
     * Mark which listed versions have run, and surface any version that is in the DATABASE with no file
     * left — printed in RED, because it means the history on disk and the history in the database
     * disagree.
     */
    async function setExecuted(infos: MigrationInfo[]): Promise<void> {
        const executed = await ExecutionMode.global(async () =>
            await table(TokenMigrationEntity)
                .map(m => ({ versionNumber: m.versionNumber, comment: m.comment }))
                .toArray());

        const byVersion = new Map(infos.map(a => [a.version, a]));

        for (const e of executed) {
            const info = byVersion.get(e.versionNumber);
            if (info != null)
                info.isExecuted = true;
            else
                infos.push({
                    fileName: null,
                    comment: ">> In Database Only << " + (e.comment ?? ""),
                    isExecuted: true,
                    version: e.versionNumber,
                    kind: "Tokens",
                });
        }

        infos.sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
    }

    /**
     * Replay every pending file in version order, in ONE `TokenSynchronizing`
     * fire.
     *
     * One fire, not one per file, is what makes a chain work: with `V1: A→B` and `V2: B→C` both pending,
     * the walk inside `tryResolveParts` composes them per token and lands on C, where applying V1 and
     * then V2 separately would have to re-read and re-save every asset twice.
     */
    async function applyPending(pending: MigrationInfo[]): Promise<void> {
        const loaded = pending.map(p => TokenMigrationFile.load(p.fileName!));

        const ctx = new TokenSyncContext("Apply", loaded, /* recording */ null);
        await TokenMigrationLogic.fireTokenSynchronizing(ctx);

        // The version rows go in ONE transaction: either this batch ran or it did not.
        await ExecutionMode.global(() => Transaction.forceNew(async () => {
            for (const p of pending) {
                await TokenMigrationEntity.create({ versionNumber: p.version, comment: p.comment }).save();
                p.isExecuted = true;
            }
        }));
    }

    /**
     * The hook on the schema sync. The renames a sync just resolved are
     * exactly the ones that invalidate stored tokens, so this offers to record them while they are still
     * in hand, and then to run them.
     */
    export async function afterSynchronize(fileName: string | null, rep: Replacements | null): Promise<void> {
        SafeConsole.writeLine();
        SafeConsole.writeLineColor(Color.green, "..:: Tokens Synchronizer ::..");

        const recording = new TokenMigrationFile();
        if (rep != null)
            recording.loadTypes(rep);

        await TokenMigrationLogic.fireTokenSynchronizing(new TokenSyncContext("Record", [], recording));

        if (recording.isEmpty) {
            SafeConsole.writeLineColor(Color.green, "No changes needed.");
            return;
        }

        recording.print();

        // Beside the sync script (see the header). With no script — an already-synchronized database that
        // still has token work — it goes to the migrations directory under its own version stamp.
        const newFileName = fileName != null
            ? join(dirname(fileName), basename(fileName).replace(/\.sql$/i, "") + TokenMigrationLogic.tokensFileExtension)
            : join(ensureMigrationsDirectory(), versionStamp() + TokenMigrationLogic.tokensFileExtension);

        recording.save(newFileName);

        if (await SafeConsole.ask("Run now?"))
            await TokenMigrationLogic.fireTokenSynchronizing(new TokenSyncContext("Apply", [recording], null));
    }

    /** An interactive pass that writes a new `.tokens.json`. */
    async function recordNewMigration(): Promise<boolean> {
        // History = every committed file, whether or not it has been applied to THIS database: the point
        // is to resolve against what has been decided, and a decision counts as soon as it is on disk.
        const allCommitted = TokenMigrationLogic.readMigrationsDirectory(/* silent */ true);
        await setExecuted(allCommitted);
        const loaded = allCommitted
            .filter(p => p.fileName != null && !p.isExecuted)
            .map(p => TokenMigrationFile.load(p.fileName!));

        const recording = new TokenMigrationFile();
        const ctx = new TokenSyncContext("Record", loaded, recording);

        await TokenMigrationLogic.fireTokenSynchronizing(ctx);

        if (recording.isEmpty) {
            SafeConsole.writeLineColor(Color.green, "No changes in tokens found!");
            SafeConsole.writeLine();
            return false;
        }

        recording.print();

        const version = versionStamp();
        const comment = (await SafeConsole.askString("Comment for the new token migration? ")).trim();
        const fileName = version + (comment !== "" ? "_" + removeInvalidFileNameChars(comment) : "")
            + TokenMigrationLogic.tokensFileExtension;

        recording.save(join(ensureMigrationsDirectory(), fileName));
        return true;
    }

    function ensureMigrationsDirectory(): string {
        const dir = TokenMigrationLogic.migrationsDirectory();
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** And the regex that reads it back. */
    function versionStamp(): string {
        const d = new Date();
        const p = (n: number, len = 2): string => String(n).padStart(len, "0");
        return `${p(d.getFullYear(), 4)}.${p(d.getMonth() + 1)}.${p(d.getDate())}`
            + `-${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
    }

    function removeInvalidFileNameChars(text: string): string {
        return text.replace(/[\\/:*?"<>|]/g, "");
    }

    function draw(infos: MigrationInfo[]): void {
        SafeConsole.writeLine();

        if (infos.length === 0) {
            SafeConsole.writeLineColor(Color.darkGray, "No token/query migrations found.");
        } else {
            for (const mi of infos) {
                // The RED case is the one that matters: a version recorded in the database whose file is
                // gone.
                const color = mi.fileName != null && mi.isExecuted ? Color.darkGreen
                    : mi.fileName == null && mi.isExecuted ? Color.red
                        : mi.fileName != null && !mi.isExecuted ? Color.white
                            : Color.gray;

                SafeConsole.writeColor(color, mi.isExecuted ? "- " : "  ");
                SafeConsole.writeColor(color, mi.version);
                SafeConsole.writeColor(color, " [" + mi.kind + "]");
                SafeConsole.writeLineColor(mi.fileName == null ? Color.red : Color.gray, " " + mi.comment);
            }
        }

        SafeConsole.writeLine();
    }
}
