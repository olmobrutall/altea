import * as fs from "node:fs";
import * as path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * The parsed `Modules.xml` — an application's list of optional modules and exactly how to remove each.
 *
 * The grammar is Signum's, plus two altea directives for a pnpm workspace and the `optional` attribute.
 * The FILE documents itself; this is only the reader.
 */

export type Directive =
    | { kind: "RemoveFiles"; path: string; dependsOn?: string }
    | { kind: "RemoveLine"; path: string; line?: string; from?: string; to?: string; dependsOn?: string }
    | { kind: "RemoveSpanInLines"; path: string; span: string; dependsOn?: string }
    | { kind: "ReplaceSpanInLines"; path: string; span: string; with: string; dependsOn?: string }
    | { kind: "RemovePackageReference"; name: string; dependsOn?: string }
    | { kind: "RemoveTsProjectReference"; path: string; reference: string; dependsOn?: string };

export interface Module {
    name: string;
    /** Removing any of these also removes this module. */
    dependsOn: string[];
    /** NOT selected by default: a fresh clone removes it unless the developer ticks it back on. */
    optional: boolean;
    directives: Directive[];
}

export interface ModulesFile {
    /** Absolute path of the Modules.xml itself. */
    filePath: string;
    /** The repository root every directive path is relative to. */
    rootFolder: string;
    modules: Module[];
}

export namespace ModulesXml {

    export function read(filePath: string, rootFolder: string): ModulesFile {
        const xml = fs.readFileSync(filePath, "utf8");

        const valid = XMLValidator.validate(xml);
        if (valid !== true)
            throw new Error(`${filePath} is not well-formed: ${JSON.stringify(valid)}`);

        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@",
            // Every element except the four containers is a repeatable directive.
            isArray: (name, _jpath, _leaf, isAttribute) =>
                !isAttribute && !["File", "Modules", "Projects", "Workspaces"].includes(name),
        });

        const doc = parser.parse(xml) as { File?: { Modules?: { Module?: RawModule[] } } };
        const raw = doc.File?.Modules?.Module ?? [];

        const modules = raw.map(readModule);

        // A name is the only handle the selector, DependsOn and --keep/--remove have on a module, so a
        // repeated one is ambiguous everywhere rather than merely redundant.
        const duplicate = modules.find((m, i) => modules.findIndex(o => o.name === m.name) !== i);
        if (duplicate != undefined)
            throw new Error(`Module '${duplicate.name}' is declared more than once.`);

        const names = new Set(modules.map(m => m.name));
        for (const m of modules)
            for (const d of m.dependsOn)
                if (!names.has(d))
                    throw new Error(`Module '${m.name}' DependsOn '${d}', which does not exist.`);

        return { filePath, rootFolder, modules };
    }

    /** Find the application's Modules.xml — `<root>/<app>/Modules.xml`. */
    export function locate(rootFolder: string, applicationName: string): string | undefined {
        const candidate = path.join(rootFolder, applicationName, "Modules.xml");
        return fs.existsSync(candidate) ? candidate : undefined;
    }

    /**
     * Close a set of modules-to-remove under DependsOn: removing a module removes everything that
     * depends on it, transitively. Returns the closure, in the file's own order.
     */
    export function closeRemoval(modules: Module[], removing: Set<string>): Set<string> {
        const result = new Set(removing);
        for (; ;) {
            const before = result.size;
            for (const m of modules)
                if (!result.has(m.name) && m.dependsOn.some(d => result.has(d)))
                    result.add(m.name);
            if (result.size === before)
                return result;
        }
    }
}

interface RawModule {
    "@Name": string;
    "@DependsOn"?: string;
    "@optional"?: string;
    [element: string]: unknown;
}

function readModule(raw: RawModule): Module {
    const name = raw["@Name"];
    if (name == undefined)
        throw new Error("A <Module> has no Name.");

    const directives: Directive[] = [];
    for (const [kind, value] of Object.entries(raw)) {
        if (kind.startsWith("@") || !Array.isArray(value))
            continue;

        for (const d of value as Record<string, string>[])
            directives.push(readDirective(name, kind, d));
    }

    return {
        name,
        dependsOn: splitList(raw["@DependsOn"]),
        optional: raw["@optional"] === "true",
        directives,
    };
}

function readDirective(module: string, kind: string, d: Record<string, string>): Directive {
    const dependsOn = d["@DependsOn"];
    const need = (attribute: string): string => {
        const v = d["@" + attribute];
        if (v == undefined)
            throw new Error(`[${module}] <${kind}> has no ${attribute}.`);
        return v;
    };

    switch (kind) {
        case "RemoveFiles":
            return { kind, path: need("Path"), dependsOn };

        case "RemoveLine": {
            const line = d["@Line"], from = d["@From"], to = d["@To"];
            if (line == undefined && (from == undefined || to == undefined))
                throw new Error(`[${module}] <RemoveLine> needs either Line, or both From and To.`);
            return { kind, path: need("Path"), line, from, to, dependsOn };
        }

        case "RemoveSpanInLines":
            return { kind, path: need("Path"), span: need("Span"), dependsOn };

        case "ReplaceSpanInLines":
            return { kind, path: need("Path"), span: need("Span"), with: need("With"), dependsOn };

        case "RemovePackageReference":
            return { kind, name: need("Name"), dependsOn };

        case "RemoveTsProjectReference":
            return { kind, path: need("Path"), reference: need("Reference"), dependsOn };

        default:
            throw new Error(`[${module}] unknown directive <${kind}>.`);
    }
}

function splitList(value: string | undefined): string[] {
    return (value ?? "").split(",").map(v => v.trim()).filter(v => v !== "");
}
