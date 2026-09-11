import * as fs from "node:fs";
import * as path from "node:path";
import { Color, Console } from "./Console.js";
import type { UpgradeContext } from "./UpgradeContext.js";

/**
 * How loudly a helper complains when what it was told to change is not there.
 *
 * Port of Signum.Upgrade's `WarningLevel`. The whole point of the levels is that an upgrade written
 * against Southwind is replayed against an application that has drifted from it: "the line I meant to
 * replace is missing" is sometimes a broken upgrade (Error) and sometimes just a module this app never
 * had (Warning / None), and only the upgrade's author knows which.
 */
export enum WarningLevel {
    None = 0,
    Warning = 1,
    Error = 2,
}

/** A predicate over a source line. Its SOURCE TEXT is printed when it matches nothing — see {@link describe}. */
export type LinePredicate = (line: string) => boolean;

/** Where a span starts or ends: a predicate, plus an optional line offset and a couple of modifiers. */
export interface SpanOption {
    condition: LinePredicate;
    /** Lines to move the found index by — Signum's `ReplaceBetweenOption.Delta`. */
    delta?: number;
    /** Match the LAST line satisfying the condition rather than the first. */
    lastIndex?: boolean;
    /** End the span at the line with the same indentation as the start (a closing brace). */
    sameIndentation?: boolean;
}

/**
 * One source file, opened for editing by an upgrade.
 *
 * Port of Signum.Upgrade's `CodeFile`. The API is deliberately LINE-oriented rather than AST-oriented:
 * an upgrade is replayed against source that has drifted, so it has to be able to say "the line that
 * mentions X" and be told when that no longer matches — which an AST rewrite cannot express.
 *
 * Two altea divergences:
 *
 *  - Signum takes `Expression<Predicate<string>>` purely so it can PRINT the predicate in a warning.
 *    TypeScript needs no such trick: `fn.toString()` is the source text, so the plain function is both
 *    callable and printable.
 *  - The .NET-only helpers are not ported: `UpdateNugetReference*` / `AddNugetReference` /
 *    `RemoveNugetReference` (no NuGet) and `Solution_AddProject` / `Solution_RemoveProject` /
 *    `Solution_AddFolder` / `Solution_AddSolutionItem` (no .sln — the counterpart is a workspace entry,
 *    which {@link UpgradeContext.changeWorkspace} edits). The npm helpers ARE ported, and gain the
 *    workspace-protocol case Signum has no equivalent for.
 *
 * The file's newline style and UTF-8 BOM are preserved: rewriting a whole repository's line endings on
 * the way past would bury the actual change in a diff nobody can review.
 */
export class CodeFile {
    /** Relative to the context's root folder, with forward slashes. */
    readonly filePath: string;
    readonly uctx: UpgradeContext;

    warningLevel: WarningLevel = WarningLevel.Error;

    private originalContent: string;
    private currentContent: string;
    private readonly newline: string;
    private readonly bom: boolean;
    /** Set by {@link moveTo}; the save writes here and deletes the original. */
    private newFilePath: string | undefined;

    constructor(filePath: string, uctx: UpgradeContext) {
        this.filePath = filePath.replace(/\\/g, "/");
        this.uctx = uctx;

        const raw = fs.readFileSync(uctx.absolutePath(this.filePath));
        this.bom = raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
        const text = raw.toString("utf8").replace(/^﻿/, "");
        this.newline = text.includes("\r\n") ? "\r\n" : "\n";
        this.originalContent = text;
        this.currentContent = text;
    }

    override_toString(): string { return this.filePath; }
    toString(): string { return this.filePath; }

    get content(): string { return this.currentContent; }
    set content(value: string) { this.currentContent = value; }

    /** The content split into lines, with the file's own newline discarded. */
    get lines(): string[] { return this.currentContent.split(/\r?\n/); }
    set lines(value: string[]) { this.currentContent = value.join(this.newline); }

    /** Whether anything actually changed — a save is skipped otherwise, so the diff stays honest. */
    get isModified(): boolean { return this.currentContent !== this.originalContent || this.newFilePath != undefined; }

    // ---- reporting -------------------------------------------------------------------------------

    /**
     * Report that an edit matched nothing, at this file's current warning level. Signum's
     * `CodeFile.Warning`. Escalates the CONTEXT's level, which is what the runner prints at the end —
     * so an upgrade that half-applied says so instead of finishing green.
     */
    warning(message: string): void {
        if (this.warningLevel === WarningLevel.None)
            return;

        this.uctx.reportWarning(this.warningLevel);

        const style = this.warningLevel === WarningLevel.Error ? Color.red : Color.yellow;
        Console.writeLineColor(style,
            `${WarningLevel[this.warningLevel].toUpperCase()} ${this.filePath}: ${message}`);
    }

