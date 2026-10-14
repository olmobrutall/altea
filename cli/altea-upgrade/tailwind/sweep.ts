#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ClassMap, type Kind } from "./ClassMap.js";
import { sweepSource, type SweepReport } from "./ClassSweep.js";

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

export function sweepTree(dirs: string[], map: ClassMap, apply: Kind[], skipSections: string[], write: boolean): FileReport[] {
    const results: FileReport[] = [];
    for (const file of dirs.flatMap(d => walk(d))) {
        const content = fs.readFileSync(file, "utf8");
        if (file.endsWith(".css")) {
            const reports = cssSelectors(content, map, skipSections);
            if (reports.length)
                results.push({ file, changed: 0, reports });
            continue;
        }
        const r = sweepSource(file, content, map, { apply, skipSections });
        if (write && r.content !== content)
            fs.writeFileSync(file, r.content);
        if (r.changed || r.reports.length)
            results.push({ file, changed: r.changed, reports: r.reports });
    }
    return results;
}

/** A stylesheet selecting a Bootstrap class the sweep renames would silently stop matching. */
function cssSelectors(content: string, map: ClassMap, skipSections: string[]): SweepReport[] {
    const reports: SweepReport[] = [];
    content.split(/\r?\n/).forEach((line, i) => {
        if (line.includes("{") || line.trim().endsWith(",")) {
            for (const m of line.matchAll(/\.([a-z][a-z0-9-]*)/g)) {
                const t = map.translate(m[1]);
                if (t && !skipSections.includes(t.section) && (t.kind === "U" || t.kind === "X"))
                    reports.push({ line: i + 1, text: "." + m[1], reason: "outside-class-context" });
            }
        }
    });
    return reports;
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
    const reportPath = option("--report");

    const map = ClassMap.load(CLASS_MAP_PATH);
    for (const p of map.problems)
        console.error("map: " + p);

    const results = sweepTree(args, map, apply, skip, write);
    const report = formatReport(results, process.cwd());
    if (reportPath)
        fs.writeFileSync(reportPath, report);
    console.log(report.split("\n").slice(0, 3).join("\n"));
    for (const [reason, n] of [...results.flatMap(r => r.reports).reduce((m, r) => m.set(r.reason, (m.get(r.reason) ?? 0) + 1), new Map<string, number>())])
        console.log(`  ${reason}: ${n}`);
}
