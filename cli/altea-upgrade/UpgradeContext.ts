import * as fs from "node:fs";
import * as path from "node:path";
import { Color, Console } from "./Console.js";
import { CodeFile, WarningLevel } from "./CodeFile.js";

/**
 * The application being worked on: where it is, what it is called, and every file operation an upgrade
 * needs. Port of Signum.Upgrade's `UpgradeContext`.
 *
 * **Detection.** Signum finds its root by walking up for a `Framework/` directory and its application
 * name from the single `.sln` that has a matching folder. altea has neither: the root is the directory
 * holding `pnpm-workspace.yaml` AND an `altea/` submodule, and the application is the workspace entry
 * that is not under `altea/`. That makes the answer come from the file that already has to be right for
 * anything to build, rather than from a second source that could disagree with it.
 *
 * **`Southwind` → `{ApplicationName}`.** Signum writes upgrade paths as `Southwind\Starter.cs` and
 * substitutes the real name at every call. altea does the same with `eastwind`, so an upgrade is written
 * against the demo application and replayed against whatever it was renamed to.
 */
export class UpgradeContext {
    readonly rootFolder: string;
    /** The application's directory name, which is also its package name — `eastwind`, or what it became. */
    readonly applicationName: string;

    warningLevel: WarningLevel = WarningLevel.None;

    /**
     * Directories no upgrade ever descends into: build output, dependencies, VCS metadata, the generated
     * CodeGen folder, and `altea/` — the framework is a submodule with its own history, and an upgrade
     * that edited it would be rewriting the thing doing the upgrading.
     */
    static defaultIgnoreDirectories = [
        "node_modules", "dist", "ts_out", "obj", "bin", "CodeGen", "TensorFlowModels",
        ".git", ".vs", ".vscode", ".idea", "altea", "old",
    ];

    constructor(rootFolder: string, applicationName: string) {
        this.rootFolder = rootFolder;
        this.applicationName = applicationName;
    }

    /** Walk up from `from` for the workspace root, then read the application out of it. */
    static createFromDirectory(from = process.cwd()): UpgradeContext {
        const rootFolder = UpgradeContext.findRootFolder(from);
        return new UpgradeContext(rootFolder, UpgradeContext.findApplicationName(rootFolder));
    }

    private static findRootFolder(from: string): string {
        let directory = path.resolve(from);
        for (; ;) {
            if (fs.existsSync(path.join(directory, "pnpm-workspace.yaml"))
                && fs.existsSync(path.join(directory, "altea")))
                return directory;

            const parent = path.dirname(directory);
            if (parent === directory)
                throw new Error("Unable to detect the root folder: no ancestor of "
                    + `${from} holds both pnpm-workspace.yaml and altea/.`);
            directory = parent;
        }
    }

    /**
     * The one workspace entry that is not a framework package. A workspace with several would be a
     * monorepo of applications, which this tool has no way to choose between — so it says so rather than
     * picking the first.
     */
    private static findApplicationName(rootFolder: string): string {
        const entries = UpgradeContext.workspacePackages(rootFolder)
            .filter(e => !e.startsWith("altea/") && e !== "altea");

        if (entries.length === 0)
            throw new Error("pnpm-workspace.yaml lists no application package (every entry is under altea/).");
        if (entries.length > 1)
            throw new Error(`pnpm-workspace.yaml lists several application packages (${entries.join(", ")}); `
                + "altea-upgrade works on one application at a time.");

        return entries[0].replace(/\/$/, "");
    }

    /**
     * The entries under `packages:` — and only those. The file has other top-level LISTS
     * (`publicHoistPattern`), and reading every `- x` in it took `*eslint*` and `typescript` for
     * applications.
     */
    static workspacePackages(rootFolder: string): string[] {
        const lines = fs.readFileSync(path.join(rootFolder, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
        const start = lines.findIndex(l => /^packages\s*:/.test(l));
        if (start < 0)
            throw new Error("pnpm-workspace.yaml has no `packages:` list.");

        const result: string[] = [];
        for (let i = start + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === "" || line.trimStart().startsWith("#"))
                continue;
            const item = /^\s+-\s*(\S+)\s*$/.exec(line);
            if (item == null)
                break;   // a new top-level key: the list is over
            result.push(item[1].replace(/^["']|["']$/g, ""));
        }
        return result;
    }

    // ---- paths -------------------------------------------------------------------------------------

    /** A repository-root-relative path made absolute, with `eastwind` substituted for this application. */
    absolutePath(name: string): string {
        return path.join(this.rootFolder, this.replaceApplicationName(name));
    }

    /** `eastwind` → this application's name, in every casing — see {@link rename}. */
    replaceApplicationName(value: string): string {
        return UpgradeContext.rename(value, "eastwind", this.applicationName);
    }

    /**
     * The casing-aware substitution, shared with the project copier.
     *
     * Signum does three — the exact spelling, all-lower and all-upper — and that is enough there because
     * its application name is already PascalCase (`Southwind` / `southwind` / `SOUTHWIND` covers every
     * form in its sources). altea's is a package name, so it is LOWER case, and the three collapse to two:
     * `Eastwind` was left untouched in `EastwindMigrations`, `EastwindBrowser`, `Eastwind.es.xml` and
     * every message key that embeds it.
     *
     * So: UPPER, Title, lower, in that order. Order matters — the first two produce text that no longer
     * contains the lower-case form, so the last pass cannot re-replace what they just wrote.
     */
    static rename(value: string, from: string, to: string): string {
        const title = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

        return value
            .split(from.toUpperCase()).join(to.toUpperCase())
            .split(title(from.toLowerCase())).join(title(to.toLowerCase()))
            .split(from.toLowerCase()).join(to.toLowerCase());
    }

    /** The application's own directory, absolute. */
    get applicationDirectory(): string { return path.join(this.rootFolder, this.applicationName); }

    // ---- warnings ----------------------------------------------------------------------------------

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
        options?: { directory?: string; codeWarning?: WarningLevel; directoryWarning?: WarningLevel; ignoreDirectories?: string[] }): void {
        const files = this.getCodeFiles(options?.directory ?? ".", searchPattern,
            options?.ignoreDirectories, options?.directoryWarning ?? WarningLevel.Error);

        for (const file of files) {
            file.warningLevel = options?.codeWarning ?? WarningLevel.None;
            action(file);
            file.saveIfNecessary();
        }
    }

    getCodeFiles(directory: string, searchPattern: string, ignoreDirectories?: string[],
        showWarnings: WarningLevel = WarningLevel.Error): CodeFile[] {
        const patterns = searchPattern.split(",").map(p => p.trim()).filter(p => p !== "");
        const ignore = ignoreDirectories ?? UpgradeContext.defaultIgnoreDirectories;
        const absolute = this.absolutePath(directory);

        if (!fs.existsSync(absolute)) {
            this.missing(`directory ${directory} not found`, showWarnings);
            return [];
        }

        const result: CodeFile[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!ignore.includes(entry.name))
                        walk(full);
                } else if (patterns.some(p => matches(entry.name, p))) {
                    result.push(new CodeFile(path.relative(this.rootFolder, full), this));
                }
            }
        };
        walk(absolute);
        return result;
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