    /** The source text of a predicate, for a warning — Signum prints its expression tree for the same reason. */
    private static describe(predicate: LinePredicate): string {
        return predicate.toString().replace(/\s+/g, " ").trim();
    }

    // ---- whole-content edits ---------------------------------------------------------------------

    /** Replace every occurrence of a literal string, or of a regex (which must be global to replace all). */
    replace(searchFor: string | RegExp, replaceBy: string): void {
        const next = typeof searchFor === "string"
            ? this.currentContent.split(searchFor).join(replaceBy)
            : this.currentContent.replace(searchFor, replaceBy);

        if (next === this.currentContent)
            this.warning(`${searchFor} not found`);

        this.currentContent = next;
    }

    /** Replace with a function of the match, for the cases a literal replacement cannot express. */
    replaceWith(regex: RegExp, evaluator: (...args: string[]) => string): void {
        const next = this.currentContent.replace(regex, evaluator as never);
        if (next === this.currentContent)
            this.warning(`${regex} not found`);
        this.currentContent = next;
    }

    /** True when the file mentions this text — the usual guard before an idempotent edit. */
    contains(text: string | RegExp): boolean {
        return typeof text === "string" ? this.currentContent.includes(text) : text.test(this.currentContent);
    }

    // ---- line edits ------------------------------------------------------------------------------

    /** Work on the lines directly. Return false to report "nothing matched" at the file's warning level. */
    processLines(process: (lines: string[]) => boolean): void {
        const lines = this.lines;
        if (process(lines))
            this.lines = lines;
        else
            this.warning("processLines did not change anything");
    }

    removeAllLines(condition: LinePredicate): void {
        this.processLines(lines => {
            let removed = 0;
            for (let i = lines.length - 1; i >= 0; i--)
                if (condition(lines[i])) { lines.splice(i, 1); removed++; }

            if (removed === 0)
                this.warning(`no line matches ${CodeFile.describe(condition)}`);
            return removed > 0;
        });
    }

    replaceLine(condition: LinePredicate, text: string): void {
        this.processLines(lines => {
            const i = lines.findIndex(condition);
            if (i < 0) { this.warning(`no line matches ${CodeFile.describe(condition)}`); return false; }
            lines.splice(i, 1, ...CodeFile.indentLike(lines[i], text));
            return true;
        });
    }

    insertBeforeFirstLine(condition: LinePredicate, text: string): void {
        this.insertAt(condition, text, "before", "first");
    }

    insertAfterFirstLine(condition: LinePredicate, text: string): void {
        this.insertAt(condition, text, "after", "first");
    }

    insertBeforeLastLine(condition: LinePredicate, text: string): void {
        this.insertAt(condition, text, "before", "last");
    }

    insertAfterLastLine(condition: LinePredicate, text: string): void {
        this.insertAt(condition, text, "after", "last");
    }

    private insertAt(condition: LinePredicate, text: string, where: "before" | "after", which: "first" | "last"): void {
        this.processLines(lines => {
            const i = which === "first" ? lines.findIndex(condition) : findLastIndex(lines, condition);
            if (i < 0) { this.warning(`no line matches ${CodeFile.describe(condition)}`); return false; }
            lines.splice(where === "before" ? i : i + 1, 0, ...CodeFile.indentLike(lines[i], text));
            return true;
        });
    }

    // ---- spans -----------------------------------------------------------------------------------

    /** The lines of a span, INCLUDING both bounds. */
    getLinesBetweenIncluded(from: LinePredicate | SpanOption, to: LinePredicate | SpanOption): string | undefined {
        const range = this.findSpan(from, to);
        return range == undefined ? undefined : this.lines.slice(range.from, range.to + 1).join(this.newline);
    }

    /** The lines of a span, EXCLUDING both bounds. */
    getLinesBetweenExcluded(from: LinePredicate | SpanOption, to: LinePredicate | SpanOption): string | undefined {
        const range = this.findSpan(from, to);
        return range == undefined ? undefined : this.lines.slice(range.from + 1, range.to).join(this.newline);
    }

    replaceBetweenIncluded(from: LinePredicate | SpanOption, to: LinePredicate | SpanOption,
        text: string | ((old: string) => string)): void {
        this.replaceSpan(from, to, text, /* included */ true);
    }

    replaceBetweenExcluded(from: LinePredicate | SpanOption, to: LinePredicate | SpanOption,
        text: string | ((old: string) => string)): void {
        this.replaceSpan(from, to, text, /* included */ false);
    }

    /** Remove a whole span, both bounds included — the shape most "this block is gone" upgrades want. */
    removeBetweenIncluded(from: LinePredicate | SpanOption, to: LinePredicate | SpanOption): void {
        this.processLines(lines => {
            const range = this.findSpan(from, to);
            if (range == undefined) return false;
            lines.splice(range.from, range.to - range.from + 1);
            return true;
        });
    }

