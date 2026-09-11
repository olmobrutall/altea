import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { Color, Console, Git } from "@altea/altea-cli-utils";
import { WarningLevel } from "./CodeFile.js";
import type { UpgradeContext } from "./UpgradeContext.js";

/**
 * One upgrade: a dated, named change to an application's SOURCE.
 *
 * Port of Signum.Upgrade's `CodeUpgradeBase`. The KEY is the class name, which is why the convention is
 * `Upgrade_<yyyymmdd>_<WhatItDoes>` — it sorts chronologically, it is what the ledger file records, and
 * it is the commit message.
 */
export abstract class UpgradeBase {
    /** Filled by the runner from the module's file name, so the key cannot drift from the ledger. */
    key = "";
    isExecuted = false;

    abstract get description(): string;
    abstract execute(uctx: UpgradeContext): void | Promise<void>;
}

/** The file recording which upgrades have run. Signum's `SignumUpgrade.txt`, at the repository root. */
export const LEDGER_FILE = "AlteaUpgrade.txt";

/**
 * Discovers the upgrades, works out which are pending, and runs them one at a time — Signum's
 * `CodeUpgradeRunner`, with its rhythm intact: refuse on a dirty tree, run ONE upgrade, let the developer
 * review, then commit / retry / exit.
 *
 * **Discovery is a directory scan**, where Signum reflects over its assembly. `upgrades/*.js` in this
 * package's compiled output, each default-exporting an `UpgradeBase` subclass, ordered by file name. A
 * scan rather than an index file because an index is a second place to forget: an upgrade that compiles
 * and is never listed silently does not exist.
 */
export class UpgradeRunner {
    upgrades: UpgradeBase[] = [];

    /** Load `upgrades/*.js` from this package's own dist, in file-name order. */
    static async discover(): Promise<UpgradeRunner> {
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const directory = path.join(here, "upgrades");

        const runner = new UpgradeRunner();
        if (!fs.existsSync(directory))
            return runner;

        const files = fs.readdirSync(directory).filter(f => f.endsWith(".js")).sort();
        for (const file of files) {
            const module = await import(url.pathToFileURL(path.join(directory, file)).href) as
                { default?: new () => UpgradeBase };

            if (module.default == undefined) {
                Console.writeLineColor(Color.yellow, `  ${file} has no default export; skipped`);
                continue;
            }

            const upgrade = new module.default();
            upgrade.key = path.basename(file, ".js");
            runner.upgrades.push(upgrade);
        }
        return runner;
    }

    async run(uctx: UpgradeContext): Promise<void> {
        if (this.upgrades.length === 0) {
            Console.writeLineColor(Color.yellow, "There are no upgrades to run.");
            return;
        }

        const ledger = path.join(uctx.rootFolder, LEDGER_FILE);
        for (; ;) {
            if (!await this.readLedger(ledger))
                return;
            if (!await this.prompt(uctx, ledger))
                return;
        }
    }

    /**
     * Read (or create) the ledger. A repository that has none is an application joining the scheme late:
     * it is asked which upgrade it needs NEXT, and everything before that is marked executed — Signum's
     * same question, and the only safe answer, since re-running an old upgrade against drifted source is
     * what the ledger exists to prevent.
     */
    private async readLedger(ledger: string): Promise<boolean> {
        Console.writeLine();

        if (!fs.existsSync(ledger)) {
            Console.writeLineColor(Color.yellow, `${LEDGER_FILE} not found — let's create one.`);
            Console.writeLine();

            this.upgrades.forEach((u, i) =>
                Console.writeLine(`  ${String(i + 1).padStart(3)}  ${u.key}`));
            Console.writeLine(`  ${String(this.upgrades.length + 1).padStart(3)}  `
                + "<< mark ALL upgrades as executed >>");
            Console.writeLine();

            const answer = await Console.askString(
                "Which is the first upgrade you should RUN? (everything before it is marked executed): ");
            if (answer === "")
                return false;

            const index = Number(answer);
            if (!Number.isInteger(index) || index < 1 || index > this.upgrades.length + 1) {
                Console.writeLineColor(Color.red, `'${answer}' is not one of the options`);
                return false;
            }

            const executed = this.upgrades.slice(0, index - 1).map(u => u.key);
            fs.writeFileSync(ledger, executed.join("\n") + (executed.length > 0 ? "\n" : ""), "utf8");

            Console.writeLineColor(Color.green, `${LEDGER_FILE} created.`);
            Console.writeLineColor(Color.darkGray,
                "(it records which upgrades have run, and should be committed to git)");
        }

        const done = new Set(fs.readFileSync(ledger, "utf8").split(/\r?\n/).map(l => l.trim()).filter(l => l !== ""));
        for (const upgrade of this.upgrades)
            upgrade.isExecuted = done.has(upgrade.key);

        return true;
    }

