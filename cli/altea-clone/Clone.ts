import * as fs from "node:fs";
import * as path from "node:path";
import { Color, SafeConsole } from "@altea/altea/server/safeConsole";
import { Git } from "@altea/altea-upgrade/Git";
import { Prompt } from "@altea/altea-upgrade/Prompt";
import { UpgradeContext } from "@altea/altea-upgrade/UpgradeContext";

/**
 * Copy this application into a NEW project, renamed.
 *
 * Signum's `ApplicationRenamer` renames a checkout IN PLACE; this creates a new repository beside it, so
 * the source application survives and the new one starts with a clean history — which is what a team
 * starting from the demo actually wants.
 *
 * What the new repository gets:
 *
 *   <target>/
 *     .git                 a fresh repository, one initial commit
 *     altea/               a git SUBMODULE at the same url and the same COMMIT as the source's, so the
 *                          new application starts against the framework revision that was known to work
 *     <NewName>/           the application, renamed in file names and in content
 *     pnpm-workspace.yaml  regenerated with the new application's entry
 *     AGENTS.md, CLAUDE.md, .gitignore, .vscode/, .claude/   the workspace-level files, renamed
 *
 * `old/` — the Signum sources this port reads from — is NOT carried over: a new application ports from
 * nothing. Neither are files git ignores, EXCEPT `.env.*`: those are copied (a new project wants the
 * shape of its environment) and are still ignored in the new repository, so the initial commit does not
 * contain them. Sharing one is then a deliberate `git add -f`.
 */
export namespace Clone {

    export interface Options {
        /** The new application's name — the directory, the package name, and every identifier prefix. */
        name?: string;
        /** Where to create it. The new project's root is `<directory>/<name>`. */
        directory?: string;
        /** Print what would happen and create nothing. */
        dryRun?: boolean;
        /** Skip the confirmation — for a scripted run, where there is nobody to answer it. */
        yes?: boolean;
    }

    /** Workspace-level files a new project inherits. Anything not here is the PORT's bookkeeping. */
    const ROOT_FILES = ["AGENTS.md", "CLAUDE.md", ".gitignore", "pnpm-workspace.yaml"];
    const ROOT_DIRECTORIES = [".vscode", ".claude"];

    /** Never copied, whatever the source holds. */
    const NEVER = new Set(["node_modules", "dist", "ts_out", ".git", "CodeGen", "TensorFlowModels"]);

