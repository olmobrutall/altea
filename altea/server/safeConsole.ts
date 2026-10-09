import * as readline from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";
import chalk from "chalk";
import type { WebConsoleColor } from "../data/webConsoleDtos";

// A port of Signum.Utilities' SafeConsole — coloured writes and the yes/no / pick-one / free-text prompts —
// behind an ABSTRACTION, so the code that asks (the schema synchronizer, the migration runners, the auth
// import) does not care where the answer comes from:
//
//  - IAbstractConsole is what a question is asked OF;
//  - TerminalConsole is stdout + readline, the behaviour every caller had before;
//  - another implementation (a web console streaming to a browser) is plugged in with `SafeConsole.runWith`,
//    which makes it the CURRENT console for everything that runs inside — through an AsyncLocalStorage, so
//    the dozens of `SafeConsole.ask(...)` callers need no parameter threaded to them.
//
// Every prompt is ASYNC: a web console's answer arrives over the network, and node's readline is async too.
//
// altea divergences:
//  - `ConsoleColor` → chalk styles (which no-op when the output is not a TTY, so redirected logs stay clean),
//    each tagged with its name (`Color`) so a console that is not a terminal can render it.
//  - the cursor games (WriteSameLine / progress bars) are not ported — nothing here needs them.

/** A style: applies the colour for a terminal, and names it for any other console. */
export interface ConsoleStyle {
    (text: string): string;
    colorName?: ConsoleColorName;
}

export type ConsoleColorName = WebConsoleColor;

export interface SelectValueOptions {
    /** Offer "none of these" — the rename list's "no rename". Its label, when the default does not fit. */
    allowNone?: boolean;
    noneLabel?: string;
    /** Offer "always none" — the rename list's `n!`. */
    allowAlways?: boolean;
}

export interface SelectValueResult {
    /** The value picked, or null for "none". */
    value: string | null;
    /** "none — and the same for every later question of this kind". */
    always: boolean;
}

/** What a question is asked of. See the header. */
export interface IAbstractConsole {
    /** Whether anyone can answer. A non-interactive console answers every prompt with its default. */
    readonly interactive: boolean;
    width(): number;
    height(): number;

    write(text: string, style?: ConsoleStyle): void;
    writeLine(text?: string, style?: ConsoleStyle): void;

    /** Yes / no, defaulting to NO. */
    ask(question: string): Promise<boolean>;
    /** Yes / no, plus "and always" for either — Signum's `Ask(ref bool? always, …)`. Enter is `defaultYes`. */
    askAlways(question: string, defaultYes: boolean): Promise<{ yes: boolean; always: boolean }>;
    /** One of `options`; undefined on an empty answer. */
    askOptions(question: string, ...options: string[]): Promise<string | undefined>;
    askString(question: string): Promise<string>;
    /** One of `values` (the first is the default), or none — the synchronizer's rename question. */
    selectValue(question: string, values: readonly string[], options?: SelectValueOptions): Promise<SelectValueResult>;
}

// ---- The terminal ------------------------------------------------------------------------------------------

export class TerminalConsole implements IAbstractConsole {

    get interactive(): boolean {
        return Boolean(process.stdin.isTTY);
    }

    width(): number {
        return process.stdout.columns ?? 100;
    }

    /** Signum's `Console.LargestWindowHeight` — how many lines a picker may print before paging. */
    height(): number {
        return process.stdout.rows ?? 40;
    }

    write(text: string, style?: ConsoleStyle): void {
        process.stdout.write(style != null ? style(text) : text);
    }

    writeLine(text = "", style?: ConsoleStyle): void {
        console.log(style != null ? style(text) : text);
    }

