import * as net from "node:net";
import * as tls from "node:tls";
import * as fs from "node:fs/promises";

// The PROTOCOL half of the POP3 port — Signum's `MailKitPop3Client` minus the MIME parsing (which is
// MimeToEmailMessage.ts).
//
// ══ WHY THIS IS HAND-WRITTEN ═══════════════════════════════════════════════════════════════════════════
// Signum uses MailKit, which has no equivalent on Node worth taking: the POP3 packages on npm are thin,
// unmaintained wrappers over exactly the exchange below. POP3 is a line protocol with five commands — and
// the one thing that IS subtle (a multi-line response ends with a lone ".", and a line of body text that
// happens to start with "." is byte-stuffed to "..") is handled once, in `readMultiline`.
//
// altea divergences from MailKit, documented inline:
//  - Only IMPLICIT TLS is offered (`enableSSL` → connect with TLS, conventionally on port 995), matching what
//    Signum actually passes: `Connect(host, port, true)` or `SecureSocketOptions.None`. STARTTLS (`STLS`) is
//    NOT ported, because Signum never asks for it.
//  - `client.Capabilities.HasFlag(Pop3Capabilities.UIDL)` becomes a `CAPA` probe, with a fallback: a server
//    that does not implement CAPA at all (it is optional in RFC 2449) is still asked for UIDL, and it is the
//    UIDL response that decides. Signum throws on the capability flag; this throws on the same condition, one
//    round-trip later, which is strictly more permissive and never wrong.
//  - MailKit's message indices are 0-based; the WIRE is 1-based. `MessageUid.number` keeps Signum's 0-based
//    index (it is what the reception log stores), and every command adds one.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/** Signum's `MessageUid` — the server's unique id for a message, its index, and its size. */
export interface MessageUid {
    /** The UIDL value: stable across sessions, and the reception de-duplication key. */
    uid: string;
    /** 0-based, as MailKit reports it (the wire is 1-based — see the header). */
    number: number;
    size: number;
}

export interface Pop3ClientOptions {
    host: string;
    port: number;
    username: string;
    password: string;
    /** Implicit TLS (see the header). */
    enableSSL: boolean;
    /** Milliseconds; -1 (Signum's "no timeout") disables it. */
    readTimeout: number;
    /** Paths of client certificates to present (Signum's ClientCertificationFiles). */
    clientCertificationFiles?: string[];
}

/** Signum's `IPop3Client` — what the reception loop needs from a mailbox. */
export interface IPop3Client extends AsyncDisposable {
    getMessageInfos(): Promise<MessageUid[]>;
    /** The RAW MIME of one message (Signum's `client.GetMessage(number)`, before parsing). */
    getMessageSource(info: MessageUid): Promise<Buffer>;
    deleteMessage(info: MessageUid): Promise<void>;
    /** QUIT — which is what makes the server APPLY the deletes (Signum's comment: "Delete messages now"). */
    disconnect(): Promise<void>;
}

export class Pop3Client implements IPop3Client {

    private socket: net.Socket | undefined;
    private buffer = Buffer.alloc(0);
    private waiter: (() => void) | undefined;
    private failure: Error | undefined;
    private closed = false;

    private constructor(private readonly options: Pop3ClientOptions) { }

    /** Connect + authenticate (Signum's constructor). */
    static async connect(options: Pop3ClientOptions): Promise<Pop3Client> {
        const client = new Pop3Client(options);
        await client.open();

        try {
            await client.command(`USER ${options.username}`);
            await client.command(`PASS ${options.password}`);
        } catch (e) {
            await client.destroy();
            throw e;
        }

        return client;
    }

    async getMessageInfos(): Promise<MessageUid[]> {
        const uidls = await this.multiline("UIDL");
        if (uidls == null)
            throw new Error("The POP3 server does not support UIDs!"); // Signum's exact message

        // "1 <uid>" per line. The index is the wire number minus one (see the header).
        const uids = new Map<number, string>();
        for (const line of uidls) {
            const space = line.indexOf(" ");
            if (space < 0)
                continue;
            const wireNumber = Number.parseInt(line.substring(0, space), 10);
            if (Number.isFinite(wireNumber))
                uids.set(wireNumber, line.substring(space + 1).trim());
        }

        // "1 <octets>" per line.
        const sizes = new Map<number, number>();
        for (const line of (await this.multiline("LIST")) ?? []) {
            const space = line.indexOf(" ");
            if (space < 0)
                continue;
            const wireNumber = Number.parseInt(line.substring(0, space), 10);
            if (Number.isFinite(wireNumber))
                sizes.set(wireNumber, Number.parseInt(line.substring(space + 1), 10) || 0);
        }

        return [...uids.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([wireNumber, uid]) => ({ uid, number: wireNumber - 1, size: sizes.get(wireNumber) ?? 0 }));
    }

