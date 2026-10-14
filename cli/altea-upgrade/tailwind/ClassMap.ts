import * as fs from "node:fs";

/** What a Bootstrap class becomes. See Tailwind-ClassMap.md, "How to read it". */
export type Kind = "U" | "S" | "C" | "M" | "X";

export interface Translation {
    kind: Kind;
    /** The classes to write instead — empty for X, and for C / M (reported, not rewritten). */
    classes: string[];
    /** The `## ` section of the map the row is in. */
    section: string;
}

interface Colour { token: string; textToken: string; }

/**
 * Tailwind-ClassMap.md, read as data: every row expanded into exact Bootstrap classes, plus the
 * breakpoint rule that turns `d-md-none` into `md:hidden`.
 */
export class ClassMap {
    private readonly exact = new Map<string, Translation & { explicit: boolean }>();
    private readonly breakpoints = new Map<string, string>();
    readonly problems: string[] = [];

    static load(markdownPath: string): ClassMap {
        return new ClassMap(fs.readFileSync(markdownPath, "utf8"));
    }

    constructor(markdown: string) {
        const colours = new Map<string, Colour>();
        let section = "";

        for (const table of readTables(markdown)) {
            section = table.section;
            const header = table.header.map(stripTicks);

            if (header[0] === "Bootstrap {bp}") {
                for (const row of table.rows)
                    this.breakpoints.set(stripTicks(row[0]), stripTicks(row[1]).replace(/:$/, ""));
            } else if (header[0] === "Bootstrap colour") {
                for (const row of table.rows)
                    colours.set(stripTicks(row[0]), { token: stripTicks(row[1]), textToken: stripTicks(row[2]) });
            }
        }

        for (const table of readTables(markdown)) {
            if (table.header.join("|") !== "Bootstrap|Replacement|Kind|Notes")
                continue;
            for (const row of table.rows)
                this.addRow(row, table.section, colours);
        }
    }

    /** The translation of one class, applying the breakpoint rule when the class itself is not in the map. */
    translate(cls: string): Translation | undefined {
        const direct = this.exact.get(cls);
        if (direct)
            return direct;

        const parts = cls.split("-");
        for (let i = 1; i < parts.length; i++) {
            const variant = this.breakpoints.get(parts[i]);
            if (variant == null)
                continue;
            const base = this.exact.get([...parts.slice(0, i), ...parts.slice(i + 1)].join("-"));
            if (base)
                return { ...base, classes: base.classes.map(c => `${variant}:${c}`) };
        }
        return undefined;
    }

    get size(): number { return this.exact.size; }

    private addRow(row: string[], section: string, colours: Map<string, Colour>): void {
        const sources = items(row[0]);
        const targets = items(row[1]);
        const kinds = row[2].split("/").map(k => k.trim()) as Kind[];

        sources.forEach((source, i) => {
            if (source.includes("{bp}"))
                return;
            const target = targets.length === 1 ? targets[0] : targets[i];
            const kind = kinds.length === 1 ? kinds[0] : kinds[i];
            if (target == null || kind == null) {
                this.problems.push(`${section}: '${source}' has no replacement / kind at position ${i}`);
                return;
            }
            for (const [from, to] of expand(source, target, colours, msg => this.problems.push(`${section}: ${msg}`)))
                this.set(from, kind, to, section, !source.includes("{"));
        });
    }

    private set(from: string, kind: Kind, to: string, section: string, explicit: boolean): void {
        const existing = this.exact.get(from);
        if (existing && (existing.explicit || !explicit))
            return;
        const isClasses = kind === "U" || kind === "S" || kind === "X";
        const classes = !isClasses || to === "—" ? [] : to.split(/\s+/).filter(c => c.length > 0);
        this.exact.set(from, { kind, classes, section, explicit });
    }
}

interface Table { section: string; header: string[]; rows: string[][]; }

function readTables(markdown: string): Table[] {
    const tables: Table[] = [];
    let section = "";
    let current: Table | undefined;

    for (const line of markdown.split(/\r?\n/)) {
        const heading = /^## (.*)$/.exec(line);
        if (heading)
            section = heading[1].trim();

        if (!line.startsWith("|")) {
            current = undefined;
            continue;
        }
        const cells = splitRow(line);
        if (current == null) {
            current = { section, header: cells, rows: [] };
            tables.push(current);
        } else if (!cells.every(c => /^:?-+:?$/.test(c))) {
            current.rows.push(cells);
        }
    }
    return tables;
}

