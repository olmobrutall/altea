import * as readline from "node:readline";
import { Color, Console } from "./Console.js";

/** One row of a {@link multiSelect} list. */
export interface Choice<T> {
    key: string;
    description: string;
    value: T;
    /** Ticked when the list opens. */
    selected: boolean;
    /** Ticked and NOT unticked by the caller — shown as forced, e.g. a module something else depends on. */
    forced?: boolean;
    /**
     * Keys of the choices this one cannot be ticked without. Toggling follows them both ways: ticking this
     * ticks what it requires, and unticking a requirement unticks everything that requires it — so the list
     * on screen is always the selection that will actually be applied.
     */
    requires?: string[];
}

/**
 * The prompts this tool needs beyond `SafeConsole` — which covers yes/no, pick-one and free text, but
 * has no CHECKBOX list.
 *
 * A LINE-based selector rather than a cursor/arrow-key one: it works in every terminal, in a piped
 * session and in a CI log, and it prints the whole state after every toggle so what is about to happen
 * is legible rather than scrolled off. The same reason SafeConsole draws instead of taking over the
 * screen.
 */
export namespace Prompt {

    /**
     * Show a checkbox list and return the picked values. The user types the numbers or keys to TOGGLE
     * (comma or space separated, ranges with `-`), `all` / `none` to set everything, and empty to accept.
     */
    export async function multiSelect<T>(title: string, choices: Choice<T>[]): Promise<T[] | undefined> {
        if (!Console.isInteractive()) {
            Console.writeLineColor(Color.yellow,
                "Not an interactive console — using the default selection.");
            return choices.filter(c => c.selected).map(c => c.value);
        }

        // The defaults may already break a requirement (a ticked row needing an unticked one): settle that
        // before the first draw, so the opening list is honest too.
        for (const c of choices)
            if (!c.selected)
                cascade(choices, c);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        Console.handleSigInt(rl);
        try {
            for (; ;) {
                draw(title, choices);
                const line = (await question(rl,
                    "Toggle by number or name (comma separated, `a-f` ranges, `all`, `none`); Enter to accept: "))
                    .trim();

                if (line === "")
                    return choices.filter(c => c.selected).map(c => c.value);

                if (line.toLowerCase() === "q" || line.toLowerCase() === "quit")
                    return undefined;

                applyToggles(choices, line);
            }
        } finally {
            rl.close();
        }
    }

    function draw<T>(title: string, choices: Choice<T>[]): void {
        Console.writeLine();
        Console.banner(title);
        Console.writeLine();

        const width = String(choices.length).length;
        choices.forEach((c, i) => {
            const box = c.forced === true ? "[-]" : c.selected ? "[x]" : "[ ]";
            const style = c.forced === true ? Color.darkGray : c.selected ? Color.green : Color.darkGray;
            Console.writeColor(style, `  ${String(i + 1).padStart(width)} ${box} ${c.key}`);
            Console.writeLineColor(Color.darkGray, c.description === "" ? "" : `  — ${c.description}`);
        });

        Console.writeLine();
        const kept = choices.filter(c => c.selected).length;
        Console.writeLineColor(Color.white,
            `  Keeping ${kept} of ${choices.length}; removing ${choices.length - kept}.`);
    }

    /** `1,3,5-7,tour` — numbers, ranges and keys, each TOGGLING the entry it names. */
    function applyToggles<T>(choices: Choice<T>[], line: string): void {
        if (line.toLowerCase() === "all") { choices.forEach(c => { if (c.forced !== true) c.selected = true; }); return; }
        if (line.toLowerCase() === "none") { choices.forEach(c => { if (c.forced !== true) c.selected = false; }); return; }

        for (const token of line.split(/[,\s]+/).filter(t => t !== "")) {
            const range = /^(\d+)-(\d+)$/.exec(token);
            if (range != null) {
                const from = Number(range[1]), to = Number(range[2]);
                for (let i = Math.min(from, to); i <= Math.max(from, to); i++)
                    toggleIndex(choices, i - 1, token);
                continue;
            }

            if (/^\d+$/.test(token)) { toggleIndex(choices, Number(token) - 1, token); continue; }

            const byKey = choices.filter(c => c.key.toLowerCase() === token.toLowerCase());
            if (byKey.length === 1) { toggle(choices, byKey[0], token); continue; }

            Console.writeLineColor(Color.red, `  '${token}' is not one of the options`);
        }
    }

    function toggleIndex<T>(choices: Choice<T>[], index: number, token: string): void {
        if (index < 0 || index >= choices.length) {
            Console.writeLineColor(Color.red, `  '${token}' is out of range`);
            return;
        }
        toggle(choices, choices[index], token);
    }

    function toggle<T>(choices: Choice<T>[], choice: Choice<T>, token: string): void {
        if (choice.forced === true) {
            Console.writeLineColor(Color.yellow,
                `  '${token}' cannot be changed here (something selected depends on it)`);
            return;
        }
        choice.selected = !choice.selected;

        const changed = cascade(choices, choice);
        if (changed.length > 0)
            Console.writeLineColor(Color.yellow, choice.selected
                ? `  '${choice.key}' needs ${changed.join(", ")} — ticked too`
                : `  ${changed.join(", ")} need${changed.length === 1 ? "s" : ""} '${choice.key}' — unticked too`);
    }

    /**
     * Propagate one choice's state through `requires`: a ticked choice ticks everything it requires, an
     * unticked one unticks everything that requires it — transitively. Forced rows are never touched.
     * Returns the keys it changed.
     */
    function cascade<T>(choices: Choice<T>[], start: Choice<T>): string[] {
        const byKey = new Map(choices.map(c => [c.key.toLowerCase(), c]));
        const changed: string[] = [];
        const pending = [start];

        while (pending.length > 0) {
            const c = pending.pop()!;
            const next = c.selected
                ? (c.requires ?? []).map(k => byKey.get(k.toLowerCase())).filter(r => r != undefined)
                : choices.filter(o => (o.requires ?? []).some(k => k.toLowerCase() === c.key.toLowerCase()));

            for (const n of next) {
                if (n.forced === true || n.selected === c.selected)
                    continue;
                n.selected = c.selected;
                changed.push(n.key);
                pending.push(n);
            }
        }

        return changed;
    }

    /** Ask for a value, re-asking while `validate` returns a complaint. */
    export async function askValidated(question_: string, validate: (value: string) => string | undefined,
        initial?: string): Promise<string | undefined> {
        for (; ;) {
            const answer = initial ?? await Console.askString(question_);
            initial = undefined;

            if (answer === "")
                return undefined;

            const complaint = validate(answer);
            if (complaint == undefined)
                return answer;

            Console.writeLineColor(Color.red, "  " + complaint);
        }
    }

    function question(rl: readline.Interface, text: string): Promise<string> {
        return new Promise(resolve => rl.question(text, resolve));
    }
}