    async getMessageSource(info: MessageUid): Promise<Buffer> {
        const lines = await this.multiline(`RETR ${info.number + 1}`);
        if (lines == null)
            throw new Error(`The POP3 server refused RETR for message ${info.number + 1} (uid ${info.uid})`);

        // CRLF is what the message was transmitted with, and what a MIME parser expects.
        return Buffer.from(lines.join("\r\n"), "binary");
    }

    async deleteMessage(info: MessageUid): Promise<void> {
        await this.command(`DELE ${info.number + 1}`);
    }

    async disconnect(): Promise<void> {
        if (this.socket == undefined || this.closed)
            return;

        try {
            // A clean QUIT is what commits the DELEs; RSET-on-drop is the server's behaviour otherwise.
            await this.command("QUIT");
        } finally {
            await this.destroy();
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.destroy();
    }

    // ---- the socket -------------------------------------------------------------------------------------

    private async open(): Promise<void> {
        const certs: Buffer[] = [];
        for (const path of this.options.clientCertificationFiles ?? [])
            certs.push(await fs.readFile(path));

        this.socket = await new Promise<net.Socket>((resolve, reject) => {
            const onError = (e: Error): void => reject(e);

            const socket = this.options.enableSSL
                ? tls.connect({
                    host: this.options.host,
                    port: this.options.port,
                    ...(certs.length > 0 ? { cert: certs } : {}),
                }, () => { socket.removeListener("error", onError); resolve(socket); })
                : net.connect({ host: this.options.host, port: this.options.port },
                    () => { socket.removeListener("error", onError); resolve(socket); });

            socket.once("error", onError);
        });

        if (this.options.readTimeout >= 0)
            this.socket.setTimeout(this.options.readTimeout, () =>
                this.fail(new Error(`The POP3 server did not answer within ${this.options.readTimeout} ms`)));

        // Latin-1 ("binary"): POP3 is a byte protocol and a message body may be any encoding at all. Decoding
        // as UTF-8 here would corrupt the bytes before the MIME parser (which reads the charset) ever sees
        // them; latin-1 is the one encoding that round-trips every byte.
        this.socket.setEncoding("binary");
        this.socket.on("data", (chunk: string) => {
            this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk, "binary")]);
            this.waiter?.();
        });
        this.socket.on("error", e => this.fail(e));
        this.socket.on("close", () => {
            this.closed = true;
            this.waiter?.();
        });

        // The greeting.
        await this.readLine();
    }

    private async destroy(): Promise<void> {
        this.closed = true;
        this.socket?.destroy();
        this.socket = undefined;
    }

    private fail(error: Error): void {
        this.failure ??= error;
        this.waiter?.();
    }

    /** Send a command and read its single-line answer, throwing on `-ERR`. */
    private async command(text: string): Promise<string> {
        this.write(text);
        const line = await this.readLine();

        if (!line.startsWith("+OK"))
            throw new Error(`POP3 ${text.startsWith("PASS") ? "PASS ***" : text} failed: ${line}`);

        return line;
    }

    /**
     * Send a command and read a MULTI-LINE answer: the lines between the `+OK` and the terminating `.`, with
     * the byte-stuffing undone. Returns undefined when the server answers `-ERR` (which is how an unsupported
     * UIDL / CAPA reports itself, and is not an error to the caller).
     */
    private async multiline(text: string): Promise<string[] | undefined> {
        this.write(text);

        const first = await this.readLine();
        if (!first.startsWith("+OK"))
            return undefined;

        const lines: string[] = [];
        for (;;) {
            const line = await this.readLine();
            if (line === ".")
                return lines;

            // RFC 1939 §3: a line starting with "." is transmitted with an extra one prefixed.
            lines.push(line.startsWith("..") ? line.substring(1) : line);
        }
    }

    private write(text: string): void {
        if (this.socket == undefined)
            throw new Error("The POP3 connection is closed");
        this.socket.write(text + "\r\n", "binary");
    }

    private async readLine(): Promise<string> {
        for (;;) {
            if (this.failure != undefined)
                throw this.failure;

            const newline = this.buffer.indexOf(0x0a); // \n
            if (newline >= 0) {
                const line = this.buffer.subarray(0, newline).toString("binary").replace(/\r$/, "");
                this.buffer = this.buffer.subarray(newline + 1);
                return line;
            }

            if (this.closed)
                throw new Error("The POP3 server closed the connection unexpectedly");

            await new Promise<void>(resolve => { this.waiter = resolve; });
            this.waiter = undefined;
        }
    }
}
