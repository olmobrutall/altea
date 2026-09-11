import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Which altea application is being worked on, and where it is.
 *
 * The half of Signum.Upgrade's `UpgradeContext` that is not about upgrading — every CLI here needs it, so
 * it lives in the shared package rather than in one of them. `UpgradeContext` extends it with the
 * source-EDITING half (CodeFile and friends), which only `altea-upgrade` uses.
 *
 * **Detection.** Signum finds its root by walking up for a `Framework/` directory and its application name
 * from the single `.sln` that has a matching folder. altea has neither: the root is the directory holding
 * `pnpm-workspace.yaml` AND an `altea/` submodule, and the application is the workspace entry that is not
 * under `altea/`. That makes the answer come from the file that already has to be right for anything to
 * build, rather than from a second source that could disagree with it.
 *
 * **`eastwind` → `{applicationName}`.** Signum writes upgrade paths as `Southwind\Starter.cs` and
 * substitutes the real name at every call; altea does the same with `eastwind`, so a path — or an upgrade
 * — written against the demo application is replayed against whatever it was renamed to.
 */
export class ApplicationContext {
    readonly rootFolder: string;
    /** The application's directory name, which is also its package name — `eastwind`, or what it became. */
    readonly applicationName: string;

    constructor(rootFolder: string, applicationName: string) {
        this.rootFolder = rootFolder;
        this.applicationName = applicationName;
    }

    /** Walk up from `from` for the workspace root, then read the application out of it. */
    static createFromDirectory(from = process.cwd()): ApplicationContext {
        const rootFolder = ApplicationContext.findRootFolder(from);
        return new ApplicationContext(rootFolder, ApplicationContext.findApplicationName(rootFolder));
    }

    protected static findRootFolder(from: string): string {
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
     * monorepo of applications, which these tools have no way to choose between — so it says so rather
     * than picking the first.
     */
    protected static findApplicationName(rootFolder: string): string {
        const entries = ApplicationContext.workspacePackages(rootFolder)
            .filter(e => !e.startsWith("altea/") && e !== "altea");

        if (entries.length === 0)
            throw new Error("pnpm-workspace.yaml lists no application package (every entry is under altea/).");
        if (entries.length > 1)
            throw new Error(`pnpm-workspace.yaml lists several application packages (${entries.join(", ")}); `
                + "these tools work on one application at a time.");

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
        return ApplicationContext.rename(value, "eastwind", this.applicationName);
    }

    /** The application's own directory, absolute. */
    get applicationDirectory(): string { return path.join(this.rootFolder, this.applicationName); }

    /**
     * The casing-aware substitution, shared with the project copier.
     *
     * Signum does three — the exact spelling, all-lower and all-upper — and that is enough there because
     * its application name is already PascalCase (`Southwind` / `southwind` / `SOUTHWIND` covers every
     * form in its sources). altea's is a package name, so it is LOWER case, and the three collapse to two:
     * `Eastwind` was left untouched in `EastwindBrowser`, `EastwindEnvironment`, `Eastwind.es.xml` and
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
}