    export async function run(uctx: UpgradeContext, options: Options = {}): Promise<void> {
        const name = await askName(options.name);
        if (name == undefined)
            return;

        const directory = await askDirectory(options.directory, uctx, options.yes === true);
        if (directory == undefined)
            return;

        const target = path.resolve(directory, name);
        if (fs.existsSync(target) && fs.readdirSync(target).length > 0)
            throw new Error(`${target} already exists and is not empty.`);

        SafeConsole.writeLine();
        SafeConsole.banner("Clone");
        SafeConsole.writeLine(`  from   ${uctx.rootFolder}  (application '${uctx.applicationName}')`);
        SafeConsole.writeLine(`  to     ${target}  (application '${name}')`);
        SafeConsole.writeLine();

        if (options.dryRun === true) {
            SafeConsole.writeLineColor(Color.yellow, "Dry run — nothing was created.");
            return;
        }

        if (options.yes !== true && !await SafeConsole.ask("Create it?"))
            return;

        fs.mkdirSync(target, { recursive: true });

        // 1. A repository first: the submodule needs one, and so does the initial commit.
        Git.init(target);
        SafeConsole.writeLineColor(Color.green, "  git init");

        // 2. The framework, as a submodule pinned to the SAME commit this workspace has checked out.
        //    A new project that starts against a different altea than the one the source was verified
        //    with would fail in ways that have nothing to do with the new application.
        addAlteaSubmodule(uctx, target);

        // 3. The application itself, renamed.
        const source = path.join(uctx.rootFolder, uctx.applicationName);
        copyRenamed(source, path.join(target, name), uctx.applicationName, name, uctx.rootFolder);
        SafeConsole.writeLineColor(Color.green, `  copied ${uctx.applicationName}/ -> ${name}/`);

        // 4. The workspace-level files.
        for (const f of ROOT_FILES) {
            const from = path.join(uctx.rootFolder, f);
            if (fs.existsSync(from))
                copyFileRenamed(from, path.join(target, f), uctx.applicationName, name);
        }
        for (const d of ROOT_DIRECTORIES) {
            const from = path.join(uctx.rootFolder, d);
            if (fs.existsSync(from))
                copyRenamed(from, path.join(target, d), uctx.applicationName, name, uctx.rootFolder);
        }
        SafeConsole.writeLineColor(Color.green, "  copied the workspace files");

        // 5. `old/` was not copied, so its submodule entry must not survive either.
        dropOldSubmodule(target);

        // 6. One commit, so the new project starts from a clean tree — which is what `simplify` needs.
        if (Git.commitAll(target, `Initial commit — ${name}, from ${uctx.applicationName}`))
            SafeConsole.writeLineColor(Color.white, "  initial commit created");

        SafeConsole.writeLine();
        SafeConsole.writeLineColor(Color.green, `${name} is ready at ${target}`);
        SafeConsole.writeLine();
        SafeConsole.writeLine("  Next:");
        SafeConsole.writeLine(`    cd ${target}`);
        SafeConsole.writeLine("    altea-simplify                      # drop the modules this app does not need");
        SafeConsole.writeLine("    pnpm install                        # simplify first: it needs no install,");
        SafeConsole.writeLine("    pnpm --filter quote-transformer build   # and install leaves an untracked lockfile");
        SafeConsole.writeLine(`    pnpm --filter ${name} build:types`);
        SafeConsole.writeLineColor(Color.darkGray,
            `    …then edit ${name}/.env.local — the copied environment files are git-ignored, `
            + "and still hold the source application's connection strings.");
    }

    // ---- prompts -----------------------------------------------------------------------------------

    async function askName(given: string | undefined): Promise<string | undefined> {
        return await Prompt.askValidated("New application name? ", value =>
            /^[a-z][a-z0-9]*$/.test(value)
                ? undefined
                : "The name is a package name AND a directory name: lower-case letters and digits, "
                + "starting with a letter (eastwind, northbreeze, acme).",
            given);
    }

    async function askDirectory(given: string | undefined, uctx: UpgradeContext, yes: boolean): Promise<string | undefined> {
        const parent = path.dirname(uctx.rootFolder);
        const answer = given ?? await SafeConsole.askString(
            `Parent directory? (Enter for ${parent}) `);

        const directory = answer === "" ? parent : path.resolve(answer);
        if (!fs.existsSync(directory)) {
            if (!yes && !await SafeConsole.ask(`${directory} does not exist. Create it?`))
                return undefined;
            fs.mkdirSync(directory, { recursive: true });
        }
        return directory;
    }

    // ---- the submodule -----------------------------------------------------------------------------

