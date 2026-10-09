import { msg } from "./utils/localization";

// The wire protocol of the WEB CONSOLE (server/webConsole.ts, client/WebConsole/WebConsoleView.tsx): a
// server command that writes and asks through IAbstractConsole, with a browser on the other end instead of
// a terminal. One frame per call over the WebSocket hub at `WebConsoleProtocol.hubPath`.
//
//   client → server   Start(commandName, args)   Answer(questionId, answer)   Cancel()
//   server → client   Write(text, colorName, newLine)   Question(question)   Finished(result)   Failed(message)

export namespace WebConsoleProtocol {
    export const hubPath = "/api/webConsole";

    export const start = "Start";
    export const answer = "Answer";
    export const cancel = "Cancel";

    export const write = "Write";
    export const question = "Question";
    export const finished = "Finished";
    export const failed = "Failed";
}

/** The colours a console line may carry — the names of `Color` (server/safeConsole). */
export type WebConsoleColor =
    "white" | "gray" | "green" | "darkGreen" | "yellow" | "red" | "darkRed" | "magenta" | "darkYellow" | "blue" | "cyan";

/** One question, by kind — one per IAbstractConsole prompt. */
export type WebConsoleQuestion = { id: number; question: string } & (
    | { kind: "yesNo" }
    | { kind: "yesNoAlways"; defaultYes: boolean }
    | { kind: "options"; options: string[] }
    | { kind: "text" }
    | { kind: "select"; values: string[]; allowNone: boolean; noneLabel?: string; allowAlways: boolean }
);

/** The answer to each kind, in the same order. */
export type WebConsoleAnswer =
    | boolean
    | { yes: boolean; always: boolean }
    | string | null
    | { value: string | null; always: boolean };

export const WebConsoleMessage = {
    Connecting: msg("Connecting…"),
    Running: msg("Running…"),
    Finished: msg("Finished"),
    Failed: msg("Failed"),
    Always: msg("Apply the same answer to the remaining questions"),
    Answer: msg("Answer"),
    WaitingForAnswer: msg("Waiting for your answer"),
};
