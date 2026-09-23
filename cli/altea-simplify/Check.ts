import * as fs from "node:fs";
import * as path from "node:path";
import { Color, Console } from "@altea/altea-cli-utils";
import type { Directive, ModulesFile } from "./ModulesXml.js";

/**
 * Validate a `Modules.xml` against the sources it describes, WITHOUT changing anything.
 *
 * It removes lines and spans by TEXT, so it rots silently: rename a module's start call, drop a
 * `//<Name>` anchor, move a file, and the tool produces something that does not compile — with no error
 * until someone actually unticks that module. This is the cheap check, and it belongs beside the
 * executor: one parser, one set of rules, no chance of the validator passing what the executor then
 * mis-reads.
 */
export namespace Check {

    /**
     * A span longer than this almost always means the `From` anchor matched something generic far above
     * what was intended. The number is a heuristic, and it earned its place: the Tour block first came out
     * at 88 lines because `// Not in Southwind — see legacyMode.` appears six times.
     */
    const MAX_SPAN_LINES = 60;

    export function run(file: ModulesFile): boolean {
        const problems: string[] = [];
        const report = (module: string, message: string): void => { problems.push(`[${module}] ${message}`); };

        const names = new Set(file.modules.map(m => m.name));
        const cache = new Map<string, string[] | undefined>();

        const readLines = (relative: string): string[] | undefined => {
            if (!cache.has(relative)) {
                const full = path.join(file.rootFolder, relative);
                cache.set(relative, fs.existsSync(full) && fs.statSync(full).isFile()
                    ? fs.readFileSync(full, "utf8").split(/\r?\n/)
                    : undefined);
            }
            return cache.get(relative);
        };

        for (const module of file.modules) {
            for (const dep of module.dependsOn)
                if (!names.has(dep))
                    report(module.name, `DependsOn names no such module: ${dep}`);

            for (const directive of module.directives)
                checkDirective(module.name, directive, file.rootFolder, names, readLines, report);
        }

        if (problems.length > 0) {
            for (const p of problems)
                Console.writeLineColor(Color.red, p);
            Console.writeLineColor(Color.red,
                `\n${file.filePath}: ${problems.length} problem(s) over ${file.modules.length} modules.`);
            return false;
        }

        Console.writeLineColor(Color.green,
            `${file.filePath}: OK — ${file.modules.length} modules, every anchor resolves.`);
        return true;
    }

    function checkDirective(module: string, d: Directive, rootFolder: string, names: Set<string>,
        readLines: (relative: string) => string[] | undefined,
        report: (module: string, message: string) => void): void {

        if (d.dependsOn != undefined && !names.has(d.dependsOn))
            report(module, `<${d.kind}> DependsOn names no such module: ${d.dependsOn}`);

        if (d.kind === "RemovePackageReference")
            return;

        if (d.kind === "RemoveFiles") {
            if (!fs.existsSync(path.join(rootFolder, d.path)))
                report(module, `<RemoveFiles> path does not exist: ${d.path}`);
            return;
        }

        const lines = readLines(d.path);
        if (lines == undefined) {
            report(module, `<${d.kind}> file does not exist: ${d.path}`);
            return;
        }

        if (d.kind === "RemoveTsProjectReference") {
            if (!lines.some(l => l.includes(`"${d.reference}"`)))
                report(module, `${d.path}: no reference to ${d.reference}`);
            return;
        }

        if (d.kind === "RemoveSpanInLines" || d.kind === "ReplaceSpanInLines") {
            if (!lines.some(l => l.includes(d.span)))
                report(module, `${d.path}: no line contains Span=${JSON.stringify(d.span)}`);
            return;
        }

        // RemoveLine, in its three forms.
        if (d.contains != undefined) {
            if (!lines.some(l => l.includes(d.contains!)))
                report(module, `${d.path}: no line contains Contains=${JSON.stringify(d.contains)}`);
            return;
        }

        if (d.line != undefined) {
            if (!lines.some(l => l.includes(d.line!)))
                report(module, `${d.path}: no line contains Line=${JSON.stringify(d.line)}`);
            else if (!lines.some(l => l.trim() === d.line!.trim()))
                report(module, `${d.path}: Line= matches only part of a line `
                    + `(RemoveLine is whole-line): ${JSON.stringify(d.line)}`);
            return;
        }

        const from = d.from!, to = d.to!;

        for (const [attribute, needle] of [["From", from], ["To", to]] as const)
            if (!lines.some(l => l.includes(needle)))
                report(module, `${d.path}: no line contains ${attribute}=${JSON.stringify(needle)}`);

        // A From= that matches SEVERAL lines silently anchors on the FIRST one, which is how a two-line
        // `if (!legacyMode)` anchor once swallowed an unrelated block above it.
        const matches = lines.filter(l => l.includes(from)).length;
        if (matches > 1)
            report(module, `${d.path}: From= matches ${matches} lines — the anchor is ambiguous: `
                + JSON.stringify(from));

        const start = lines.findIndex(l => l.includes(from));
        if (start < 0)
            return;

        const end = lines.findIndex((l, i) => i >= start && l.includes(to));
        if (end < 0)
            report(module, `${d.path}: To= never occurs at or after From=: ${JSON.stringify(to)}`);
        else if (end - start + 1 > MAX_SPAN_LINES)
            report(module, `${d.path}: span From=${JSON.stringify(from)} is ${end - start + 1} lines — `
                + "the anchor is probably too generic");
    }
}