    function addAlteaSubmodule(uctx: UpgradeContext, target: string): void {
        const url = Git.submoduleUrl(uctx.rootFolder, "altea");
        if (url == undefined)
            throw new Error("Could not read altea's submodule url from .gitmodules.");

        const commit = Git.submoduleCommit(path.join(uctx.rootFolder, "altea"), "altea");

        Git.addSubmodule(target, url, "altea");
        SafeConsole.writeLineColor(Color.green, `  git submodule add ${url} altea`);

        if (commit == undefined)
            return;

        const submodule = path.join(target, "altea");
        if (Git.tryCheckout(submodule, commit)) {
            SafeConsole.writeLineColor(Color.darkGray, `    pinned to ${commit.slice(0, 10)}`);
            return;
        }

        // The revision this workspace is ON has not been pushed, so the fresh clone does not have it.
        // Copy the objects across rather than starting the new project on a different framework — but SAY
        // so: until altea is pushed, nobody else can clone the new project either.
        if (Git.fetchFrom(submodule, path.join(uctx.rootFolder, "altea"), commit)
            && Git.tryCheckout(submodule, commit)) {
            SafeConsole.writeLineColor(Color.darkGray, `    pinned to ${commit.slice(0, 10)}`);
            SafeConsole.writeLineColor(Color.yellow,
                "    WARNING: that altea commit is not on the remote — it was copied from this workspace.");
            SafeConsole.writeLineColor(Color.yellow,
                "             Push altea before anyone else clones the new project.");
            return;
        }

        SafeConsole.writeLineColor(Color.yellow,
            `    WARNING: could not pin altea to ${commit.slice(0, 10)}; it is on its default branch.`);
    }

    function dropOldSubmodule(target: string): void {
        const file = path.join(target, ".gitmodules");
        if (!fs.existsSync(file))
            return;

        const text = fs.readFileSync(file, "utf8");
        // The submodule add above rewrote .gitmodules, so `old` can only be here if it was copied in.
        if (!text.includes(`[submodule "old"]`))
            return;

        const newline = text.includes("\r\n") ? "\r\n" : "\n";
        const lines = text.split(/\r?\n/);
        const start = lines.findIndex(l => l.trim() === `[submodule "old"]`);
        let end = start + 1;
        while (end < lines.length && !lines[end].trimStart().startsWith("["))
            end++;
        lines.splice(start, end - start);
        fs.writeFileSync(file, lines.join(newline), "utf8");
    }

    // ---- copying -----------------------------------------------------------------------------------

    /**
     * Copy a tree, renaming both the PATHS and the CONTENT of text files.
     *
     * Ignored files are skipped — except `.env.*`, which a new project wants (see the header). Binary
     * files are copied byte for byte: a rename pass over a .png would corrupt it, and no image has an
     * application name inside it that matters.
     */
    function copyRenamed(source: string, destination: string, from: string, to: string, gitRoot: string): void {
        fs.mkdirSync(destination, { recursive: true });

        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            if (NEVER.has(entry.name))
                continue;

            const sourcePath = path.join(source, entry.name);
            const renamed = UpgradeContext.rename(entry.name, from, to);
            const destinationPath = path.join(destination, renamed);

            if (entry.isDirectory()) {
                copyRenamed(sourcePath, destinationPath, from, to, gitRoot);
                // A directory that ended up empty (everything in it was ignored) is not worth creating.
                if (fs.readdirSync(destinationPath).length === 0)
                    fs.rmdirSync(destinationPath);
                continue;
            }

            if (!shouldCopy(sourcePath, entry.name, gitRoot))
                continue;

            copyFileRenamed(sourcePath, destinationPath, from, to);
        }
    }

    function shouldCopy(sourcePath: string, fileName: string, gitRoot: string): boolean {
        // `.env.*` is ignored on purpose and copied on purpose — the new project gets the shape of its
        // environment, and the copy stays out of its first commit because it is ignored THERE too.
        if (fileName.startsWith(".env"))
            return true;

        return !Git.isIgnored(gitRoot, path.relative(gitRoot, sourcePath).replace(/\\/g, "/"));
    }

    function copyFileRenamed(source: string, destination: string, from: string, to: string): void {
        fs.mkdirSync(path.dirname(destination), { recursive: true });

        const raw = fs.readFileSync(source);
        if (isBinary(raw)) {
            fs.writeFileSync(destination, raw);
            return;
        }

        fs.writeFileSync(destination, UpgradeContext.rename(raw.toString("utf8"), from, to), "utf8");
    }

    /** A NUL byte in the first few KB — the same heuristic git uses to decide a file is not text. */
    function isBinary(buffer: Buffer): boolean {
        return buffer.subarray(0, 8000).includes(0);
    }
}
