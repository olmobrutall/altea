import "@altea/altea/server"; // installs save()/toLite()
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Clock } from "@altea/altea/data/utils/clock";
import { ExecuteSqlScriptException } from "@altea/altea/server/sync/sqlPreCommand";
import { CSharpMigrationEntity, MigrationMessage } from "../data/Migrations";
import { MigrationLogic } from "./MigrationLogic";
import { SafeConsole, Color } from "./SafeConsole";

// A list of NAMED code steps, each recorded in CSharpMigrationEntity once it has run, so a step never runs
// twice across deploys. The app builds one and the runner draws the list, runs what is pending, and marks
// each as executed.
//
// `add(uniqueName, action)` takes the name FIRST and explicitly, because a TS function's `.name` is
// unreliable (arrows, minification) — and that name is the migration's IDENTITY in the database, so
// renaming one re-runs it.
//
// Port of Signum.Migrations' CSharpMigrationRunner.cs — see docs/port/Migrations.md.

export interface CSharpMigrationInfo {
    uniqueName: string;
    action: () => Promise<void>;
    isExecuted: boolean;
}

export class CSharpMigrationRunner {
    readonly migrations: CSharpMigrationInfo[] = [];

    /** The name comes FIRST, and explicitly (see the header). */
    add(uniqueName: string, action: () => Promise<void>): this {
        this.migrations.push({ uniqueName, action, isExecuted: false });
        return this;
    }

    /**
     * Read which steps are already recorded, show the list, and run the pending
     * ones. `autoRun` runs them without asking (a deploy); interactive asks first and loops so the dev sees
     * the updated list afterwards.
     */
    async run(autoRun: boolean): Promise<void> {
        for (; ;) {
            await this.setExecuted();

            if (!await this.prompt(autoRun) || autoRun)
                return;
        }
    }

    /** Flag every step already present in CSharpMigrationEntity. */
    private async setExecuted(): Promise<void> {
        SafeConsole.writeLineColor(Color.darkGray, MigrationMessage.ReadingCSharpMigrations.niceToString());

        await MigrationLogic.ensureMigrationTable(CSharpMigrationEntity);

        const executed = new Set((await ExecutionMode.global(() => table(CSharpMigrationEntity).toArray()) as CSharpMigrationEntity[])
            .map(m => m.uniqueName));

        for (const m of this.migrations)
            m.isExecuted = executed.has(m.uniqueName);
    }

    /** Returns whether the caller should loop again. */
    private async prompt(autoRun: boolean): Promise<boolean> {
        this.draw(undefined);

        const pending = this.migrations.filter(m => !m.isExecuted);
        if (pending.length === 0) {
            SafeConsole.writeLineColor(Color.green, MigrationMessage.AllMigrationsAreExecuted.niceToString());
            return false;
        }

        if (!autoRun && !await SafeConsole.ask(MigrationMessage.RunMigrations0.niceToString(pending.length)))
            return false;

        try {
            for (const m of pending) {
                this.draw(m);
                await this.execute(m);
            }
        } catch (e) {
            // `execute` has already printed it. Interactively that is all the dev needs: fall through and
            // loop back to the list, so the fixed step can be retried. A deploy has nobody to ask, so it
            // fails the process.
            if (autoRun || !(e instanceof ExecuteSqlScriptException))
                throw e;
        }
        return true;
    }

    /**
     * Run the step, then record it. A failure is REPORTED here and rethrown as an
     * ExecuteSqlScriptException — the marker that says "already printed" (see docs/port/Migrations.md).
     */
    private async execute(mi: CSharpMigrationInfo): Promise<void> {
        SafeConsole.writeLineColor(Color.darkGray, `${mi.uniqueName} executing ...`);
        try {
            await mi.action();
        } catch (e) {
            SafeConsole.writeLine();
            SafeConsole.writeLineColor(Color.darkRed, `${(e as Error)?.name ?? "Error"}: `);
            SafeConsole.writeLineColor(Color.red, (e as Error)?.message ?? String(e));
            SafeConsole.writeLineColor(Color.darkRed, (e as Error)?.stack ?? "");
            SafeConsole.writeLine();
            throw new ExecuteSqlScriptException((e as Error)?.message ?? String(e), { cause: e });
        }
        SafeConsole.writeLineColor(Color.darkGray, `${mi.uniqueName} finished!`);

        await CSharpMigrationEntity.create({ uniqueName: mi.uniqueName, executionDate: Clock.now }).save();
        mi.isExecuted = true;
    }

    /** The list, with `- ` for done, `->` for the one running now. */
    private draw(current: CSharpMigrationInfo | undefined): void {
        SafeConsole.writeLine();
        for (const mi of this.migrations) {
            const color = mi.isExecuted ? Color.darkGreen : mi === current ? Color.green : Color.white;
            const prefix = mi.isExecuted ? "- " : mi === current ? "->" : "  ";
            SafeConsole.writeLineColor(color, prefix + mi.uniqueName);
        }
        SafeConsole.writeLine();
    }
}
