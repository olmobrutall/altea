import "@altea/altea/server"; // installs save()/toLite()
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Clock } from "@altea/altea/data/utils/clock";
import { CSharpMigrationEntity, MigrationMessage } from "../data/Migrations";
import { MigrationLogic } from "./MigrationLogic.server";
import { SafeConsole, Color } from "./SafeConsole.server";

// Port of Signum.Migrations' CSharpMigrationRunner.cs — a list of NAMED code steps, each recorded in
// CSharpMigrationEntity once it has run, so a step never runs twice across deploys. The app builds one
// (Southwind's `new CSharpMigrationRunner { CreateRoles, CreateSystemUser, … }.Run(autoRun)`) and the
// runner draws the list, runs what is pending, and marks each as executed.
//
// altea divergences:
//  - `Action` + `action.Method.Name` for the unique name: a TS function's `.name` is unreliable (arrows,
//    minification), so `add(uniqueName, action)` takes the name FIRST and explicitly. That name is the
//    migration's identity in the database — renaming one re-runs it, exactly as in Signum.
//  - Signum's `IEnumerable<MigrationInfo>` + collection initialiser becomes plain `add` calls.
//  - `ExecuteSqlScriptException` (its retry/abort protocol) is not ported: a failing step throws, the loop
//    stops, and interactive mode returns to the menu — see `run`.

export interface CSharpMigrationInfo {
    uniqueName: string;
    action: () => Promise<void>;
    isExecuted: boolean;
}

export class CSharpMigrationRunner {
    readonly migrations: CSharpMigrationInfo[] = [];

    /** Signum's `Add(action, uniqueName)`, with the name first (see the note above). */
    add(uniqueName: string, action: () => Promise<void>): this {
        this.migrations.push({ uniqueName, action, isExecuted: false });
        return this;
    }

    /**
     * Signum's `Run(autoRun)`: read which steps are already recorded, show the list, and run the pending
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

    /** Signum's SetExecuted: flag every step already present in CSharpMigrationEntity. */
    private async setExecuted(): Promise<void> {
        SafeConsole.writeLineColor(Color.darkGray, MigrationMessage.ReadingCSharpMigrations.niceToString());

        await MigrationLogic.ensureMigrationTable(CSharpMigrationEntity);

        const executed = new Set((await ExecutionMode.global(() => table(CSharpMigrationEntity).toArray()) as CSharpMigrationEntity[])
            .map(m => m.uniqueName));

        for (const m of this.migrations)
            m.isExecuted = executed.has(m.uniqueName);
    }

    /** Signum's Prompt: returns whether the caller should loop again. */
    private async prompt(autoRun: boolean): Promise<boolean> {
        this.draw(undefined);

        const pending = this.migrations.filter(m => !m.isExecuted);
        if (pending.length === 0) {
            SafeConsole.writeLineColor(Color.green, MigrationMessage.AllMigrationsAreExecuted.niceToString());
            return false;
        }

        if (!autoRun && !await SafeConsole.ask(MigrationMessage.RunMigrations0.niceToString(pending.length)))
            return false;

        for (const m of pending) {
            this.draw(m);
            await this.execute(m);
        }
        return true;
    }

    /** Signum's Execute: run the step, then record it. A throw aborts the whole run (Signum rethrows too). */
    private async execute(mi: CSharpMigrationInfo): Promise<void> {
        SafeConsole.writeLineColor(Color.darkGray, `${mi.uniqueName} executing ...`);
        try {
            await mi.action();
        } catch (e) {
            SafeConsole.writeLine();
            SafeConsole.writeLineColor(Color.darkRed, `${(e as Error)?.name ?? "Error"}: `);
            SafeConsole.writeLineColor(Color.red, (e as Error)?.message ?? String(e));
            SafeConsole.writeLineColor(Color.darkRed, (e as Error)?.stack ?? "");
            throw e;
        }
        SafeConsole.writeLineColor(Color.darkGray, `${mi.uniqueName} finished!`);

        await CSharpMigrationEntity.create({ uniqueName: mi.uniqueName, executionDate: Clock.now }).save();
        mi.isExecuted = true;
    }

    /** Signum's Draw: the list, with `- ` for done, `->` for the one running now. */
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
