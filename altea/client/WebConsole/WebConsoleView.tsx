import * as React from "react";
import { useWebSocketCallback, useWebSocketConnection } from "../useWebSocket";
import { JavascriptMessage } from "../../data/uiMessages";
import {
    WebConsoleMessage, WebConsoleProtocol,
    type WebConsoleAnswer, type WebConsoleColor, type WebConsoleQuestion,
} from "../../data/webConsoleDtos";
import "./WebConsole.css";

// The browser end of server/webConsole.ts: runs one server COMMAND and shows what it writes, and answers
// what it asks with a small form per question kind. Mounting it starts the command; remount (a new `key`)
// to run it again. A dropped socket ends the run — the server cancels the command when its browser leaves.

interface Segment { text: string; color: WebConsoleColor | null }
type Line = Segment[];

type Status =
    | { kind: "connecting" }
    | { kind: "running" }
    | { kind: "finished"; result: unknown }
    | { kind: "failed"; message: string };

export interface WebConsoleViewProps {
    command: string;
    args?: unknown;
    onFinished?: (result: unknown) => void;
    onFailed?: (message: string) => void;
}

export function WebConsoleView(p: WebConsoleViewProps): React.ReactElement {

    const conn = useWebSocketConnection(WebConsoleProtocol.hubPath);

    const [lines, setLines] = React.useState<Line[]>([]);
    const [questions, setQuestions] = React.useState<WebConsoleQuestion[]>([]);
    const [status, setStatus] = React.useState<Status>({ kind: "connecting" });
    const started = React.useRef(false);
    const logRef = React.useRef<HTMLDivElement>(null);

    const propsRef = React.useRef(p);
    propsRef.current = p;

    function append(text: string, color: WebConsoleColor | null, newLine: boolean) {
        setLines(ls => {
            const result = ls.length == 0 ? [[]] : [...ls];
            const parts = text.split("\n");
            parts.forEach((part, i) => {
                if (i > 0)
                    result.push([]);
                if (part != "")
                    result[result.length - 1] = [...result[result.length - 1], { text: part, color }];
            });
            if (newLine)
                result.push([]);
            return result;
        });
    }

    useWebSocketCallback(conn, WebConsoleProtocol.write, (text: string, color: WebConsoleColor | null, newLine: boolean) => append(text, color, newLine), []);
    useWebSocketCallback(conn, WebConsoleProtocol.question, (q: WebConsoleQuestion) => setQuestions(qs => [...qs, q]), []);
    useWebSocketCallback(conn, WebConsoleProtocol.finished, (result: unknown) => {
        setStatus({ kind: "finished", result });
        setQuestions([]);
        propsRef.current.onFinished?.(result);
    }, []);
    useWebSocketCallback(conn, WebConsoleProtocol.failed, (message: string) => {
        setStatus({ kind: "failed", message });
        setQuestions([]);
        propsRef.current.onFailed?.(message);
    }, []);

    React.useEffect(() => {
        if (conn == undefined)
            return;

        if (conn.state == "Connected" && !started.current) {
            started.current = true;
            setStatus({ kind: "running" });
            void conn.send(WebConsoleProtocol.start, p.command, p.args ?? null);
        } else if (conn.state != "Connected" && started.current) {
            setStatus(s => {
                if (s.kind != "running")
                    return s;
                const message = "The connection to the server was lost";
                propsRef.current.onFailed?.(message);
                return { kind: "failed", message };
            });
            conn.stop();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conn, conn?.state]);

    React.useLayoutEffect(() => {
        const log = logRef.current;
        if (log != null)
            log.scrollTop = log.scrollHeight;
    }, [lines, questions]);

    function answer(q: WebConsoleQuestion, value: WebConsoleAnswer, echo: string) {
        append(`${q.question} `, "white", false);
        append(echo, "cyan", true);
        setQuestions(qs => qs.filter(a => a.id != q.id));
        void conn?.send(WebConsoleProtocol.answer, q.id, value);
    }

    function cancel() {
        void conn?.send(WebConsoleProtocol.cancel);
    }

    const current = questions[0];

    return (
        <div className="sf-web-console">
            <div className="sf-web-console-log" ref={logRef}>
                {lines.map((line, i) => (
                    <div key={i} className="sf-web-console-line">
                        {line.length == 0 ? " " : line.map((s, j) => (
                            <span key={j} className={s.color ? `sf-wc-${s.color}` : undefined}>{s.text}</span>
                        ))}
                    </div>
                ))}
            </div>

            {current != null && status.kind == "running" &&
                <QuestionForm key={current.id} question={current} onAnswer={(v, echo) => answer(current, v, echo)} />}

            <div className="sf-web-console-status flex items-center gap-2">
                {status.kind == "connecting" && <span className="text-muted-foreground">{WebConsoleMessage.Connecting.niceToString()}</span>}
                {status.kind == "running" && <>
                    <span className="sf-spinner-border sf-spinner-border-sm" role="status" />
                    <span>{current != null ? WebConsoleMessage.WaitingForAnswer.niceToString() : WebConsoleMessage.Running.niceToString()}</span>
                    <button type="button" className="sf-btn sf-btn-sm sf-btn-outline-secondary ms-auto" onClick={cancel}>
                        {JavascriptMessage.cancel.niceToString()}
                    </button>
                </>}
                {status.kind == "finished" && <span className="text-success">{WebConsoleMessage.Finished.niceToString()}</span>}
                {status.kind == "failed" && <span className="text-destructive">{WebConsoleMessage.Failed.niceToString()}: {status.message}</span>}
            </div>
        </div>
    );
}

function QuestionForm(p: { question: WebConsoleQuestion; onAnswer: (value: WebConsoleAnswer, echo: string) => void }): React.ReactElement {
    const q = p.question;
    const [always, setAlways] = React.useState(false);
    const [text, setText] = React.useState("");

    const yes = JavascriptMessage.yes.niceToString();
    const no = JavascriptMessage.no.niceToString();

    const alwaysCheck = (
        <label className="sf-form-check sf-form-check sf-form-check-inline ms-2 mb-0">
            <input type="checkbox" className="sf-form-check-input" checked={always} onChange={e => setAlways(e.currentTarget.checked)} />
            <span className="sf-form-check-label">{WebConsoleMessage.Always.niceToString()}</span>
        </label>
    );

    const echoAlways = (s: string) => always ? `${s} (!)` : s;

    return (
        <div className="sf-web-console-question">
            <div className="font-semibold mb-2" style={{ whiteSpace: "pre-wrap" }}>{q.question}</div>
            {(() => {
                switch (q.kind) {
                    case "yesNo":
                        return (
                            <div className="flex gap-2">
                                <button type="button" className="sf-btn sf-btn-sm sf-btn-primary" onClick={() => p.onAnswer(true, yes)}>{yes}</button>
                                <button type="button" className="sf-btn sf-btn-sm sf-btn-secondary" autoFocus onClick={() => p.onAnswer(false, no)}>{no}</button>
                            </div>
                        );
                    case "yesNoAlways":
                        return (
                            <div className="flex gap-2 items-center">
                                <button type="button" className={q.defaultYes ? "sf-btn sf-btn-sm sf-btn-primary" : "sf-btn sf-btn-sm sf-btn-outline-primary"} autoFocus={q.defaultYes}
                                    onClick={() => p.onAnswer({ yes: true, always }, echoAlways(yes))}>{yes}</button>
                                <button type="button" className={!q.defaultYes ? "sf-btn sf-btn-sm sf-btn-primary" : "sf-btn sf-btn-sm sf-btn-outline-primary"} autoFocus={!q.defaultYes}
                                    onClick={() => p.onAnswer({ yes: false, always }, echoAlways(no))}>{no}</button>
                                {alwaysCheck}
                            </div>
                        );
                    case "options":
                        return (
                            <div className="flex gap-2 flex-wrap">
                                {q.options.map((o, i) => (
                                    <button key={o} type="button" className={i == 0 ? "sf-btn sf-btn-sm sf-btn-primary" : "sf-btn sf-btn-sm sf-btn-outline-primary"} autoFocus={i == 0}
                                        onClick={() => p.onAnswer(o, o)}>{o}</button>
                                ))}
                            </div>
                        );
                    case "text":
                        return (
                            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); p.onAnswer(text, text); }}>
                                <input type="text" className="sf-form-control sf-form-control-sm" autoFocus value={text} onChange={e => setText(e.currentTarget.value)} />
                                <button type="submit" className="sf-btn sf-btn-sm sf-btn-primary">{WebConsoleMessage.Answer.niceToString()}</button>
                            </form>
                        );
                    case "select":
                        return (
                            <div>
                                <div className="sf-list-group sm:sf-list-group mb-2">
                                    {q.values.map((v, i) => (
                                        <button key={v} type="button" className="sf-list-group-item list-group-item-action py-1" autoFocus={i == 0}
                                            onClick={() => p.onAnswer({ value: v, always: false }, v)}>
                                            <code>{v}</code>
                                        </button>
                                    ))}
                                    {q.allowNone &&
                                        <button type="button" className="sf-list-group-item list-group-item-action py-1 text-muted-foreground italic"
                                            onClick={() => p.onAnswer({ value: null, always: q.allowAlways && always }, echoAlways(q.noneLabel ?? "-"))}>
                                            {q.noneLabel ?? "-"}
                                        </button>}
                                </div>
                                {q.allowNone && q.allowAlways && alwaysCheck}
                            </div>
                        );
                }
            })()}
        </div>
    );
}
