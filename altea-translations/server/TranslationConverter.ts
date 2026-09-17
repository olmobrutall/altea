import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SafeConsole } from "@altea/altea/server/safeConsole";

/**
 * Convert another framework's translation files into this one's — Signum's `SynchronizeTypes` with its
 * interactive prompt replaced by two data files, which is what makes a port repeatable and reviewable.
 *
 * Everything the conversion needs is DATA: which file becomes which file, and which type name becomes
 * which type name. An application contributes those two files and one call; no code of its own.
 *
 * It runs with no schema and no database — this is a file-to-file tool, not a piece of the module, which
 * is why it is a sibling of TranslationLogic rather than part of it.
 */
export namespace TranslationConverter {

    // ---- The two data files ----------------------------------------------------------------------------

    /**
     * `Old -> New` per line, `#` comments and blank lines ignored.
     *
     * A key MAY REPEAT, and then the type's whole snippet is emitted once per target:
     *
     *     QueryColumnEmbedded -> UserQueryEntity_Column
     *     QueryColumnEmbedded -> UserChartEntity_Column
     *
     * because altea routinely splits one of Signum's shared embeddeds into a row entity per owner, and
     * each is described under its own name. That deliberately writes more than the receiving package
     * declares; the first synchronization drops the rest, since `exportXml` only ever writes what the
     * process has. Over-writing and letting the sync simplify is the cheap direction to be wrong in —
     * the expensive one is a translation that silently never lands.
     */
    export function parseRenames(text: string): Map<string, string[]> {
        const result = new Map<string, string[]>();
        for (const { key, value } of parseArrowFile(text)) {
            const list = result.get(key);
            if (list == undefined) result.set(key, [value]);
            else list.push(value);
        }
        return result;
    }

    /** One source file and the one file it becomes, plus the roots and cultures the batch runs over. */
    export interface FileMap {
        sourceRoot: string;
        targetRoot: string;
        cultures: string[];
        /** Path bases WITHOUT the `.<culture>.xml` suffix, relative to their root. */
        pairs: { source: string; target: string }[];
    }

    /**
     * The file map, whose paths resolve against its OWN directory so the file is self-describing:
     *
     *     source-root ../../old
     *     target-root ../..
     *     cultures de es
     *     Framework/Extensions/Signum.Alerts/Translations/Signum.Alerts -> altea/altea-alert/translations/Altea.Alerts
     *
     * ONE SOURCE, ONE TARGET. A Signum assembly becomes exactly one altea package, and a type is
     * translated in the assembly that DECLARES it — `ActiveDirectoryMessage` lives in
     * Signum.Authorization.BaseAD.ts, so its strings come from Signum.Authorization and not from the stale
     * copy in Signum.Authorization.WindowsAD. Where altea split one type in two, the RENAMES duplicate the
     * snippet inside that one target; a target is never fed from two sources.
     */
    export function parseFileMap(text: string, mapPath: string): FileMap {
        const dir = dirname(resolve(mapPath));
        const against = (p: string): string => isAbsolute(p) ? p : resolve(dir, p);

        let sourceRoot = dir, targetRoot = dir, cultures: string[] = [];
        const pairs: { source: string; target: string }[] = [];
        for (const entry of parseArrowFile(text, ["source-root", "target-root", "cultures"])) {
            switch (entry.directive) {
                case "source-root": sourceRoot = against(entry.value); break;
                case "target-root": targetRoot = against(entry.value); break;
                case "cultures": cultures = entry.value.split(/\s+/).filter(Boolean); break;
                default: pairs.push({ source: entry.key, target: entry.value });
            }
        }
        if (cultures.length === 0)
            throw new Error(`No 'cultures' line in the file map '${mapPath}'`);
        return { sourceRoot, targetRoot, cultures, pairs };
    }

    /** Shared line reader: `<directive> <value>` for the known directives, else `<key> -> <value>`. */
    function* parseArrowFile(text: string, directives: string[] = []):
        Generator<{ directive?: string; key: string; value: string }> {
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.replace(/#.*$/, "").trim();
            if (line === "")
                continue;
            const directive = directives.find(d => line === d || line.startsWith(d + " "));
            if (directive != undefined) {
                yield { directive, key: directive, value: line.slice(directive.length).trim() };
                continue;
            }
            const m = /^(\S+)\s*->\s*(\S+)$/.exec(line);
            if (m == undefined)
                throw new Error(`Not a '<key> -> <value>' line: '${raw.trim()}'`);
            yield { key: m[1], value: m[2] };
        }
    }

    // ---- The conversion --------------------------------------------------------------------------------

    export interface ConvertResult {
        /** `<Type>` snippets read from the source. */
        read: number;
        /** …of those, how many had a rename. */
        renamed: number;
        /** Extra copies emitted because a key appears more than once. */
        duplicated: number;
        /** Source type names with no rename, copied through unchanged. */
        unmapped: string[];
    }

