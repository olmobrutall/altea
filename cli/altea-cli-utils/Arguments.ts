/**
 * `--name x` / `--name=x` / `--dry-run` / bare positionals. Shared by the three CLIs.
 *
 * No dependency for this much, and deliberately not `node:util`'s `parseArgs`: that one needs every
 * option DECLARED up front, which is more ceremony than three flags and two values are worth.
 */
export interface Arguments {
    flags: Set<string>;
    values: Map<string, string>;
    positional: string[];
}

export function parseArguments(argv: string[]): Arguments {
    const flags = new Set<string>();
    const values = new Map<string, string>();
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("-")) { positional.push(a); continue; }

        const name = a.replace(/^--?/, "");
        const eq = name.indexOf("=");
        if (eq >= 0) { values.set(name.slice(0, eq), name.slice(eq + 1)); continue; }

        const next = argv[i + 1];
        if (next != undefined && !next.startsWith("-")) { values.set(name, next); i++; }
        else flags.add(name);
    }

    return { flags, values, positional };
}
