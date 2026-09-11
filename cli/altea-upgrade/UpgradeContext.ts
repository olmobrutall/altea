import * as fs from "node:fs";
import * as path from "node:path";
import { ApplicationContext, Color, Console, Git } from "@altea/altea-cli-utils";
import { CodeFile, WarningLevel } from "./CodeFile.js";

/**
 * The application an UPGRADE is editing: {@link ApplicationContext} — where it is and what it is
 * called — plus every file operation an upgrade needs. Port of Signum.Upgrade's `UpgradeContext`.
 *
 * The split is by AUDIENCE. Finding the application is something all three CLIs do, so it lives in the
 * shared package; rewriting its source is what this tool alone is for, so it lives here. An upgrade
 * script's whole vocabulary is this class plus {@link CodeFile}.
 */
export class UpgradeContext extends ApplicationContext {

    /** The worst level any helper reported during the current upgrade — what the runner prints. */
    warningLevel: WarningLevel = WarningLevel.None;

    /** Narrows {@link ApplicationContext.createFromDirectory} to this type. */
    static override createFromDirectory(from = process.cwd()): UpgradeContext {
        const rootFolder = UpgradeContext.findRootFolder(from);
        return new UpgradeContext(rootFolder, UpgradeContext.findApplicationName(rootFolder));
    }

    reportWarning(level: WarningLevel): void {
        if (level > this.warningLevel)
            this.warningLevel = level;
    }

    // ---- files -------------------------------------------------------------------------------------

    tryGetCodeFile(fileName: string): CodeFile | undefined {
        const full = this.absolutePath(fileName);
        return fs.existsSync(full) ? new CodeFile(this.replaceApplicationName(fileName), this) : undefined;
    }

    /** Open one file, edit it, and save only if something changed. Signum's `ChangeCodeFile`. */
    changeCodeFile(fileName: string, action: (file: CodeFile) => void,
        showWarnings: WarningLevel = WarningLevel.Error): void {
        const relative = this.replaceApplicationName(fileName);
        if (!fs.existsSync(this.absolutePath(relative))) {
            this.missing(`file ${relative} not found`, showWarnings);
            return;
        }

        const file = new CodeFile(relative, this);
        file.warningLevel = showWarnings;
        action(file);
        file.saveIfNecessary();
    }

    /**
     * Edit every file matching a glob-ish pattern. `searchPattern` is a comma-separated list of
     * `*.ext` suffixes (Signum's own shape), matched against the file NAME.
     */
    forEachCodeFile(searchPattern: string, action: (file: CodeFile) => void,
        options?: { directory?: string; codeWarning?: WarningLevel; directoryWarning?: WarningLevel }): void {
        const files = this.getCodeFiles(options?.directory ?? ".", searchPattern,
            options?.directoryWarning ?? WarningLevel.Error);

        for (const file of files) {
            file.warningLevel = options?.codeWarning ?? WarningLevel.None;
            action(file);
            file.saveIfNecessary();
        }
    }

    /**
     * The files under `directory` an upgrade may edit — asked of GIT rather than walked.
     *
     * That is the whole ignore rule: `.gitignore` already says what belongs to the project, in one
     * place, for every tool. A list of directory names here would drift from it, could not express a
     * nested `.gitignore`, and was one `check-ignore` subprocess per file. It also excludes SUBMODULES
     * for free — an upgrade must never edit the framework it is being run by.
     *
     * Two consequences worth knowing, both harmless in practice:
     *  - a file an upgrade CREATED in this run is untracked, so a later sweep in the same upgrade will
     *    not see it. Create it and edit it directly; do not create it and then sweep for it.
     *  - uncommitted NEW files are included (`--others`), which matters only in theory: the runner
     *    refuses to start on a dirty tree, so there are none.
     */
    getCodeFiles(directory: string, searchPattern: string,
        showWarnings: WarningLevel = WarningLevel.Error): CodeFile[] {
        const patterns = searchPattern.split(",").map(p => p.trim()).filter(p => p !== "");
        const relative = this.replaceApplicationName(directory);

        if (!fs.existsSync(this.absolutePath(directory))) {
            this.missing(`directory ${relative} not found`, showWarnings);
            return [];
        }

        const pathspec = relative === "." ? undefined : relative;

        return [...Git.trackedFiles(this.rootFolder, pathspec),
            ...Git.untrackedFiles(this.rootFolder, pathspec)]
            .filter(f => patterns.some(pattern => matches(path.basename(f), pattern)))
            .filter(f => !Git.isGitlink(this.rootFolder, f))
            .map(f => new CodeFile(f, this));
    }

    createCodeFile(fileName: string, content: string, fileWarning: WarningLevel = WarningLevel.Error): void {
        const relative = this.replaceApplicationName(fileName);
        const full = this.absolutePath(relative);
        if (fs.existsSync(full)) {
            this.missing(`file ${relative} already exists`, fileWarning);
            return;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
        Console.writeLineColor(Color.green, `  Created ${relative}`);
    }

    deleteFile(fileName: string, fileWarning: WarningLevel = WarningLevel.Error): void {
        const relative = this.replaceApplicationName(fileName);
        const full = this.absolutePath(relative);
        if (!fs.existsSync(full)) {
            this.missing(`file ${relative} not found`, fileWarning);
            return;
        }
        fs.rmSync(full);
        Console.writeLineColor(Color.yellow, `  Deleted ${relative}`);
    }

    deleteDirectory(directory: string, fileWarning: WarningLevel = WarningLevel.Error): void {
        const relative = this.replaceApplicationName(directory);
        const full = this.absolutePath(relative);
        if (!fs.existsSync(full)) {
            this.missing(`directory ${relative} not found`, fileWarning);
            return;
        }
        fs.rmSync(full, { recursive: true, force: true });
        Console.writeLineColor(Color.yellow, `  Deleted directory ${relative}`);
    }

    moveFile(from: string, to: string, fileWarning: WarningLevel = WarningLevel.Error): void {
        const fromAbs = this.absolutePath(from);
        const toAbs = this.absolutePath(to);
        if (!fs.existsSync(fromAbs)) {
            this.missing(`unable to move ${from} -> ${to}: file not found`, fileWarning);
            return;
        }
        fs.mkdirSync(path.dirname(toAbs), { recursive: true });
        fs.renameSync(fromAbs, toAbs);
        Console.writeLineColor(Color.yellow, `  Moved ${from} -> ${to}`);
    }

    /**
     * The workspace manifest — altea's counterpart of Signum's `.sln` helpers. A module that is added or
     * removed is an entry here rather than a `<ProjectReference>`.
     */
    changeWorkspace(action: (file: CodeFile) => void): void {
        this.changeCodeFile("pnpm-workspace.yaml", action);
    }

    private missing(message: string, level: WarningLevel): void {
        if (level === WarningLevel.None)
            return;
        this.reportWarning(level);
        Console.writeLineColor(level === WarningLevel.Error ? Color.red : Color.yellow,
            `${WarningLevel[level].toUpperCase()} ${message}`);
    }
}

/** `*.ts` / `*.data.ts` / `package.json` — a suffix match, which is every pattern Signum's upgrades use. */
function matches(fileName: string, pattern: string): boolean {
    if (pattern === "*.*" || pattern === "*")
        return true;
    if (pattern.startsWith("*"))
        return fileName.endsWith(pattern.slice(1));
    return fileName === pattern;
}