    private replaceSpan(from: LinePredicate | SpanOption, to: LinePredicate | SpanOption,
        text: string | ((old: string) => string), included: boolean): void {
        this.processLines(lines => {
            const range = this.findSpan(from, to);
            if (range == undefined) return false;

            const start = included ? range.from : range.from + 1;
            const end = included ? range.to : range.to - 1;
            if (end < start - 1) return false;

            const old = lines.slice(start, end + 1).join(this.newline);
            const replacement = typeof text === "string" ? text : text(old);
            lines.splice(start, end - start + 1, ...CodeFile.indentLike(lines[range.from], replacement));
            return true;
        });
    }

    /**
     * A METHOD's body, by the line that declares it — Signum's `GetMethodBody` / `ReplaceMethod`. The end
     * is the closing brace at the DECLARATION's indentation, which is what makes it work for a nested
     * method without a brace-counting parser.
     */
    getMethodBody(methodLine: LinePredicate): string | undefined {
        return this.getLinesBetweenExcluded(methodLine, { condition: l => l.trim() === "}", sameIndentation: true });
    }

    replaceMethod(methodLine: LinePredicate, text: string): void {
        this.replaceBetweenExcluded(methodLine, { condition: l => l.trim() === "}", sameIndentation: true }, text);
    }

    private findSpan(from: LinePredicate | SpanOption, to: LinePredicate | SpanOption):
        { from: number; to: number } | undefined {
        const fromOpt = typeof from === "function" ? { condition: from } : from;
        const toOpt = typeof to === "function" ? { condition: to } : to;
        const lines = this.lines;

        const start = (fromOpt.lastIndex === true ? findLastIndex(lines, fromOpt.condition) : lines.findIndex(fromOpt.condition))
            + (fromOpt.delta ?? 0);

        if (start < 0 || start >= lines.length) {
            this.warning(`no line matches ${CodeFile.describe(fromOpt.condition)}`);
            return undefined;
        }

        const indent = CodeFile.indentOf(lines[start]);
        let end = -1;
        for (let i = start + 1; i < lines.length; i++) {
            if (!toOpt.condition(lines[i]))
                continue;
            if (toOpt.sameIndentation === true && CodeFile.indentOf(lines[i]) !== indent)
                continue;
            end = i;
            if (toOpt.lastIndex !== true)
                break;
        }
        end += toOpt.delta ?? 0;

        if (end < start) {
            this.warning(`no line matches ${CodeFile.describe(toOpt.condition)} after `
                + `${CodeFile.describe(fromOpt.condition)}`);
            return undefined;
        }

        return { from: start, to: end };
    }

    // ---- package.json ----------------------------------------------------------------------------

    /**
     * Set a dependency's version, in whichever section already declares it. Signum's `UpdateNpmPackage`.
     * A `workspace:*` entry is LEFT ALONE: its version is the checked-out package's, so writing a number
     * there would break the link — the case Signum's yarn/npm-only version has no counterpart for.
     */
    updateNpmPackage(packageName: string, version: string): void {
        this.eachJsonDependency((section, name, current) => {
            if (name !== packageName) return undefined;
            if (current.startsWith("workspace:")) {
                this.warning(`${packageName} is a workspace dependency in ${section}; left at ${current}`);
                return undefined;
            }
            return version;
        }, `${packageName} not found in any dependencies section`);
    }

    removeNpmPackage(packageName: string): void {
        this.removeAllLines(l => new RegExp(`^\\s*"${escapeRegex(packageName)}"\\s*:`).test(l));
    }

