import * as fs from "node:fs";
import * as path from "node:path";
import { type ApplicationContext, type Choice, Color, Console, Git, Prompt } from "@altea/altea-cli-utils";
import { ModulesXml, type Directive, type Module, type ModulesFile } from "./ModulesXml.js";

/**
 * Remove optional modules from an application, following its `Modules.xml`.
 *
 * Signum has no counterpart: its `Modules.xml` is read by the wizard that stamps out a new Southwind, and
 * that wizard is not in the repository. This is that executor.
 *
 * **The selection is what to KEEP.** Every module starts ticked except those marked `optional="true"`,
 * and unticking one removes it. That is the only direction consistent with `optional` meaning "a fresh
 * clone drops this": the `port` module is unticked, so a plain confirm removes it and keeps everything
 * else.
 *
 * **A commit per module.** The directives of one module are applied together and committed as
 * `Remove module <Name>`, so each removal can be reviewed — or reverted — on its own. A dirty tree is
 * refused first, which is what makes that true.
 */
export namespace Simplify {

    export interface Options {
        /** Modules to KEEP, by name. Anything else is removed. Skips the interactive selector. */
        keep?: string[];
        /** Modules to REMOVE, by name, on top of the optional ones. Skips the interactive selector. */
        remove?: string[];
        /** Print what would happen and change nothing. */
        dryRun?: boolean;
        /** Apply everything in ONE commit instead of one per module. */
        singleCommit?: boolean;
        /** Skip the confirmation — for a scripted run, where there is nobody to answer it. */
        yes?: boolean;
    }

    export async function run(uctx: ApplicationContext, options: Options = {}): Promise<void> {
        const filePath = ModulesXml.locate(uctx.rootFolder, uctx.applicationName);
        if (filePath == undefined)
            throw new Error(`No Modules.xml in ${uctx.applicationName}/ — nothing to simplify.`);

        const file = ModulesXml.read(filePath, uctx.rootFolder);

        const removing = options.keep != undefined || options.remove != undefined
            ? fromArguments(file, options)
            : await askInteractively(file, options.yes === true);

        if (removing == undefined) {
            Console.writeLineColor(Color.yellow, "Cancelled — nothing was changed.");
            return;
        }

        const modules = file.modules.filter(m => removing.has(m.name));
        if (modules.length === 0) {
            Console.writeLineColor(Color.green, "Nothing to remove.");
            return;
        }

        Console.writeLine();
        Console.banner(`Removing ${modules.length} module(s)`);
        for (const m of modules)
            Console.writeLineColor(Color.yellow, "  " + m.name);
        Console.writeLine();

        if (options.dryRun !== true) {
            if (!Git.isRepository(uctx.rootFolder))
                throw new Error(`${uctx.rootFolder} is not a git repository. `
                    + "Simplify edits and deletes source in place; git is what makes that reviewable.");

            await Git.waitForCleanTree(uctx.rootFolder);

            if (options.yes !== true && !await Console.ask("Apply?"))
                return;
        }

        for (const module of modules) {
            Console.writeLine();
            Console.writeLineColor(Color.cyan, `-- ${module.name}`);

            applyModule(file, module, removing, options.dryRun === true);

            if (options.dryRun !== true && options.singleCommit !== true) {
                if (Git.commitAll(uctx.rootFolder, `Remove module ${module.name}`))
                    Console.writeLineColor(Color.white, `   committed 'Remove module ${module.name}'`);
                else
                    Console.writeLineColor(Color.darkGray, "   nothing to commit");
            }
        }

        if (options.dryRun !== true && options.singleCommit === true) {
            const message = `Remove modules: ${modules.map(m => m.name).join(", ")}`;
            if (Git.commitAll(uctx.rootFolder, message))
                Console.writeLineColor(Color.white, `Committed '${message}'`);
        }

        Console.writeLine();
        Console.writeLineColor(options.dryRun === true ? Color.yellow : Color.green,
            options.dryRun === true
                ? "Dry run — nothing was changed."
                : "Done. Run `pnpm install` and build before committing anything else.");
    }

    // ---- choosing ----------------------------------------------------------------------------------