    /** Draw the list, then offer the next pending upgrade. Returns false to end the session. */
    private async prompt(uctx: UpgradeContext, ledger: string): Promise<boolean> {
        this.draw();

        const next = this.upgrades.find(u => !u.isExecuted);
        if (next == undefined) {
            Console.writeLineColor(Color.green, "All upgrades are executed!");
            return false;
        }

        if (!await Console.ask(`Run the next upgrade (${next.key})?`))
            return false;

        return await this.executeOne(next, uctx, ledger);
    }

    private async executeOne(upgrade: UpgradeBase, uctx: UpgradeContext, ledger: string): Promise<boolean> {
        // The upgrade edits source in place, so the diff IS the review. That only works from a clean tree.
        await Git.waitForCleanTree(uctx.rootFolder);

        Console.writeLine();
        uctx.warningLevel = WarningLevel.None;

        try {
            await upgrade.execute(uctx);
        } catch (e) {
            Console.writeLineColor(Color.red, (e as Error).message);
            Console.writeLineColor(Color.darkGray, (e as Error).stack ?? "");

            if (!await Console.ask(`Skip ${upgrade.key} and mark it as executed?`))
                return false;
        }

        fs.appendFileSync(ledger, upgrade.key + "\n", "utf8");

        Console.writeLine();
        printOutcome(uctx.warningLevel);
        Console.writeLine(" Please review the changes.");
        Console.writeLine();

        switch (await Console.askOptions("What should we do next?", "commit", "retry", "exit")) {
            case "commit":
                if (Git.commitAll(uctx.rootFolder, upgrade.key))
                    Console.writeLineColor(Color.white, `Committed as '${upgrade.key}'.`);
                else
                    Console.writeLine("Nothing to commit.");
                return true;

            case "retry":
                // The ledger line was already appended; drop it so the upgrade is offered again.
                dropLastLedgerLine(ledger, upgrade.key);
                await Git.waitForCleanTree(uctx.rootFolder, "Revert the changes in git");
                return true;

            default:
                return false;
        }
    }

    private draw(): void {
        Console.writeLine();
        Console.writeLineColor(Color.cyan, "Available upgrades:");
        Console.writeLine();

        const next = this.upgrades.find(u => !u.isExecuted);
        for (const u of this.upgrades) {
            const style = u.isExecuted ? Color.darkGreen : u === next ? Color.blue : Color.white;
            Console.writeColor(style, (u.isExecuted ? "-  " : u === next ? "-> " : "   ") + u.key);
            Console.writeLineColor(Color.darkGray, "  " + u.description);
        }
        Console.writeLine();
    }
}

/**
 * How the upgrade went. A FUNCTION rather than a switch at the call site: assigning
 * `uctx.warningLevel = None` before running narrows that const to `WarningLevel.None` for the rest of
 * the block — TypeScript does not widen a property again across the call that is the point of reading
 * it — so the other two cases read as unreachable. A parameter carries its declared type.
 */
function printOutcome(level: WarningLevel): void {
    switch (level) {
        case WarningLevel.None: Console.writeColor(Color.green, "Upgrade finished successfully!"); break;
        case WarningLevel.Warning: Console.writeColor(Color.yellow, "Upgrade finished with warnings…"); break;
        case WarningLevel.Error: Console.writeColor(Color.red, "Upgrade finished with errors…"); break;
    }
}

function dropLastLedgerLine(ledger: string, key: string): void {
    const lines = fs.readFileSync(ledger, "utf8").split(/\r?\n/);
    const last = lines.lastIndexOf(key);
    if (last >= 0) {
        lines.splice(last, 1);
        fs.writeFileSync(ledger, lines.join("\n"), "utf8");
    }
}