    /** Add a dependency, keeping the section's formatting — inserted after the last entry of the section. */
    addNpmPackage(packageName: string, version: string, devDependency = false): void {
        const section = devDependency ? "devDependencies" : "dependencies";
        if (new RegExp(`"${escapeRegex(packageName)}"\\s*:`).test(this.currentContent)) {
            this.warning(`${packageName} is already a dependency`);
            return;
        }

        this.processLines(lines => {
            const open = lines.findIndex(l => new RegExp(`^\\s*"${section}"\\s*:\\s*\\{`).test(l));
            if (open < 0) { this.warning(`no "${section}" section`); return false; }

            const close = lines.findIndex((l, i) => i > open && /^\s*\}/.test(l));
            if (close < 0) { this.warning(`"${section}" is not closed`); return false; }

            const last = close - 1;
            if (last > open && !lines[last].trimEnd().endsWith(","))
                lines[last] = lines[last].trimEnd() + ",";

            const indent = last > open ? CodeFile.indentOf(lines[last]) : CodeFile.indentOf(lines[open]) + "  ";
            lines.splice(close, 0, `${indent}"${packageName}": "${version}"`);
            return true;
        });
    }

    private eachJsonDependency(map: (section: string, name: string, version: string) => string | undefined,
        notFound: string): void {
        let section = "";
        let hit = false;
        this.processLines(lines => {
            for (let i = 0; i < lines.length; i++) {
                const sec = /^\s*"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/.exec(lines[i]);
                if (sec != null) { section = sec[1]; continue; }

                const dep = /^(\s*")([^"]+)("\s*:\s*")([^"]*)(".*)$/.exec(lines[i]);
                if (dep == null || section === "") continue;

                const next = map(section, dep[2], dep[4]);
                if (next != undefined) { lines[i] = dep[1] + dep[2] + dep[3] + next + dep[5]; hit = true; }
            }
            if (!hit) this.warning(notFound);
            return hit;
        });
    }

    // ---- TypeScript imports ----------------------------------------------------------------------

    /**
     * Rewrite the NAMED parts of every import whose module specifier matches — the shape a module rename
     * or a moved export needs. Return undefined to leave an import alone, or an empty set to delete it.
     * Signum's `ReplacePartsInTypeScriptImport`.
     */
    replacePartsInImport(pathPredicate: (specifier: string) => boolean,
        select: (specifier: string, parts: string[]) => string[] | undefined): void {
        const regex = /^(?<head>\s*import\s+(?:type\s+)?\{)(?<parts>[^}]*)\}\s*from\s*["'](?<path>[^"']+)["'];?\s*$/;
        let hit = false;

        this.processLines(lines => {
            for (let i = lines.length - 1; i >= 0; i--) {
                const m = regex.exec(lines[i]);
                if (m?.groups == null || !pathPredicate(m.groups["path"])) continue;

                const parts = m.groups["parts"].split(",").map(p => p.trim()).filter(p => p !== "");
                const next = select(m.groups["path"], parts);
                if (next == undefined) continue;

                hit = true;
                if (next.length === 0)
                    lines.splice(i, 1);
                else
                    lines[i] = `${m.groups["head"]} ${next.join(", ")} } from "${m.groups["path"]}";`;
            }
            if (!hit) this.warning("no import matched");
            return hit;
        });
    }

    /** Point every import of `from` at `to`, leaving the named parts alone. */
    moveImport(from: string, to: string): void {
        const before = this.currentContent;
        this.currentContent = this.currentContent.replace(
            new RegExp(`(from\\s*["'])${escapeRegex(from)}(["'])`, "g"), `$1${to}$2`);
        if (this.currentContent === before)
            this.warning(`no import from "${from}"`);
    }

    // ---- moving and saving -------------------------------------------------------------------------

    /** Rename / move this file when it is saved. Signum's `CodeFile.MoveFile`. */
    moveTo(newFilePath: string): void {
        this.newFilePath = this.uctx.replaceApplicationName(newFilePath).replace(/\\/g, "/");
    }

    /** Write only if something changed — so an upgrade that matched nothing leaves no diff at all. */
    saveIfNecessary(): void {
        if (!this.isModified)
            return;

        const target = this.newFilePath ?? this.filePath;
        const absolute = this.uctx.absolutePath(target);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, (this.bom ? "﻿" : "") + this.currentContent, "utf8");

        if (this.newFilePath != undefined && this.newFilePath !== this.filePath) {
            fs.rmSync(this.uctx.absolutePath(this.filePath), { force: true });
            Console.writeLineColor(Color.yellow, `  Moved ${this.filePath} -> ${this.newFilePath}`);
        } else {
            Console.writeLineColor(Color.darkGray, `  Modified ${this.filePath}`);
        }

        this.originalContent = this.currentContent;
    }

    // ---- helpers -----------------------------------------------------------------------------------

    static indentOf(line: string): string {
        return /^\s*/.exec(line)?.[0] ?? "";
    }

    /**
     * Give every line of `text` the indentation of `sample`, EXCEPT the first — which is already placed by
     * the caller, and whose own indentation the template literal in the upgrade usually supplies. Signum's
     * `GetIndent` + the `Indent` call at every insertion point.
     */
    private static indentLike(sample: string, text: string): string[] {
        const indent = CodeFile.indentOf(sample);
        const lines = text.split(/\r?\n/);
        return lines.map((l, i) => i === 0 || l.trim() === "" ? l : indent + l.replace(/^\s*/, ""));
    }
}

/** `Array.prototype.findLastIndex` is ES2023; the shared base preset targets lower. */
function findLastIndex(lines: string[], condition: LinePredicate): number {
    for (let i = lines.length - 1; i >= 0; i--)
        if (condition(lines[i]))
            return i;
    return -1;
}

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
