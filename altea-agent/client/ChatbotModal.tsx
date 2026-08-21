import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPaperPlane, faStop } from "@fortawesome/free-solid-svg-icons";
import { Finder } from "@altea/altea/client/Finder";
import { ServiceError } from "@altea/altea/client/Services";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { ExceptionEntity } from "@altea/altea/data/exception";
import type { Lite } from "@altea/altea/data/lite";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import {
    ChatbotMessage, ChatMessageEntity, ChatMessageEntity_ToolCall, ChatMessageRoleEnum, ChatSessionEntity,
} from "../data/ChatSession";
import type { ChatbotUICommand } from "../data/ChatbotProtocol";
import { ChatbotClient } from "./ChatbotClient";
import { Message } from "./Message";
import "./ChatbotModal.css";

// Port of Signum.Agent's ChatbotModal.tsx — the chat panel: it parses the `$!Command` stream into live
// messages, pairs tool results with their calls, drives UI tools, and offers RECOVERY when a session was
// interrupted mid-tool.
//
// altea divergences:
//  - `newMListElement(ToolCallEmbedded.New({…}))` → `ChatMessageEntity_ToolCall.create({…})` pushed straight
//    onto the array (altea has no MList wrapper), and `.toolCalls.map(a => a.element)` collapses accordingly.
//  - `newLite(Type, id, toStr)` → `Type.newLite(id, toStr)`; `getToString(x)` → `x.toString()`.
//  - `ChatMessageEntity.New({ modified: false, isNew: false, … })` → `create({…})` plus an explicit
//    `id`/`isNew` assignment where the stream finalizes a message: altea tracks modification from a
//    SNAPSHOT, so there is no `modified` flag to clear.
//  - `ChatSessionEntity.findOptions(token => …)` keeps Signum's shape; the filter token is rootless.

interface MessageCount {
    msg: ChatMessageEntity;
    toolResponses: number;
}

type RecoverKind =
    | { kind: "uitool-direct"; toolCall: ChatMessageEntity_ToolCall }
    | { kind: "uitool-widget"; toolCall: ChatMessageEntity_ToolCall }
    | { kind: "tool"; toolCall: ChatMessageEntity_ToolCall }
    | { kind: "continue" };

/** Signum's getRecoverState — what, if anything, this session was interrupted in the middle of. */
function getRecoverState(messages: MessageCount[]): RecoverKind | null {
    const last = messages.at(-1)?.msg;
    if (last == undefined)
        return null;

    if (last.role === ChatMessageRoleEnum.Assistant) {
        const pending = last.toolCalls.find(tc => tc._response == null);
        if (pending == undefined)
            return null; // every tool call has a response — the session is complete

        if (pending.isUITool) {
            const uiTool = ChatbotClient.getUITool(pending.toolId);
            return uiTool?.handleDirectly
                ? { kind: "uitool-direct", toolCall: pending }
                : { kind: "uitool-widget", toolCall: pending };
        }

        return { kind: "tool", toolCall: pending };
    }

    if (last.role === ChatMessageRoleEnum.User || last.role === ChatMessageRoleEnum.Tool)
        return { kind: "continue" };

    return null;
}

