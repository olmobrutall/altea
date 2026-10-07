import { WebSocketHub, type HubConnection } from "./webSocketHub";
import type { WebBuilder } from "./webApi";
import { UserHolder } from "./userHolder";
import { SafeConsole, type ConsoleStyle, type IAbstractConsole, type SelectValueOptions, type SelectValueResult } from "./safeConsole";
import { WebConsoleProtocol, type WebConsoleAnswer, type WebConsoleQuestion } from "../data/webConsoleDtos";

// The WEB CONSOLE: IAbstractConsole with a browser on the other end. A server COMMAND (a schema
// synchronization, a migration run) writes and asks exactly as it does in the terminal — through
// `SafeConsole` or `replacements.console` — and `WebConsoleServer` runs it with a WebConsole as the current
// console, so every line goes to the browser and every question waits for its answer.
//
// The transport is the WebSocket hub (one session per connection): HTTP cannot carry the answers while the
// response is still being written. Authentication is the hub's first frame, resolved by
// `WebConsoleServer.authenticate` — which @altea/altea-auth installs, since core does not know tokens —
// and the command runs as that user.

export class WebConsole implements IAbstractConsole {
    readonly interactive = true;

    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (answer: WebConsoleAnswer) => void; reject: (e: Error) => void }>();
    private cancelled: Error | undefined;

    constructor(private readonly connection: HubConnection) { }

    width(): number {
        return 120;
    }

    height(): number {
        return 40;
    }

    write(text: string, style?: ConsoleStyle): void {
        this.connection.send(WebConsoleProtocol.write, text, style?.colorName ?? null, false);
    }

    writeLine(text = "", style?: ConsoleStyle): void {
        this.connection.send(WebConsoleProtocol.write, text, style?.colorName ?? null, true);
    }

    async ask(question: string): Promise<boolean> {
        return await this.question({ kind: "yesNo", question }) as boolean;
    }

    async askAlways(question: string, defaultYes: boolean): Promise<{ yes: boolean; always: boolean }> {
        return await this.question({ kind: "yesNoAlways", question, defaultYes }) as { yes: boolean; always: boolean };
    }

    async askOptions(question: string, ...options: string[]): Promise<string | undefined> {
        return (await this.question({ kind: "options", question, options }) as string | null) ?? undefined;
    }

    async askString(question: string): Promise<string> {
        return (await this.question({ kind: "text", question }) as string | null) ?? "";
    }

    async selectValue(question: string, values: readonly string[], options?: SelectValueOptions): Promise<SelectValueResult> {
        return await this.question({
            kind: "select", question, values: [...values],
            allowNone: options?.allowNone ?? false, noneLabel: options?.noneLabel, allowAlways: options?.allowAlways ?? false,
        }) as SelectValueResult;
    }

    /** The browser's answer to question `id`. */
    answer(id: number, answer: WebConsoleAnswer): void {
        const p = this.pending.get(id);
        this.pending.delete(id);
        p?.resolve(answer);
    }

    /** The browser left or gave up: every question still open — and every later one — fails the command. */
    cancel(reason: string): void {
        this.cancelled = new Error(reason);
        for (const p of this.pending.values())
            p.reject(this.cancelled);
        this.pending.clear();
    }

    private question(q: DistributiveOmit<WebConsoleQuestion, "id">): Promise<WebConsoleAnswer> {
        if (this.cancelled != null)
            return Promise.reject(this.cancelled);

        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.connection.send(WebConsoleProtocol.question, { ...q, id } as WebConsoleQuestion);
        });
    }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Something the web console can run: a name, who may, and the body — which writes and asks through SafeConsole. */
export interface WebConsoleCommand {
    name: string;
    isAllowed: () => boolean | Promise<boolean>;
    run: (args: unknown) => Promise<unknown>;
}

export namespace WebConsoleServer {

    const commands = new Map<string, WebConsoleCommand>();
    const sessions = new Map<string, WebConsole>();
    let hub: WebSocketHub | undefined;

    /** Resolves the hub's first-frame token to a user — installed by the authentication module. */
    export let authenticate: ((token: string | undefined) => Promise<unknown>) | undefined;

    /** Mount the hub. Idempotent: every module that registers a command calls it. */
    export function start(ws: WebBuilder): void {
        if (hub != null)
            return;

        const h = hub = new WebSocketHub(WebConsoleProtocol.hubPath);
        h.authenticate = async token => {
            if (authenticate == null)
                throw new Error("WebConsoleServer.authenticate is not installed (the authentication module does it)");
            return await authenticate(token);
        };

        h.methods[WebConsoleProtocol.start] = (conn, commandName: string, args: unknown) => {
            const command = commands.get(commandName);
            if (command == null || sessions.has(conn.id)) {
                conn.send(WebConsoleProtocol.failed, command == null
                    ? `Unknown web console command '${commandName}'`
                    : "A command is already running on this connection");
                return;
            }

            const console = new WebConsole(conn);
            sessions.set(conn.id, console);

            // Not awaited: the hub would hold every later frame (the ANSWERS) behind this one.
            void UserHolder.withUser(conn.user as never, async () => {
                if (!await command.isAllowed())
                    throw new Error(`Not authorized to run '${commandName}'`);
                return await SafeConsole.runWith(console, () => command.run(args));
            }).then(
                result => conn.send(WebConsoleProtocol.finished, result ?? null),
                (e: unknown) => conn.send(WebConsoleProtocol.failed, e instanceof Error ? e.message : String(e)),
            ).finally(() => sessions.delete(conn.id));
        };

        h.methods[WebConsoleProtocol.answer] = (conn, id: number, answer: WebConsoleAnswer) => {
            sessions.get(conn.id)?.answer(id, answer);
        };

        h.methods[WebConsoleProtocol.cancel] = conn => {
            sessions.get(conn.id)?.cancel("Cancelled");
        };

        h.onDisconnected = conn => {
            sessions.get(conn.id)?.cancel("The browser disconnected");
        };

        ws.webSocket(h);
    }

    export function registerCommand(command: WebConsoleCommand): void {
        commands.set(command.name, command);
    }
}
