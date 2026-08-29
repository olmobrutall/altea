import * as readline from "node:readline";
import chalk from "chalk";

// A minimal port of Signum.Utilities' SafeConsole — coloured writes and the yes/no / pick-one / free-text
// prompts. Signum keeps it in Utilities because half the framework prints with it; it started in
// @altea/altea-migrations, the only package that needed a console, and moved HERE the moment core's own
// sync flow needed one too (server/sync/openSqlFile, Signum's SqlPreCommandExtensions.OpenSqlFileRetry —
// which lives in Signum.Engine and prints with SafeConsole for exactly the same reason).
// @altea/altea-migrations re-exports it, so its own callers are unchanged.
//
// altea divergences:
//  - `ConsoleColor` → chalk styles (which no-op when the output is not a TTY, so redirected logs stay clean).
//  - Signum's SafeConsole "safe" part guards against a redirected stdout with no cursor; chalk handles that,
//    and the cursor games (WriteSameLine / progress bars) are not ported — nothing here needs them.
//  - Every prompt is ASYNC (node's readline is), so the runners are async top to bottom.
//  - `Console.WindowWidth` → `process.stdout.columns ?? 100`.

export namespace SafeConsole {

    export function isInteractive(): boolean {
        return Boolean(process.stdin.isTTY);
    }

    export function width(): number {
        return process.stdout.columns ?? 100;
    }

    export function writeLine(text = ""): void {
        console.log(text);
    }

    /** Signum's `SafeConsole.WriteLineColor(color, text)`. */
    export function writeLineColor(style: (s: string) => string, text: string): void {
        console.log(style(text));
    }

    /** A `------- title -------` separator line filling the console width (Signum's PadRight banner). */
    export function banner(text: string): void {
        const line = `------- ${text} `;
        console.log(line.padEnd(Math.max(line.length, width() - 2), "-"));
    }

    /** Signum's `SafeConsole.Ask(question)` — yes/no, defaulting to NO on an empty answer or a closed stdin. */
    export async function ask(question: string): Promise<boolean> {
        const answer = (await question_(`${question} (y/n) `)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
    }

    /**
     * Signum's `SafeConsole.Ask(question, ...options)` — pick one of `options` (matched case-insensitively,
     * also by unique prefix). Returns undefined on an empty answer / closed stdin, which every caller
     * treats as "do nothing".
     */
    export async function askOptions(question: string, ...options: string[]): Promise<string | undefined> {
        for (; ;) {
            const answer = (await question_(`${question} (${options.join("/")}) `)).trim().toLowerCase();
            if (answer === "")
                return undefined;
            const exact = options.find(o => o.toLowerCase() === answer);
            if (exact != undefined)
                return exact;
            const byPrefix = options.filter(o => o.toLowerCase().startsWith(answer));
            if (byPrefix.length === 1)
                return byPrefix[0];
            console.log(chalk.red(`'${answer}' is not one of ${options.join(", ")}`));
        }
    }

    /** Signum's `SafeConsole.AskString(question)`. */
    export async function askString(question: string): Promise<string> {
        return (await question_(question)).trim();
    }

    // One readline interface per prompt: the terminal opens and closes them the same way (see
    // consoleSwitch), and holding one open across a whole migration run would swallow Ctrl+C.
    // Resolves to "" on EOF / a closed stream, so a piped (non-TTY) run ends instead of hanging.
    function question_(prompt: string): Promise<string> {
        if (!isInteractive())
            return Promise.resolve("");

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise<string>(resolve => {
            let answered = false;
            const onClose = (): void => { if (!answered) resolve(""); };
            rl.once("close", onClose);
            rl.question(prompt, answer => {
                answered = true;
                rl.removeListener("close", onClose);
                rl.close();
                resolve(answer);
            });
        });
    }
}

/** The chalk styles the runners use, named after the ConsoleColor Signum passes. */
export const Color = {
    white: chalk.whiteBright,
    gray: chalk.gray,
    darkGray: chalk.gray,
    green: chalk.greenBright,
    darkGreen: chalk.green,
    yellow: chalk.yellowBright,
    red: chalk.redBright,
    darkRed: chalk.red,
};
