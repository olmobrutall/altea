import * as readline from "node:readline";

/**
 * Colours and prompts, with NO dependencies.
 *
 * `@altea/altea`'s `SafeConsole` does the same job and is where this started — but these tools must run
 * from a bare checkout, before `pnpm install` has ever been executed there (`altea-clone` CREATES the
 * project it would be installed into), and they must keep working when the framework itself does not
 * compile. So: node builtins only, and chalk becomes raw SGR escapes.
 *
 * Colour is suppressed when stdout is not a TTY or NO_COLOR is set, which is the one thing chalk was
 * doing that actually mattered here — a redirected log stays readable.
 */

const enabled = process.stdout.isTTY === true
    && process.env["NO_COLOR"] == undefined
    && process.env["TERM"] !== "dumb";

const sgr = (code: string) => (text: string): string =>
    enabled ? `\u001b[${code}m${text}\u001b[0m` : text;

/** Named after the ConsoleColor Signum passes, so a port reads the same. */
export const Color = {
    white: sgr("97"),
    gray: sgr("90"),
    darkGray: sgr("90"),
    green: sgr("92"),
    darkGreen: sgr("32"),
    yellow: sgr("93"),
    darkYellow: sgr("33"),
    red: sgr("91"),
    darkRed: sgr("31"),
    magenta: sgr("95"),
    blue: sgr("94"),
    cyan: sgr("96"),
};

export type Style = (text: string) => string;

export namespace Console {

    /** Whether there is a human to answer a prompt. A scripted run must FAIL rather than wait forever. */
    export function isInteractive(): boolean {
        return process.stdin.isTTY === true;
    }

    export function width(): number {
        return process.stdout.columns ?? 100;
    }

    export function writeLine(text = ""): void {
        process.stdout.write(text + "\n");
    }

    export function write(text: string): void {
        process.stdout.write(text);
    }

    export function writeColor(style: Style, text: string): void {
        process.stdout.write(style(text));
    }

    export function writeLineColor(style: Style, text: string): void {
        process.stdout.write(style(text) + "\n");
    }

    export function banner(text: string): void {
        const line = `------- ${text} `;
        writeLine(line.padEnd(Math.max(line.length, width() - 2), "-"));
    }

    /** Yes/no, defaulting to NO on an empty answer or a closed stdin. */
    export async function ask(question: string): Promise<boolean> {
        const answer = (await askString(`${question} (y/n) `)).toLowerCase();
        return answer === "y" || answer === "yes";
    }

    /**
     * Pick one of `options`, matched case-insensitively and by unique prefix. Returns undefined on an
     * empty answer / closed stdin, which every caller treats as "do nothing".
     */
    export async function askOptions(question: string, ...options: string[]): Promise<string | undefined> {
        for (; ;) {
            const answer = (await askString(`${question} (${options.join("/")}) `)).toLowerCase();
            if (answer === "")
                return undefined;

            const exact = options.find(o => o.toLowerCase() === answer);
            if (exact != undefined)
                return exact;

            const byPrefix = options.filter(o => o.toLowerCase().startsWith(answer));
            if (byPrefix.length === 1)
                return byPrefix[0];

            writeLineColor(Color.red, `'${answer}' is not one of ${options.join(", ")}`);
        }
    }

    /** One line of free text, trimmed. Empty on a closed stdin. */
    export async function askString(question: string): Promise<string> {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        handleSigInt(rl);
        try {
            return await new Promise<string>(resolve => rl.question(question, resolve));
        } finally {
            rl.close();
        }
    }

    /**
     * Make Ctrl+C work at a prompt. Node's readline INTERCEPTS SIGINT while an interface is open, and with
     * no listener on the INTERFACE it merely emits 'pause': the process keeps running and the prompt looks
     * hung. Hand the signal back — run the process's own handlers if it has any, otherwise terminate with
     * the status a shell reports for a Ctrl+C death.
     */
    export function handleSigInt(rl: readline.Interface): void {
        rl.once("SIGINT", () => {
            rl.close();                 // restore the terminal before anything else prints
            process.stdout.write("\n");
            if (process.listenerCount("SIGINT") > 0)
                process.emit("SIGINT");
            else
                process.exit(130);
        });
    }
}