    async function askInteractively(file: ModulesFile, yes: boolean): Promise<Set<string> | undefined> {
        const choices: Choice<Module>[] = file.modules.map(m => ({
            key: m.name,
            description: m.dependsOn.length > 0 ? `needs ${m.dependsOn.join(", ")}` : "",
            value: m,
            selected: !m.optional,
        }));

        Console.writeLine();
        Console.writeLineColor(Color.darkGray,
            "  Tick a module to KEEP it. Unticked modules are REMOVED from the source, one commit each.");
        Console.writeLineColor(Color.darkGray,
            "  Removing a module also removes everything that depends on it.");

        const kept = await Prompt.multiSelect("Modules to keep", choices);
        if (kept == undefined)
            return undefined;

        const keptNames = new Set(kept.map(m => m.name));
        const removing = ModulesXml.closeRemoval(file.modules,
            new Set(file.modules.filter(m => !keptNames.has(m.name)).map(m => m.name)));

        // Show what the DependsOn closure added, so a surprise removal is never silent.
        const cascaded = [...removing].filter(n => keptNames.has(n));
        if (cascaded.length > 0) {
            Console.writeLine();
            Console.writeLineColor(Color.yellow,
                `  Also removing (they depend on something you removed): ${cascaded.join(", ")}`);
            if (!yes && !await Console.ask("  Continue?"))
                return undefined;
        }

        return removing;
    }

    function fromArguments(file: ModulesFile, options: Options): Set<string> {
        const names = new Set(file.modules.map(m => m.name));
        const check = (list: string[], what: string): string[] => {
            for (const n of list)
                if (!names.has(n))
                    throw new Error(`--${what} names '${n}', which is not a module in Modules.xml. `
                        + `Valid: ${[...names].join(", ")}`);
            return list;
        };

        const removing = new Set<string>();

        if (options.keep != undefined) {
            const keep = new Set(check(options.keep, "keep"));
            for (const m of file.modules)
                if (!keep.has(m.name))
                    removing.add(m.name);
        } else {
            // No --keep: start from the modules a fresh clone drops anyway.
            for (const m of file.modules)
                if (m.optional)
                    removing.add(m.name);
        }

        for (const n of check(options.remove ?? [], "remove"))
            removing.add(n);

        return ModulesXml.closeRemoval(file.modules, removing);
    }

    // ---- applying ----------------------------------------------------------------------------------

    function applyModule(file: ModulesFile, module: Module, removing: Set<string>, dryRun: boolean): void {
        for (const d of module.directives) {
            // A directive with its own DependsOn exists only because two modules meet: apply it when its
            // OWN module is removed (always true here) or when the named one is.
            if (d.dependsOn != undefined && !removing.has(d.dependsOn) && !removing.has(module.name))
                continue;

            try {
                applyDirective(file, d, dryRun);
            } catch (e) {
                Console.writeLineColor(Color.red, `   ${(e as Error).message}`);
            }
        }
    }

    function applyDirective(file: ModulesFile, d: Directive, dryRun: boolean): void {
        switch (d.kind) {
            case "RemoveFiles": return removeFiles(file, d.path, dryRun);
            case "RemoveLine": return removeLine(file, d, dryRun);
            case "RemoveSpanInLines": return replaceSpan(file, d.path, d.span, "", dryRun);
            case "ReplaceSpanInLines": return replaceSpan(file, d.path, d.span, d.with, dryRun);
            case "RemovePackageReference": return removePackageReference(file, d.name, dryRun);
            case "RemoveTsProjectReference": return removeTsProjectReference(file, d.path, d.reference, dryRun);
        }
    }

    function removeFiles(file: ModulesFile, relative: string, dryRun: boolean): void {
        const full = path.join(file.rootFolder, relative);
        if (!fs.existsSync(full)) {
            Console.writeLineColor(Color.darkGray, `   (already gone) ${relative}`);
            return;
        }

        const isDirectory = fs.statSync(full).isDirectory();
        Console.writeLineColor(Color.yellow, `   delete ${isDirectory ? "directory " : ""}${relative}`);
        if (!dryRun)
            fs.rmSync(full, { recursive: true, force: true });
    }