    async ask(question: string): Promise<boolean> {
        const answer = (await this.question(`${question} (y/n) `)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
    }

    async askAlways(question: string, defaultYes: boolean): Promise<{ yes: boolean; always: boolean }> {
        this.writeLine();
        this.writeLine(question);
        this.writeLine(` y: yes    y!: yes, always    n: no    n!: no, always    ([Enter] = ${defaultYes ? "y" : "n"})`);
        for (; ;) {
            const answer = (await this.question("")).trim().toLowerCase();
            if (answer === "")
                return { yes: defaultYes, always: false };
            if (answer === "y" || answer === "y!" || answer === "n" || answer === "n!")
                return { yes: answer.startsWith("y"), always: answer.endsWith("!") };
            this.writeLine("Error", Color.red);
        }
    }

    async askOptions(question: string, ...options: string[]): Promise<string | undefined> {
        for (; ;) {
            const answer = (await this.question(`${question} (${options.join("/")}) `)).trim().toLowerCase();
            if (answer === "")
                return undefined;
            const exact = options.find(o => o.toLowerCase() === answer);
            if (exact != undefined)
                return exact;
            const byPrefix = options.filter(o => o.toLowerCase().startsWith(answer));
            if (byPrefix.length === 1)
                return byPrefix[0];
            this.writeLine(`'${answer}' is not one of ${options.join(", ")}`, Color.red);
        }
    }

    async askString(question: string): Promise<string> {
        return (await this.question(question)).trim();
    }

    async selectValue(question: string, values: readonly string[], options?: SelectValueOptions): Promise<SelectValueResult> {
        this.writeLine();
        this.writeLine(question);
        for (; ;) {
            values.forEach((v, i) => this.writeLine(`${String(i).padStart(2)}: ${v}${i === 0 ? " (hit [Enter])" : ""}`));
            if (options?.allowNone)
                this.writeLine(` n: ${options.noneLabel ?? "None"}`);
            if (options?.allowAlways)
                this.writeLine(` n!: Always ${(options.noneLabel ?? "none").replace(/^./, c => c.toLowerCase())}`);

            // A closed stdin answers "none" when that is offered, as the synchronous reader it replaces did.
            const answer = (await this.question("", options?.allowNone ? "n" : "")).trim().toLowerCase();
            if (answer === "" && values.length > 0)
                return { value: values[0], always: false };
            if (options?.allowNone && answer === "n")
                return { value: null, always: false };
            if (options?.allowAlways && answer === "n!")
                return { value: null, always: true };
            const index = Number.parseInt(answer, 10);
            if (Number.isInteger(index) && index >= 0 && index < values.length)
                return { value: values[index], always: false };
            this.writeLine("Error", Color.red);
        }
    }

    // One readline interface per prompt: holding one open across a whole run would swallow Ctrl+C.
    // Resolves to `onClosed` on EOF / a closed stream, so a piped (non-TTY) run ends instead of hanging.
    private question(prompt: string, onClosed = ""): Promise<string> {
        if (!this.interactive)
            return Promise.resolve(onClosed);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise<string>(resolve => {
            let answered = false;
            const onClose = (): void => { if (!answered) resolve(onClosed); };
            rl.once("close", onClose);
            // A Ctrl+C answers nothing: the process is going down (or its own handler owns what happens
            // next), so the pending question is abandoned rather than resolved with "" — which the
            // caller would read as an empty answer and re-prompt.
            rl.once("SIGINT", () => { answered = true; });
            SafeConsole.handleSigInt(rl);
            rl.question(prompt, answer => {
                answered = true;
                rl.removeListener("close", onClose);
                rl.close();
                resolve(answer);
            });
        });
    }
}

// ---- The facade ----------------------------------------------------------------------------------------------

export namespace SafeConsole {

    const terminal = new TerminalConsole();
    const scope = new AsyncLocalStorage<IAbstractConsole>();

    /** The console of the code running now: the one `runWith` installed, else the terminal. */
    export function current(): IAbstractConsole {
        return scope.getStore() ?? terminal;
    }

    /** Run `action` with `console` as the current one — every SafeConsole call inside goes to it. */
    export function runWith<T>(console: IAbstractConsole, action: () => Promise<T>): Promise<T> {
        return scope.run(console, action);
    }

    export function isInteractive(): boolean {
        return current().interactive;
    }

    export function width(): number {
        return current().width();
    }

    export function height(): number {
        return current().height();
    }

    export function writeLine(text = ""): void {
        current().writeLine(text);
    }

