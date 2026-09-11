import { spawnSync } from "node:child_process";
import { Color, SafeConsole } from "@altea/altea/server/safeConsole";

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

            if (!SafeConsole.isInteractive())
                throw new Error("The git repo has uncommitted changes, and there is no console to resolve "
                    + `them on:\n${dirty}`);

            SafeConsole.writeLine();
            SafeConsole.writeLineColor(Color.yellow, `There are changes in the git repo:\n${dirty}`);
            SafeConsole.writeLineColor(Color.yellow, `${action}, then press [Enter].`);
            await SafeConsole.askString("");
        }
    }

    /** Whether a path is ignored — the copier uses it to decide what NOT to carry over. */
    export function isIgnored(cwd: string, relativePath: string): boolean {
        return run(cwd, ["check-ignore", "-q", relativePath]).ok;
    }
}