    function removeLine(file: ModulesFile, d: Extract<Directive, { kind: "RemoveLine" }>, dryRun: boolean): void {
        edit(file, d.path, dryRun, lines => {
            if (d.line != undefined) {
                const wanted = d.line.trim();
                const before = lines.length;
                for (let i = lines.length - 1; i >= 0; i--)
                    if (lines[i].trim() === wanted)
                        lines.splice(i, 1);

                if (before === lines.length)
                    return { changed: false, note: `no line equals ${JSON.stringify(d.line)}` };

                repairTrailingComma(d.path, lines);
                return { changed: true, note: `removed ${before - lines.length} line(s) ${JSON.stringify(d.line)}` };
            }

            const start = lines.findIndex(l => l.includes(d.from!));
            if (start < 0)
                return { changed: false, note: `no line contains From=${JSON.stringify(d.from)}` };

            const end = lines.findIndex((l, i) => i >= start && l.includes(d.to!));
            if (end < 0)
                return { changed: false, note: `no line contains To=${JSON.stringify(d.to)} at or after From` };

            lines.splice(start, end - start + 1);
            repairTrailingComma(d.path, lines);
            return { changed: true, note: `removed ${end - start + 1} line(s) ${JSON.stringify(d.from)}…` };
        });
    }

    /**
     * JSON has no trailing commas, so removing the LAST entry of an object or array leaves the one above it
     * ending in a comma and the file unparseable — which `pnpm install` reports long after the run, as a
     * syntax error in a file nobody edited by hand. `RemovePackageReference` has always repaired its own;
     * a plain `RemoveLine` over package.json or a tsconfig (a script, a reference) can land in exactly the
     * same place, so it repairs too. Only for `.json`: a trailing comma is legal everywhere else.
     */
    function repairTrailingComma(relative: string, lines: string[]): void {
        if (!relative.toLowerCase().endsWith(".json"))
            return;

        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trimEnd().endsWith(","))
                continue;
            const next = lines.slice(i + 1).find(l => l.trim() !== "");
            if (next != undefined && (next.trim().startsWith("}") || next.trim().startsWith("]")))
                lines[i] = lines[i].trimEnd().replace(/,$/, "");
        }
    }

    /**
     * Substitute a SUBSTRING wherever it appears. `RemoveSpanInLines` is this with an empty replacement.
     *
     * Signum's grammar is removal-only, which is enough for C#: removing a module deletes whole calls.
     * altea's `legacyMode` is a runtime flag woven into option objects, so removing the module has to turn
     * `{ attachments: !legacyMode }` into `{ attachments: true }` — a deletion there leaves `{ attachments: }`.
     */
    function replaceSpan(file: ModulesFile, relative: string, span: string, replacement: string,
        dryRun: boolean): void {
        edit(file, relative, dryRun, lines => {
            let hits = 0;
            for (let i = 0; i < lines.length; i++)
                while (lines[i].includes(span)) { lines[i] = lines[i].replace(span, replacement); hits++; }

            const what = replacement === ""
                ? `removed ${hits} occurrence(s) of ${JSON.stringify(span)}`
                : `replaced ${hits} occurrence(s) of ${JSON.stringify(span)} with ${JSON.stringify(replacement)}`;

            return hits === 0
                ? { changed: false, note: `no line contains ${JSON.stringify(span)}` }
                : { changed: true, note: what };
        });
    }

    /**
     * Drop a dependency from the application's package.json (altea's `<RemoveProjectReference>`) — AND every
     * tsconfig PROJECT REFERENCE to it.
     *
     * The two always travel together: a reference exists because the dependency did. Leaving the references
     * behind is worse than useless, because TypeScript then still RESOLVES `@altea/<removed>`, so a leftover
     * import compiles cleanly — the build says the removal worked and the application fails at run time,
     * which is exactly what a removal must never be allowed to do. With the references gone, `tsc` names
     * every file the module forgot.
     */
    function removePackageReference(file: ModulesFile, name: string, dryRun: boolean): void {
        const application = path.basename(path.dirname(file.filePath));
        edit(file, `${application}/package.json`, dryRun, lines => {
            const i = lines.findIndex(l => new RegExp(`^\\s*"${escapeRegex(name)}"\\s*:`).test(l));
            if (i < 0)
                return { changed: false, note: `${name} is not a dependency` };

            // A JSON list cannot end in a comma: dropping the LAST entry means un-comma-ing the one before.
            const wasLast = !lines[i].trimEnd().endsWith(",");
            lines.splice(i, 1);
            if (wasLast && i > 0 && lines[i - 1].trimEnd().endsWith(","))
                lines[i - 1] = lines[i - 1].trimEnd().replace(/,$/, "");

            return { changed: true, note: `removed dependency ${name}` };
        });

        // `@altea/altea-auth` → any `"…/altea-auth/tsconfig.<layer>.json"`. What a reference path ends in is
        // the package's own FOLDER name, so that is what is matched, not the npm scope in front of it.
        const folder = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
        for (const tsconfig of tsconfigsOf(file, application))
            removeTsProjectReferencesTo(file, tsconfig, folder, dryRun);
    }

    /** The application's own `tsconfig*.json` files, relative to the root — the ones that carry references. */
    function tsconfigsOf(file: ModulesFile, application: string): string[] {
        const dir = path.join(file.rootFolder, application);
        if (!fs.existsSync(dir))
            return [];

        return fs.readdirSync(dir)
            .filter(n => /^tsconfig.*\.json$/.test(n))
            .map(n => `${application}/${n}`);
    }

    /** Every `{ "path": "…/<folder>/tsconfig.*.json" }` entry in one tsconfig. */
    function removeTsProjectReferencesTo(file: ModulesFile, relative: string, folder: string,
        dryRun: boolean): void {
        const full = path.join(file.rootFolder, relative);
        if (!fs.existsSync(full))
            return;

        const marker = new RegExp(`["/]${escapeRegex(folder)}/tsconfig[^"]*\\.json"`);
        // Silent when there is nothing to do: most of an application's tsconfigs never referenced this
        // package, and reporting that for every layer of every removed module is noise, not information.
        if (!marker.test(fs.readFileSync(full, "utf8")))
            return;

        edit(file, relative, dryRun, lines => {
            let removed = 0;
            for (let i = lines.length - 1; i >= 0; i--) {
                if (!marker.test(lines[i]) || !lines[i].includes("path"))
                    continue;

                const wasLast = !lines[i].trimEnd().endsWith(",");
                lines.splice(i, 1);
                if (wasLast && i > 0 && lines[i - 1].trimEnd().endsWith(","))
                    lines[i - 1] = lines[i - 1].trimEnd().replace(/,$/, "");
                removed++;
            }

            return removed === 0
                ? { changed: false, note: `no project reference to ${folder}` }
                : { changed: true, note: `removed ${removed} project reference(s) to ${folder}` };
        });
    }

    /** Drop a `{ "path": … }` entry from a tsconfig's `references`. */
    function removeTsProjectReference(file: ModulesFile, relative: string, reference: string, dryRun: boolean): void {
        edit(file, relative, dryRun, lines => {
            const i = lines.findIndex(l => l.includes(`"${reference}"`) && l.includes("path"));
            if (i < 0)
                return { changed: false, note: `no reference to ${reference}` };

            const wasLast = !lines[i].trimEnd().endsWith(",");
            lines.splice(i, 1);
            if (wasLast && i > 0 && lines[i - 1].trimEnd().endsWith(","))
                lines[i - 1] = lines[i - 1].trimEnd().replace(/,$/, "");

            return { changed: true, note: `removed project reference ${reference}` };
        });
    }

    /** Read, transform, report and (unless dry) write — preserving the file's newline style. */
    function edit(file: ModulesFile, relative: string, dryRun: boolean,
        transform: (lines: string[]) => { changed: boolean; note: string }): void {
        const full = path.join(file.rootFolder, relative);
        if (!fs.existsSync(full)) {
            Console.writeLineColor(Color.darkGray, `   (already gone) ${relative}`);
            return;
        }

        const text = fs.readFileSync(full, "utf8");
        const newline = text.includes("\r\n") ? "\r\n" : "\n";
        const lines = text.split(/\r?\n/);

        const { changed, note } = transform(lines);

        Console.writeLineColor(changed ? Color.yellow : Color.red, `   ${relative}: ${note}`);
        if (changed && !dryRun)
            fs.writeFileSync(full, lines.join(newline), "utf8");
    }
}

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