    /** `Console.Write` — no newline, so a caller can build one line in pieces (a step's name, then its
     *  outcome once it is known). */
    export function write(text: string): void {
        current().write(text);
    }

    /** Signum's `SafeConsole.WriteColor(color, text)` — the no-newline half of writeLineColor. */
    export function writeColor(style: ConsoleStyle, text: string): void {
        current().write(text, style);
    }

    /** Signum's `SafeConsole.WriteLineColor(color, text)`. */
    export function writeLineColor(style: ConsoleStyle, text: string): void {
        current().writeLine(text, style);
    }

    /** A `------- title -------` separator line filling the console width (Signum's PadRight banner). */
    export function banner(text: string): void {
        const line = `------- ${text} `;
        writeLine(line.padEnd(Math.max(line.length, width() - 2), "-"));
    }

    /** Signum's `SafeConsole.Ask(question)` — yes/no, defaulting to NO on an empty answer or a closed stdin. */
    export function ask(question: string): Promise<boolean> {
        return current().ask(question);
    }

    /** Signum's `SafeConsole.Ask(ref bool? always, question)`. */
    export function askAlways(question: string, defaultYes: boolean): Promise<{ yes: boolean; always: boolean }> {
        return current().askAlways(question, defaultYes);
    }

    /**
     * Signum's `SafeConsole.Ask(question, ...options)` — pick one of `options` (matched case-insensitively,
     * also by unique prefix). Returns undefined on an empty answer / closed stdin, which every caller
     * treats as "do nothing".
     */
    export function askOptions(question: string, ...options: string[]): Promise<string | undefined> {
        return current().askOptions(question, ...options);
    }

    /** Signum's `SafeConsole.AskString(question)`. */
    export function askString(question: string): Promise<string> {
        return current().askString(question);
    }

    export function selectValue(question: string, values: readonly string[], options?: SelectValueOptions): Promise<SelectValueResult> {
        return current().selectValue(question, values, options);
    }

    /**
     * Make Ctrl+C work at a readline prompt — call it on every interface opened on a TTY.
     *
     * Node's readline INTERCEPTS SIGINT while an interface is open, and with no `'SIGINT'` listener on
     * the INTERFACE it merely emits `'pause'`: the process keeps running and the prompt looks hung,
     * which is what Ctrl+C did to every SafeConsole question (and to the terminal's own pickers). So
     * hand the signal back to the process: run its own handlers if it has any — the host's
     * "Application Stop" row, the runners' stops — and otherwise terminate with the status a shell
     * reports for a Ctrl+C death, which is what Node's default disposition would have done. Once a
     * process-level handler exists, exiting is ITS job, exactly as for a Ctrl+C with no prompt open.
     */
    export function handleSigInt(rl: readline.Interface): void {
        rl.once("SIGINT", () => {
            rl.close();          // restore the terminal before anything else prints
            process.stdout.write("\n");
            if (process.listenerCount("SIGINT") > 0)
                process.emit("SIGINT", "SIGINT");
            else
                process.exit(130);   // 128 + SIGINT, the shape systemEventServer's handlers also use
        });
    }
}

function named(colorName: ConsoleColorName, style: (s: string) => string): ConsoleStyle {
    return Object.assign((text: string) => style(text), { colorName });
}

/** The styles the runners use, named after the ConsoleColor Signum passes. */
export const Color = {
    white: named("white", chalk.whiteBright),
    gray: named("gray", chalk.gray),
    darkGray: named("gray", chalk.gray),
    green: named("green", chalk.greenBright),
    darkGreen: named("darkGreen", chalk.green),
    yellow: named("yellow", chalk.yellowBright),
    red: named("red", chalk.redBright),
    darkRed: named("darkRed", chalk.red),
    // Signum uses these four in its interactive pickers, where the colour IS the distinction between
    // outcomes (regenerate vs skip, "fix the token instead" vs "fix the operation instead").
    magenta: named("magenta", chalk.magentaBright),
    darkYellow: named("darkYellow", chalk.yellow),
    blue: named("blue", chalk.blueBright),
    cyan: named("cyan", chalk.cyanBright),
};
