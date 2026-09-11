import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Color, Console } from "./Console.js";

/**
 * The git operations the tool needs, by shelling out.
 *
 * Signum.Upgrade uses **LibGit2Sharp**; Node has no maintained equivalent, and every operation here is a
 * one-liner on the CLI that every developer already has. The trade is that `git` must be on PATH — which
 * it is, since none of this makes sense outside a checkout.
 *
 * Every call is SYNCHRONOUS on purpose: the tool is a prompt-driven console session, and interleaving a
 * commit with a question would only make the order harder to reason about.
 */
export namespace Git {

    export function run(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
        const r = spawnSync("git", args, { cwd, encoding: "utf8" });
        if (r.error != null)
            throw new Error(`git ${args.join(" ")} could not be started: ${r.error.message}. Is git on PATH?`);
        return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
    }

    function must(cwd: string, args: string[]): string {
        const r = run(cwd, args);
        if (!r.ok)
            throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
        return r.stdout;
    }

    export function isRepository(cwd: string): boolean {
        return run(cwd, ["rev-parse", "--git-dir"]).ok;
    }

    /**
     * Whether the working tree has changes, IGNORING submodules — Signum's `IsDirtyExceptSubmodules`.
     * The exclusion matters: `altea/` is a submodule and is nearly always ahead of the superproject's
     * recorded commit during development, which would otherwise make every upgrade refuse to start.
     */
    export function isDirtyExceptSubmodules(cwd: string): boolean {
        return must(cwd, ["status", "--porcelain", "--ignore-submodules=all"]) !== "";
    }

    /** Stage everything and commit. Returns false when there was nothing to commit. */
    export function commitAll(cwd: string, message: string): boolean {
        must(cwd, ["add", "-A"]);
        if (must(cwd, ["diff", "--cached", "--name-only"]) === "")
            return false;

        // -m via argv, never through a shell: a commit message is arbitrary text.
        must(cwd, ["commit", "-m", message]);
        return true;
    }

    export function init(cwd: string, initialBranch = "main"): void {
        must(cwd, ["init", "-b", initialBranch]);
    }

    export function addSubmodule(cwd: string, url: string, relativePath: string): void {
        must(cwd, ["submodule", "add", url, relativePath]);
    }

    /** The URL a submodule was cloned from, so a new project points at the same altea. */
    export function submoduleUrl(cwd: string, relativePath: string): string | undefined {
        const r = run(cwd, ["config", "--file", ".gitmodules", `submodule.${relativePath}.url`]);
        return r.ok && r.stdout !== "" ? r.stdout : undefined;
    }

    /** The commit a submodule is checked out at, so a new project starts from the SAME framework revision. */
    export function submoduleCommit(cwd: string, relativePath: string): string | undefined {
        const r = run(cwd, ["rev-parse", "HEAD"]);
        return r.ok && r.stdout !== "" ? r.stdout : undefined;
    }

    /** Detach onto a commit. Returns false when the commit is not in this repository. */
    export function tryCheckout(cwd: string, commit: string): boolean {
        return run(cwd, ["checkout", "--detach", commit]).ok;
    }

    /**
     * Copy objects from another checkout of the same repository — how a commit that exists only LOCALLY
     * reaches a fresh clone. `git submodule add` clones the remote, so a framework revision that has not
     * been pushed is simply absent from it.
     */
    export function fetchFrom(cwd: string, source: string, commit: string): boolean {
        return run(cwd, ["fetch", "--no-tags", source, commit]).ok;
    }

    /**
     * Block until the working tree is clean, because every command here edits source IN PLACE and the git
     * diff is the only review there is.
     *
     * Without a console there is nobody to clean it up, so this FAILS rather than looping: the first
     * version waited on `readline`, which returns "" immediately on a closed stdin, and a scripted run
     * printed "commit or reset, then press [Enter]" forever.
     */
    export async function waitForCleanTree(cwd: string, action = "Commit or reset them"): Promise<void> {
        for (; ;) {
            if (!isDirtyExceptSubmodules(cwd))
                return;

            const dirty = run(cwd, ["status", "--porcelain", "--ignore-submodules=all"]).stdout;

            if (!Console.isInteractive())
                throw new Error("The git repo has uncommitted changes, and there is no console to resolve "
                    + `them on:\n${dirty}`);

            Console.writeLine();
            Console.writeLineColor(Color.yellow, `There are changes in the git repo:\n${dirty}`);
            Console.writeLineColor(Color.yellow, `${action}, then press [Enter].`);
            await Console.askString("");
        }
    }

    /**
     * The files git KNOWS about, repository-root-relative with forward slashes.
     *
     * This replaces every hand-written ignore list these tools used to carry. "What belongs to the
     * project" is a question `.gitignore` already answers, in one place, for every tool — so asking git
     * cannot drift from what a developer sees, needs no maintenance when a build directory is added, and
     * honours nested `.gitignore` files that a flat list of directory names cannot express.
     *
     * It is also one subprocess for the whole tree, where the previous `check-ignore` per file was one
     * per file.
     *
     * A SUBMODULE appears as a single entry (its gitlink path) and its contents do not, which is exactly
     * right for both callers: the copier adds `altea` fresh, and an upgrade must never edit the framework
     * it is being run by. {@link isGitlink} is how a caller drops those entries.
     *
     * @param pathspec  limit to a directory or glob — `"eastwind"`, `"eastwind/.env*"`. A pathspec also
     *                  limits the WALK, which matters: enumerating ignored files without one descends into
     *                  `node_modules` and produces megabytes.
     */
    export function trackedFiles(cwd: string, pathspec?: string): string[] {
        return list(cwd, ["ls-files", "-z"], pathspec);
    }

    /** Files present but not yet committed, EXCLUDING ignored ones — new work a copy should carry over. */
    export function untrackedFiles(cwd: string, pathspec?: string): string[] {
        return list(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], pathspec);
    }

    /**
     * Files git IGNORES. Always pass a pathspec — see {@link trackedFiles}. The one caller wants the
     * `.env.<environment>` files, which are ignored on purpose and wanted anyway.
     */
    export function ignoredFiles(cwd: string, pathspec: string): string[] {
        return list(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], pathspec);
    }

    /**
     * Whether a listed path is a SUBMODULE rather than a file. `ls-files` reports a submodule as one
     * entry; on disk that entry is a directory, which is the cheapest way to tell them apart (the
     * alternative, `ls-files --stage` and a mode-160000 test, parses more to learn the same thing).
     */
    export function isGitlink(cwd: string, relativePath: string): boolean {
        const full = join(cwd, relativePath);
        return existsSync(full) && statSync(full).isDirectory();
    }

    function list(cwd: string, args: string[], pathspec?: string): string[] {
        const full = pathspec == undefined ? args : [...args, "--", pathspec];
        // -z: NUL-separated, so a path with a space, a quote or a non-ASCII character comes back intact
        // (git QUOTES such paths in its default output, which would have to be un-quoted).
        return must(cwd, full).split("\0").filter(p => p !== "");
    }
}
