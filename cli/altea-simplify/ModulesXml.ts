import * as fs from "node:fs";
import * as path from "node:path";
import { Xml, type XmlElement } from "./Xml.js";

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
        const root = Xml.parse(fs.readFileSync(filePath, "utf8"), filePath);

        if (root.name !== "File")
            throw new Error(`${filePath}: the root element is <${root.name}>, expected <File>.`);

        const container = root.children.find(c => c.name === "Modules");
        const modules = (container?.children ?? []).map(e => readModule(filePath, e));

        const names = new Set(modules.map(m => m.name));
        for (const m of modules)
            for (const d of m.dependsOn)
                if (!names.has(d))
                    throw new Error(`Module '${m.name}' DependsOn '${d}', which does not exist.`);

        const duplicated = modules.filter((m, i) => modules.findIndex(o => o.name === m.name) !== i);
        if (duplicated.length > 0)
            throw new Error(`Module(s) declared more than once: ${duplicated.map(m => m.name).join(", ")}`);

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

function readModule(filePath: string, element: XmlElement): Module {
    if (element.name !== "Module")
        throw new Error(`${filePath}:${element.line}: <${element.name}> inside <Modules>, expected <Module>.`);

    const name = element.attributes["Name"];
    if (name == undefined)
        throw new Error(`${filePath}:${element.line}: a <Module> has no Name.`);

    return {
        name,
        dependsOn: splitList(element.attributes["DependsOn"]),
        optional: element.attributes["optional"] === "true",
        directives: element.children.map(c => readDirective(name, c.name, c.attributes)),
    };
}

function readDirective(module: string, kind: string, d: Record<string, string>): Directive {
    const dependsOn = d["DependsOn"];
    const need = (attribute: string): string => {
        const v = d[attribute];
        if (v == undefined)
            throw new Error(`[${module}] <${kind}> has no ${attribute}.`);
        return v;
    };

    switch (kind) {
        case "RemoveFiles":
            return { kind, path: need("Path"), dependsOn };

        case "RemoveLine": {
            const line = d["Line"], from = d["From"], to = d["To"];
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