function splitRow(line: string): string[] {
    const cells: string[] = [];
    let cell = "", inTicks = false;
    for (const ch of line.trim().replace(/^\||\|$/g, "")) {
        if (ch === "`")
            inTicks = !inTicks;
        if (ch === "|" && !inTicks) {
            cells.push(cell.trim());
            cell = "";
        } else
            cell += ch;
    }
    cells.push(cell.trim());
    return cells;
}

function stripTicks(cell: string): string {
    return cell.replace(/`/g, "").trim();
}

/** The backticked items of a cell (`a` / `b`), a `<Component>`, or `—`. */
function items(cell: string): string[] {
    const parts: string[] = [];
    let part = "", inTicks = false;
    for (let i = 0; i < cell.length; i++) {
        const ch = cell[i];
        if (ch === "`")
            inTicks = !inTicks;
        if (!inTicks && cell.startsWith(" / ", i)) {
            parts.push(part);
            part = "";
            i += 2;
        } else
            part += ch;
    }
    parts.push(part);

    return parts.map(p => {
        const tick = /`([^`]+)`/.exec(p);
        if (tick)
            return tick[1];
        return p.trim().startsWith("—") ? "—" : p.trim();
    });
}

type Group = { kind: "list"; alternatives: string[] } | { kind: "colour"; column: "token" | "textToken" };

function parseGroups(pattern: string): { literals: string[]; groups: Group[] } {
    const literals: string[] = [];
    const groups: Group[] = [];
    let rest = pattern;
    for (let m = /\{([^}]*)\}/.exec(rest); m; m = /\{([^}]*)\}/.exec(rest)) {
        literals.push(rest.slice(0, m.index));
        groups.push(parseGroup(m[1]));
        rest = rest.slice(m.index + m[0].length);
    }
    literals.push(rest);
    return { literals, groups };
}

function parseGroup(body: string): Group {
    if (body === "colour" || body === "token")
        return { kind: "colour", column: "token" };
    if (body === "text-token")
        return { kind: "colour", column: "textToken" };
    const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
    if (range) {
        const alternatives: string[] = [];
        for (let i = Number(range[1]); i <= Number(range[2]); i++)
            alternatives.push(String(i));
        return { kind: "list", alternatives };
    }
    return { kind: "list", alternatives: body.split(",") };
}

/**
 * Expands a row's Bootstrap pattern and its replacement IN PARALLEL: the n-th list group of one pairs with
 * the n-th list group of the other; `{colour}` drives every `{token}` / `{text-token}` of the replacement.
 */
function expand(source: string, target: string, colours: Map<string, Colour>, problem: (m: string) => void): [string, string][] {
    const src = parseGroups(source);
    const dst = parseGroups(target);
    const srcLists = src.groups.filter(g => g.kind === "list") as { kind: "list"; alternatives: string[] }[];
    const dstLists = dst.groups.filter(g => g.kind === "list") as { kind: "list"; alternatives: string[] }[];
    const usesColour = src.groups.some(g => g.kind === "colour");

    if (dstLists.length > 0 && dstLists.length !== srcLists.length) {
        problem(`'${source}' → '${target}': ${srcLists.length} brace group(s) vs ${dstLists.length}`);
        return [];
    }
    for (let i = 0; i < dstLists.length; i++) {
        if (dstLists[i].alternatives.length !== srcLists[i].alternatives.length) {
            problem(`'${source}' → '${target}': group ${i + 1} has ${srcLists[i].alternatives.length} vs ${dstLists[i].alternatives.length} alternatives`);
            return [];
        }
    }

    const results: [string, string][] = [];
    const colourKeys = usesColour ? [...colours.keys()] : [undefined];
    const combos = cartesian(srcLists.map(l => l.alternatives.length));

    for (const colourKey of colourKeys) {
        const colour = colourKey ? colours.get(colourKey) : undefined;
        for (const combo of combos) {
            const fill = (parsed: ReturnType<typeof parseGroups>, isSource: boolean): string => {
                let out = parsed.literals[0], listIndex = 0;
                parsed.groups.forEach((g, gi) => {
                    if (g.kind === "colour")
                        out += isSource ? colourKey : colour ? colour[g.column] : `{${g.column === "token" ? "token" : "text-token"}}`;
                    else {
                        const alternatives = isSource ? srcLists[listIndex].alternatives : dstLists[listIndex].alternatives;
                        out += alternatives[combo[listIndex]];
                        listIndex++;
                    }
                    out += parsed.literals[gi + 1];
                });
                return out;
            };
            results.push([fill(src, true), fill(dst, false)]);
        }
    }
    return results;
}

function cartesian(lengths: number[]): number[][] {
    let combos: number[][] = [[]];
    for (const length of lengths)
        combos = combos.flatMap(c => Array.from({ length }, (_, i) => [...c, i]));
    return combos;
}
