#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassMap, type Kind } from "./ClassMap.js";
import { sweepSource, type SweepOptions, type SweepReport } from "./ClassSweep.js";

/**
 * Applies Tailwind-ClassMap.md to source trees — what the altea packages themselves are migrated with, and
 * what the application upgrades call.
 *
 *   node dist/tailwind/sweep.js [--write] [--apply U,X] [--skip "Layout and grid"] [--report out.md] <dir>…
 *
 * Without --write it only reports.
 */
export const CLASS_MAP_PATH: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../Tailwind-ClassMap.md");

export interface FileReport { file: string; changed: number; reports: SweepReport[]; }

export function sweepTree(dirs: string[], map: ClassMap, options: SweepOptions, write: boolean): FileReport[] {
    const results: FileReport[] = [];
    for (const file of dirs.flatMap(d => walk(d))) {
        const content = fs.readFileSync(file, "utf8");
        const r = file.endsWith(".css") ? sweepCss(content, map, options) : sweepSource(file, content, map, options);
        if (write && r.content !== content)
            fs.writeFileSync(file, r.content);
        if (r.changed || r.reports.length)
            results.push({ file, changed: r.changed, reports: r.reports });
    }
    return results;
}

/**
 * A stylesheet's selectors. A class the sweep renames to its semantic `sf-` name is renamed here too (the
 * framework owns both ends); a utility it rewrites is reported, since its selector would silently stop matching.
 */
export function sweepCss(content: string, map: ClassMap, options: SweepOptions): { content: string, changed: number, reports: SweepReport[] } {
    const reports: SweepReport[] = [];
    let changed = 0;
    const lookup = (cls: string) => {
        const t = map.translate(cls);
        return t == null || options.skipSections?.includes(t.section) || (options.onlySections && !options.onlySections.includes(t.section)) ? undefined : t;
    };
    let out = "";
    let i = 0;
    while (i < content.length) {
        if (content.startsWith("/*", i)) {
            const end = content.indexOf("*/", i + 2);
            const stop = end < 0 ? content.length : end + 2;
            out += content.slice(i, stop);
            i = stop;
            continue;
        }
        const candidates = [content.indexOf("{", i), content.indexOf("}", i), content.indexOf("/*", i)].filter(n => n >= 0);
        const next = candidates.length ? Math.min(...candidates) : content.length;
        let chunk = content.slice(i, next);
        if (content[next] === "{" && !chunk.trim().startsWith("@")) {
            const line = content.slice(0, i).split(/\r?\n/).length;
            chunk = chunk.replace(/\.([a-z][a-z0-9-]*)(?![\w-])/g, (all: string, cls: string) => {
                const t = lookup(cls);
                if (t == null)
                    return all;
                if (t.kind === "S" && options.apply.includes("S")) {
                    const target = t.classes.find(x => x === "sf-" + cls) ?? (t.classes.length === 1 ? t.classes[0] : undefined);
                    if (target) {
                        changed++;
                        return "." + target;
                    }
                }
                if (t.kind === "U" || t.kind === "X" || t.kind === "S")
                    reports.push({ line, text: all, reason: "outside-class-context" });
                return all;
            });
        }
        out += chunk;
        if (next < content.length && content[next] !== "/") {
            out += content[next];
            i = next + 1;
        } else
            i = next;
    }
    return { content: out, changed, reports };
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...walk(full));
        else if (/\.(tsx?|css)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
            out.push(full);
    }
    return out;
}

export function formatReport(results: FileReport[], root: string): string {
    const lines: string[] = [];
    const total = results.reduce((s, r) => s + r.changed, 0);
    lines.push(`# Class sweep report`, "", `${total} classes rewritten in ${results.filter(r => r.changed).length} files.`, "");
    const byReason = new Map<string, string[]>();
    for (const r of results)
        for (const rep of r.reports) {
            const list = byReason.get(rep.reason) ?? [];
            list.push(`- ${path.relative(root, r.file).replace(/\\/g, "/")}:${rep.line} \`${rep.text.replace(/`/g, "'")}\``);
            byReason.set(rep.reason, list);
        }
    for (const [reason, list] of byReason) {
        lines.push(`## ${reason} (${list.length})`, "", ...list, "");
    }
    return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const option = (name: string): string | undefined => {
        const i = args.indexOf(name);
        if (i < 0)
            return undefined;
        const [value] = args.splice(i, 2).slice(1);
        return value;
    };
    const write = args.includes("--write");
    if (write)
        args.splice(args.indexOf("--write"), 1);
    const apply = (option("--apply") ?? "U,X").split(",") as Kind[];
    const skip = option("--skip")?.split(",") ?? [];
    const only = option("--only")?.split(",");
    const reportPath = option("--report");

    const map = ClassMap.load(CLASS_MAP_PATH);
    for (const p of map.problems)
        console.error("map: " + p);

    const results = sweepTree(args, map, { apply, skipSections: skip, onlySections: only }, write);
    const report = formatReport(results, process.cwd());
    if (reportPath)
        fs.writeFileSync(reportPath, report);
    console.log(report.split("\n").slice(0, 3).join("\n"));
    for (const [reason, n] of [...results.flatMap(r => r.reports).reduce((m, r) => m.set(r.reason, (m.get(r.reason) ?? 0) + 1), new Map<string, number>())])
        console.log(`  ${reason}: ${n}`);
}
