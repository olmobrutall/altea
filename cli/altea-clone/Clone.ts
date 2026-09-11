import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { ApplicationContext, Color, Console, Git, Prompt } from "@altea/altea-cli-utils";

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

    /**
     * What gets copied is decided by GIT, not by a list here: every file the repository tracks, plus
     * anything new that is not ignored, plus the `.env.<environment>` files — which are ignored on
     * purpose and wanted anyway (see the header).
     *
     * `.gitmodules` is the one exclusion, because the new repository writes its own when `altea` is
     * added. A SUBMODULE is skipped for free: git lists it as a single entry, which is a directory on
     * disk rather than a file — so neither `altea/` (added fresh) nor `old/` (the Signum sources a new
     * application ports from nothing) comes across.
     */
    const NEVER_COPIED = new Set([".gitmodules"]);

    export async function run(uctx: ApplicationContext, options: Options = {}): Promise<void> {
        const name = await askName(options.name);
        if (name == undefined)
            return;

        const directory = await askDirectory(options.directory, uctx, options.yes === true);
        if (directory == undefined)
            return;

        const target = path.resolve(directory, name);
        if (fs.existsSync(target) && fs.readdirSync(target).length > 0)
            throw new Error(`${target} already exists and is not empty.`);

        Console.writeLine();
        Console.banner("Clone");
        Console.writeLine(`  from   ${uctx.rootFolder}  (application '${uctx.applicationName}')`);
        Console.writeLine(`  to     ${target}  (application '${name}')`);
        Console.writeLine();

        if (options.dryRun === true) {
            Console.writeLineColor(Color.yellow, "Dry run — nothing was created.");
            return;
        }

        if (options.yes !== true && !await Console.ask("Create it?"))
            return;

        fs.mkdirSync(target, { recursive: true });

        // 1. A repository first: the submodule needs one, and so does the initial commit.
        Git.init(target);
        Console.writeLineColor(Color.green, "  git init");

        // 2. The framework, as a submodule pinned to the SAME commit this workspace has checked out.
        //    A new project that starts against a different altea than the one the source was verified
        //    with would fail in ways that have nothing to do with the new application.
        addAlteaSubmodule(uctx, target);

        // 3. Everything the repository holds, renamed — the application and the workspace-level files
        //    alike. See NEVER_COPIED for what git leaves out and why.
        const copied = copyProject(uctx, target, name);
        Console.writeLineColor(Color.green, `  copied ${copied} files, ${uctx.applicationName} -> ${name}`);

        // 6. One commit, so the new project starts from a clean tree — which is what `simplify` needs.
        if (Git.commitAll(target, `Initial commit — ${name}, from ${uctx.applicationName}`))
            Console.writeLineColor(Color.white, "  initial commit created");

        Console.writeLine();
        Console.writeLineColor(Color.green, `${name} is ready at ${target}`);
        Console.writeLine();
        Console.writeLine("  Next:");
        Console.writeLine(`    cd ${target}`);
        // The CLIs are workspace packages of the framework, so in a project that has not been installed
        // yet they are neither linked nor built. The one the developer just ran IS, so name it by its own
        // path rather than pretending `altea-simplify` is on theirs.
        Console.writeLine(`    node "${simplifyPath()}"`);
        Console.writeLine("    pnpm install");
        Console.writeLine("    pnpm --filter quote-transformer build");
        Console.writeLine(`    pnpm --filter ${name} build:types`);
        Console.writeLine();
        Console.writeLineColor(Color.darkGray,
            `    Then edit ${name}/.env.local — the environment files came across, are git-ignored, and `
            + "still hold the source application's connection strings.");
    }

    /**
     * Where `altea-simplify` is, derived from where THIS tool is: the two are siblings in the framework's
     * `cli/` folder, and a developer who could run one can run the other.
     */
    function simplifyPath(): string {
        const here = path.dirname(url.fileURLToPath(import.meta.url));       // …/cli/altea-clone/dist
        return path.resolve(here, "..", "..", "altea-simplify", "dist", "main.js");
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

    async function askDirectory(given: string | undefined, uctx: ApplicationContext, yes: boolean): Promise<string | undefined> {
        const parent = path.dirname(uctx.rootFolder);
        const answer = given ?? await Console.askString(
            `Parent directory? (Enter for ${parent}) `);

        const directory = answer === "" ? parent : path.resolve(answer);
        if (!fs.existsSync(directory)) {
            if (!yes && !await Console.ask(`${directory} does not exist. Create it?`))
                return undefined;
            fs.mkdirSync(directory, { recursive: true });
        }
        return directory;
    }

    // ---- the submodule -----------------------------------------------------------------------------

    function addAlteaSubmodule(uctx: ApplicationContext, target: string): void {
        const url = Git.submoduleUrl(uctx.rootFolder, "altea");
        if (url == undefined)
            throw new Error("Could not read altea's submodule url from .gitmodules.");

        const commit = Git.submoduleCommit(path.join(uctx.rootFolder, "altea"), "altea");

        Git.addSubmodule(target, url, "altea");
        Console.writeLineColor(Color.green, `  git submodule add ${url} altea`);

        if (commit == undefined)
            return;

        const submodule = path.join(target, "altea");
        if (Git.tryCheckout(submodule, commit)) {
            Console.writeLineColor(Color.darkGray, `    pinned to ${commit.slice(0, 10)}`);
            return;
        }

        // The revision this workspace is ON has not been pushed, so the fresh clone does not have it.
        // Copy the objects across rather than starting the new project on a different framework — but SAY
        // so: until altea is pushed, nobody else can clone the new project either.
        if (Git.fetchFrom(submodule, path.join(uctx.rootFolder, "altea"), commit)
            && Git.tryCheckout(submodule, commit)) {
            Console.writeLineColor(Color.darkGray, `    pinned to ${commit.slice(0, 10)}`);
            Console.writeLineColor(Color.yellow,
                "    WARNING: that altea commit is not on the remote — it was copied from this workspace.");
            Console.writeLineColor(Color.yellow,
                "             Push altea before anyone else clones the new project.");
            return;
        }

        Console.writeLineColor(Color.yellow,
            `    WARNING: could not pin altea to ${commit.slice(0, 10)}; it is on its default branch.`);
    }

    // ---- copying -----------------------------------------------------------------------------------

    /**
     * Copy a tree, renaming both the PATHS and the CONTENT of text files.
     *
     * Ignored files are skipped — except `.env.*`, which a new project wants (see the header). Binary
     * files are copied byte for byte: a rename pass over a .png would corrupt it, and no image has an
     * application name inside it that matters.
     */
    /** Ask git what belongs to the project, then copy each file with its path and content renamed. */
    function copyProject(uctx: ApplicationContext, target: string, name: string): number {
        const root = uctx.rootFolder;

        const files = [
            ...Git.trackedFiles(root),
            ...Git.untrackedFiles(root),
            // The environment files are ignored BY DESIGN and copied anyway: a new project wants the
            // shape of its environment, and they stay ignored there, so they are never in its first
            // commit. A pathspec keeps this from walking node_modules.
            ...Git.ignoredFiles(root, `${uctx.applicationName}/.env*`),
        ];

        let copied = 0;
        for (const relative of new Set(files)) {
            if (NEVER_COPIED.has(relative) || Git.isGitlink(root, relative))
                continue;

            copyFileRenamed(path.join(root, relative),
                path.join(target, ApplicationContext.rename(relative, uctx.applicationName, name)),
                uctx.applicationName, name);
            copied++;
        }
        return copied;
    }

    function copyFileRenamed(source: string, destination: string, from: string, to: string): void {
        fs.mkdirSync(path.dirname(destination), { recursive: true });

        const raw = fs.readFileSync(source);
        if (isBinary(raw)) {
            fs.writeFileSync(destination, raw);
            return;
        }

        fs.writeFileSync(destination, ApplicationContext.rename(raw.toString("utf8"), from, to), "utf8");
    }

    /** A NUL byte in the first few KB — the same heuristic git uses to decide a file is not text. */
    function isBinary(buffer: Buffer): boolean {
        return buffer.subarray(0, 8000).includes(0);
    }
}