export default function ChatbotModal(p: { onClose: () => void }): React.ReactElement {

    const currentSessionRef = React.useRef<Lite<ChatSessionEntity> | null>(null);
    const messagesRef = React.useRef<MessageCount[] | undefined>([]);

    const isLoadingRef = React.useRef(false);
    const abortControllerRef = React.useRef<AbortController | null>(null);

    const answerRef = React.useRef<ChatMessageEntity | null>(null);
    const generalExceptionRef = React.useRef<{ lite: Lite<ExceptionEntity>; text: string } | null>(null);
    const questionRef = React.useRef("");
    const recoverRef = React.useRef<RecoverKind | null>(null);
    const assistantChunkTargetRef = React.useRef<"content" | "reasoning">("content");
    const forceUpdate = useForceUpdate();
    const scrollRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (scrollRef.current)
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [answerRef.current?.content?.length, messagesRef.current?.length]);

    function handleCreateNewSession(): void {
        currentSessionRef.current = null;
        messagesRef.current = [];
        answerRef.current = null;
        recoverRef.current = null;
        forceUpdate();
    }

    function handleStop(): void {
        abortControllerRef.current?.abort();
    }

    async function handleOpenSession(): Promise<void> {
        const currentUser = AuthClient.currentUser();
        const session = await Finder.find(ChatSessionEntity.findOptions(token => ({
            filterOptions: currentUser ? [token(a => a.user).filter("EqualTo", currentUser.toLite())] : [],
        })));
        if (session == null)
            return;

        currentSessionRef.current = session;
        messagesRef.current = undefined;
        recoverRef.current = null;
        forceUpdate();

        const messages = await ChatbotClient.API.getMessagesBySessionId(session.id);

        messagesRef.current = [];
        messages.forEach(a => addMessage(messagesRef.current!, a));

        const recover = getRecoverState(messagesRef.current);
        if (recover != null) {
            recoverRef.current = recover;

            // A handleDirectly UI tool needs no user interaction: answer it straight away.
            if (recover.kind === "uitool-direct") {
                const uiTool = ChatbotClient.getUITool(recover.toolCall.toolId)!;
                void uiTool.handleDirectly!(recover.toolCall, sendToolResponseDirectly);
                recoverRef.current = null;
            }
        }

        forceUpdate();
    }

    const sendToolResponseDirectly = React.useCallback(async function sendToolResponse(
        toolCall: ChatMessageEntity_ToolCall, json: unknown): Promise<void> {

        recoverRef.current = null;
        forceUpdate();

        try {
            abortControllerRef.current = new AbortController();
            const r = await ChatbotClient.API.ask(JSON.stringify(json), {
                sessionId: currentSessionRef.current?.id,
                toolId: toolCall.toolId,
                callId: toolCall.callId,
            }, abortControllerRef.current.signal).catch(handleAbort);
            if (r) await processStream(r);
        } finally {
            forceUpdate();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const sendToolResponseInteractive = React.useCallback(async function sendToolResponse(
        toolCall: ChatMessageEntity_ToolCall, json: unknown): Promise<void> {

        if (isLoadingRef.current) {
            console.error("sendToolResponse called twice");
            return;
        }

        isLoadingRef.current = true;
        recoverRef.current = null;
        forceUpdate();

        try {
            abortControllerRef.current = new AbortController();
            const r = await ChatbotClient.API.ask(JSON.stringify(json), {
                sessionId: currentSessionRef.current?.id,
                toolId: toolCall.toolId,
                callId: toolCall.callId,
            }, abortControllerRef.current.signal).catch(handleAbort);
            if (r) await processStream(r);
        } finally {
            isLoadingRef.current = false;
            forceUpdate();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function handleRecover(): Promise<void> {
        if (recoverRef.current == null)
            return;

        isLoadingRef.current = true;
        recoverRef.current = null;
        forceUpdate();

        try {
            abortControllerRef.current = new AbortController();
            const r = await ChatbotClient.API.ask("", {
                sessionId: currentSessionRef.current?.id,
                recover: true,
            }, abortControllerRef.current.signal).catch(handleAbort);
            if (r) await processStream(r);
        } finally {
            isLoadingRef.current = false;
            forceUpdate();
        }
    }

    function handleAbort(e: unknown): null {
        if ((e as DOMException | undefined)?.name === "AbortError")
            return null;
        throw e;
    }

    async function processStream(r: Response): Promise<void> {
        const reader = r.body!.getReader();

        try {
            for await (const chunk of getWordsOrCommands(reader)) {
                if (abortControllerRef.current?.signal.aborted)
                    break;

                if (!chunk)
                    continue;

                if (chunk.startsWith("$!")) {
                    const after = chunk.slice(2).trim();
                    const colon = after.indexOf(":");
                    const command = (colon < 0 ? after : after.slice(0, colon)) as ChatbotUICommand;
                    const args = colon < 0 ? undefined : after.slice(colon + 1);

                    switch (command) {
                        case "SessionId":
                            currentSessionRef.current = ChatSessionEntity.newLite(ChatSessionEntity.parseId(args!));
                            break;

                        case "SessionTitle":
                            if (currentSessionRef.current != null)
                                currentSessionRef.current = ChatSessionEntity.newLite(currentSessionRef.current.id, args ?? "");
                            break;

                        case "QuestionId": {
                            const question = ChatMessageEntity.create({
                                role: ChatMessageRoleEnum.User,
                                chatSession: currentSessionRef.current!,
                                content: questionRef.current,
                            });
                            question.id = ChatMessageEntity.parseId(args!);
                            question.isNew = false;
                            messagesRef.current!.push({ msg: question, toolResponses: 0 });
                            questionRef.current = "";
                            break;
                        }

                        case "Tool": {
                            const [toolId, callId] = splitOnce(args!, "/");
                            setAnswer(ChatMessageRoleEnum.Tool, toolId, callId);
                            break;
                        }

                        case "System":
                            setAnswer(ChatMessageRoleEnum.System);
                            break;

                        case "AssistantStarted":
                            if (!answerRef.current) setAnswer(ChatMessageRoleEnum.Assistant);
                            break;

                        case "AssistantAnswer":
                            if (!answerRef.current) setAnswer(ChatMessageRoleEnum.Assistant);
                            assistantChunkTargetRef.current = "content";
                            break;

                        case "AssistantReasoning":
                            if (!answerRef.current) setAnswer(ChatMessageRoleEnum.Assistant);
                            assistantChunkTargetRef.current = "reasoning";
                            break;

                        case "AssistantTool":
                        case "AssistantUITool": {
                            const [toolId, callId] = splitOnce(args!, "/");
                            answerRef.current!.toolCalls.push(ChatMessageEntity_ToolCall.create({
                                toolId,
                                callId,
                                arguments: "",
                                isUITool: command === "AssistantUITool",
                            }));
                            break;
                        }

                        case "Exception": {
                            const lite = ExceptionEntity.newLite(ExceptionEntity.parseId(args!), "");
                            if (answerRef.current)
                                answerRef.current.exception = lite;
                            else
                                generalExceptionRef.current = { lite, text: "" };
                            break;
                        }

                        case "MessageId": {
                            const answer = answerRef.current!;
                            answer.id = ChatMessageEntity.parseId(args!);
                            answer.isNew = false;

                            addMessage(messagesRef.current!, answer);

                            // All arguments have streamed by now, so a UI tool can be resolved.
                            const toolCall = answer.toolCalls.at(-1);
                            if (toolCall?.isUITool) {
                                const uiTool = ChatbotClient.getUITool(toolCall.toolId);
                                if (uiTool?.handleDirectly)
                                    void uiTool.handleDirectly(toolCall, sendToolResponseDirectly);
                            }

                            answerRef.current = null;
                            break;
                        }

                        default:
                            throw new Error("Unexpected UI command: " + command);
                    }
                } else {
                    const ans = answerRef.current;
                    if (ans) {
                        if (ans.toolCalls.length)
                            ans.toolCalls[ans.toolCalls.length - 1]!.arguments += chunk;
                        else if (ans.exception)
                            ans.content = (ans.content ?? "") + chunk;
                        else if (assistantChunkTargetRef.current === "reasoning")
                            ans.reasoningContent = (ans.reasoningContent ?? "") + chunk;
                        else
                            ans.content = (ans.content ?? "") + chunk;
                    } else if (generalExceptionRef.current) {
                        generalExceptionRef.current.text += chunk;
                    }
                }

                forceUpdate();
            }

            const ge = generalExceptionRef.current;
            if (ge) {
                generalExceptionRef.current = null;
                const colon = ge.text.indexOf(":");
                throw new ServiceError({
                    exceptionId: ge.lite.id!.toString(),
                    exceptionType: colon < 0 ? "Error" : ge.text.slice(0, colon),
                    exceptionMessage: colon < 0 ? ge.text : ge.text.slice(colon + 1),
                    stackTrace: null,
                    innerException: null,
                });
            }
        } catch (e) {
            if ((e as DOMException | undefined)?.name === "AbortError")
                return;
            throw e;
        } finally {
            abortControllerRef.current = null;
            forceUpdate();
        }
    }

    async function handleCreateRequest(): Promise<void> {
        if (questionRef.current.trim().length === 0)
            return;

        isLoadingRef.current = true;
        forceUpdate();

        try {
            abortControllerRef.current = new AbortController();
            const r = await ChatbotClient.API.ask(questionRef.current,
                { sessionId: currentSessionRef.current?.id }, abortControllerRef.current.signal).catch(handleAbort);
            if (r) await processStream(r);
        } finally {
            isLoadingRef.current = false;
            forceUpdate();
        }
    }

    function setAnswer(role: ChatMessageRoleEnum, toolId?: string, callId?: string): void {
        answerRef.current = ChatMessageEntity.create({
            toolID: toolId ?? null,
            toolCallID: callId ?? null,
            role,
            chatSession: currentSessionRef.current!,
            content: "",
            reasoningContent: "",
        });
    }

    const waitingForWidget = messagesRef.current?.at(-1)?.msg.toolCalls
        .some(a => a.isUITool && ChatbotClient.getUITool(a.toolId)?.renderWidget) === true;

    const showRecoverBar = recoverRef.current != null
        && (recoverRef.current.kind === "tool" || recoverRef.current.kind === "continue" || recoverRef.current.kind === "uitool-widget");

    return (
        <div className="chat-modal">
            <div className="d-flex justify-content-between p-2 border-bottom">
                <div className="d-flex gap-2">
                    <button type="button" className="btn btn-outline-secondary btn-sm" onClick={handleOpenSession}>
                        {ChatbotMessage.OpenSession.niceToString()}
                    </button>
                    {messagesRef.current && messagesRef.current.length > 0 &&
                        <button type="button" className="btn btn-outline-primary btn-sm" onClick={handleCreateNewSession}>
                            {ChatbotMessage.NewSession.niceToString()}
                        </button>}
                </div>
                <button type="button" className="btn-close" aria-label="Close" onClick={p.onClose} />
            </div>

            <h4 className="px-3 pt-2">
                <React.Suspense fallback={null}>
                    {currentSessionRef.current && ChatbotClient.Options.renderMarkdown(currentSessionRef.current.toString())}
                </React.Suspense>
            </h4>

            <div className="chat-history flex-grow-1 p-3 pt-0" ref={scrollRef}>
                {messagesRef.current?.map((a, i) =>
                    <Message key={a.msg.id ?? `live-${i}`} msg={a.msg} toolResponses={a.toolResponses}
                        sendToolResponse={sendToolResponseInteractive} />)}
                {answerRef.current &&
                    <Message msg={answerRef.current} toolResponses={0} sendToolResponse={sendToolResponseInteractive} />}
            </div>

            {showRecoverBar ? (
                <div className="alert alert-warning d-flex align-items-center justify-content-between m-2 mb-2">
                    <span>{ChatbotMessage.SessionInterruptedDoYouWantToRecover.niceToString()}</span>
                    <button type="button" className="btn btn-warning btn-sm ms-3" onClick={handleRecover} disabled={isLoadingRef.current}>
                        {ChatbotMessage.Recover.niceToString()}
                    </button>
                </div>
            ) : (
                <div className="p-2 border-top d-flex align-items-center">
                    <textarea className="form-control me-2" rows={2}
                        placeholder={waitingForWidget
                            ? ChatbotMessage.AnswerAbovePlease.niceToString()
                            : ChatbotMessage.TypeAMessage.niceToString()}
                        value={questionRef.current}
                        disabled={isLoadingRef.current || messagesRef.current == undefined || waitingForWidget}
                        onChange={e => { questionRef.current = e.currentTarget.value; forceUpdate(); }}
                        onKeyDown={e => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void handleCreateRequest();
                            }
                        }} />
                    {isLoadingRef.current ? (
                        <button type="button" className="btn btn-tertiary text-danger" onClick={handleStop} title="Stop">
                            <FontAwesomeIcon icon={faStop} />
                        </button>
                    ) : (
                        <button type="button" className="btn btn-primary" onClick={handleCreateRequest}
                            title={ChatbotMessage.Send.niceToString()} disabled={messagesRef.current == undefined}>
                            <FontAwesomeIcon icon={faPaperPlane} />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/** Signum's addMessage — a Tool row is FOLDED INTO the call it answers instead of listed on its own. */
function addMessage(list: MessageCount[], msg: ChatMessageEntity): void {
    const pair = msg.toolCallID
        ? [...list].reverse().find(a => a.msg.role === ChatMessageRoleEnum.Assistant
            && a.msg.toolCalls.some(tc => tc.callId === msg.toolCallID))
        : undefined;

    const toolCall = pair?.msg.toolCalls.find(a => a.callId === msg.toolCallID);

    if (toolCall == undefined) {
        list.push({ msg, toolResponses: 0 });
    } else {
        toolCall._response = msg;
        pair!.toolResponses++;
    }
}

function splitOnce(text: string, separator: string): [string, string] {
    const i = text.indexOf(separator);
    return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + separator.length)];
}

/**
 * Signum's getWordsOrCommands — split the stream into whole `$!Command` LINES and whatever content lies
 * between them. Content is yielded eagerly (so tokens appear as they arrive) unless the buffer starts with
 * `$!`, in which case it waits for the newline that completes the command.
 */
async function* getWordsOrCommands(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            if (buffer.length > 0)
                yield buffer;
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        while (true) {
            const newlineIndex = buffer.indexOf("\n");

            if (newlineIndex === -1) {
                if (!buffer.startsWith("$!")) {
                    yield buffer;
                    buffer = "";
                }
                break;
            }

            const line = buffer.slice(0, newlineIndex + 1);
            buffer = buffer.slice(newlineIndex + 1);
            yield line;
        }
    }
}