    /**
     * Copy one translation file to another, renaming the TYPES on the way. The TARGET IS OVERWRITTEN.
     *
     * Deliberately a TEXT copy, not a parse-and-rebuild: everything the renames do not name comes out byte
     * for byte, so a converted file still diffs cleanly against the one it came from. A name with no entry
     * is copied through unchanged — the common case, since most types kept their name — and the result
     * lists those so the operator can see what the dictionary still owes.
     */
    export function convertFile(sourceFile: string, targetFile: string, renames: Map<string, string[]>): ConvertResult {
        const result: ConvertResult = { read: 0, renamed: 0, duplicated: 0, unmapped: [] };

        // Each `<Type …/>` or `<Type …>…</Type>` on its own line, with its indentation, so a duplicate
        // lands in the same column as the original.
        const converted = readFileSync(sourceFile, "utf8").replace(
            /^([ \t]*)(<Type\s[^>]*?(?:\/>|>[\s\S]*?<\/Type>))/gm,
            (whole, indent: string, block: string) => {
                const name = /^<Type\s[^>]*?\bName="([^"]*)"/.exec(block)?.[1];
                if (name == undefined)
                    return whole;

                result.read++;
                const targets = renames.get(name);
                if (targets == undefined) {
                    result.unmapped.push(name);
                    return whole;
                }

                result.renamed++;
                result.duplicated += targets.length - 1;
                return targets
                    .map(t => indent + block.replace(/^(<Type\s[^>]*?\bName=")[^"]*(")/, `$1${t}$2`))
                    .join("\n");
            });

        mkdirSync(dirname(targetFile), { recursive: true });
        writeFileSync(targetFile, converted, "utf8");
        result.unmapped = [...new Set(result.unmapped)].sort();
        return result;
    }

    // ---- The batch, and the console ---------------------------------------------------------------------

    export interface RunOptions {
        /** Overwrite without asking. Required when nothing is attached to answer. */
        yes?: boolean;
    }

    /**
     * Convert every pair in the file map that the source side actually has.
     *
     * Each target is OVERWRITTEN and may hold strings this source does not carry, so an existing one is
     * confirmed first — and refused rather than guessed when there is no terminal to ask.
     */
    export async function convertAll(fileMapPath: string, renamesPath: string, options: RunOptions = {}): Promise<void> {
        const map = parseFileMap(readFileSync(fileMapPath, "utf8"), fileMapPath);
        const renames = parseRenames(readFileSync(renamesPath, "utf8"));

        SafeConsole.writeLine(`[translation-convert] files:   ${resolve(fileMapPath)}`);
        SafeConsole.writeLine(`                     renames: ${resolve(renamesPath)} (${renames.size} keys)`);

        let written = 0, skipped = 0, missing = 0;
        for (const pair of map.pairs)
            for (const culture of map.cultures) {
                const source = join(map.sourceRoot, `${pair.source}.${culture}.xml`);
                if (!existsSync(source)) { missing++; continue; }   // the source side does not translate this one
                const target = join(map.targetRoot, `${pair.target}.${culture}.xml`);
                if (await convertOne(source, target, renames, options)) written++;
                else skipped++;
            }

        SafeConsole.writeLine();
        SafeConsole.writeLine(`[translation-convert] ${written} written, ${skipped} skipped`
            + `, ${missing} with no source file`);
    }

    /** One pair, with the overwrite confirmation. Returns whether the file was written. */
    export async function convertOne(
        source: string, target: string, renames: Map<string, string[]>, options: RunOptions = {},
    ): Promise<boolean> {
        if (existsSync(target) && options.yes !== true) {
            if (!SafeConsole.isInteractive()) {
                SafeConsole.writeLine(`  SKIPPED (would overwrite, no terminal to ask — pass --yes): ${target}`);
                return false;
            }
            if (!await SafeConsole.ask(`Overwrite ${target}?`)) {
                SafeConsole.writeLine("  skipped");
                return false;
            }
        }

        const r = convertFile(source, target, renames);
        SafeConsole.writeLine(`  ${source}`);
        SafeConsole.writeLine(`  -> ${target}`);
        SafeConsole.writeLine(`     ${r.read} types read, ${r.renamed} renamed, ${r.duplicated} duplicated`
            + (r.unmapped.length > 0 ? `, ${r.unmapped.length} unchanged` : ""));
        return true;
    }

    /**
     * The whole terminal command — argument parsing, both modes and the console output — so an application
     * contributes its two data files and this one call.
     *
     *   <cmd>                      convert every pair in the file map
     *   <cmd> --yes                …without asking before each overwrite
     *   <cmd> <source> <target>    convert one pair, ignoring the file map
     */
    export async function runCommand(args: string[], fileMapPath: string, renamesPath: string): Promise<void> {
        const options: RunOptions = { yes: args.includes("--yes") };
        const positional = args.filter(a => !a.startsWith("--"));

        if (positional.length === 0) {
            await convertAll(fileMapPath, renamesPath, options);
            return;
        }
        if (positional.length !== 2) {
            SafeConsole.writeLine("Usage: <cmd> [--yes]                  — every pair in the file map");
            SafeConsole.writeLine("       <cmd> <source.xml> <target.xml> [--yes]");
            return;
        }

        const renames = parseRenames(readFileSync(renamesPath, "utf8"));
        await convertOne(resolve(positional[0]), resolve(positional[1]), renames, options);
    }
}
