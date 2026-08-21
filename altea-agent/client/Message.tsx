import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { classes } from "@altea/altea/data/globals";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { ChatbotMessage, ChatMessageEntity, ChatMessageEntity_ToolCall, ChatMessageRoleEnum, UserFeedbackEnum } from "../data/ChatSession";
import { ChatbotClient } from "./ChatbotClient";
import FeedbackModal from "./FeedbackModal";

// Port of Signum.Agent's Message.tsx — one conversation turn, per role, plus the collapsible tool blocks and
// the thumbs-up/down feedback.
//
// altea divergences:
//  - `AutoLineModal.show({ propertyRoute, … })` is not ported (altea has no AutoLineModal), so the negative
//    feedback note is captured by the small `FeedbackModal` in this module.
//  - `p.msg.toolCalls` is a plain array of `@part` rows (altea has no MList), so `.map(tc => tc.element)`
//    collapses to `.map(tc => tc)`.
//  - `getToString(x)` → `x.toString()`.

type SendToolResponse = (call: ChatMessageEntity_ToolCall, response: unknown) => void;

export const Message: React.NamedExoticComponent<{
    msg: ChatMessageEntity; toolResponses: number; sendToolResponse: SendToolResponse;
}> = React.memo(function Message(p: {
    msg: ChatMessageEntity; toolResponses: number; sendToolResponse: SendToolResponse;
}): React.ReactElement {

    const role =
        p.msg.role === ChatMessageRoleEnum.System ? <SystemMessage msg={p.msg} /> :
            p.msg.role === ChatMessageRoleEnum.User ? <UserMessage msg={p.msg} /> :
                p.msg.role === ChatMessageRoleEnum.Assistant ? <AssistantMessage msg={p.msg} sendToolResponse={p.sendToolResponse} /> :
                    p.msg.role === ChatMessageRoleEnum.Tool ? <ToolMessage msg={p.msg} /> :
                        null;

    return <ErrorBoundary>{role}</ErrorBoundary>;
    // Signum's memo comparator: a FINALIZED message (it has an id) only re-renders when its tool-response
    // count changed. A streaming message (no id yet) always re-renders.
}, (a, b) => a.msg.id != undefined && a.toolResponses === b.toolResponses);

export function looksLikeJson(text: string | null | undefined): boolean {
    return text != undefined && (text.trim().startsWith("{") || text.trim().startsWith("["));
}

export function SystemMessage(p: { msg: ChatMessageEntity }): React.ReactElement {
    const [isOpen, setIsOpen] = React.useState(false);

    return (
        <div className="mb-2 justify-content-start">
            <a className="chat-internal" href="#" onClick={e => { e.preventDefault(); setIsOpen(!isOpen); }}>
                <FontAwesomeIcon icon="book" /> {ChatbotMessage.InitialInstruction.niceToString()}
            </a>
            {isOpen &&
                <div className="chat-bubble system">
                    <React.Suspense fallback={null}>
                        {ChatbotClient.Options.renderMarkdown(p.msg.content ?? "")}
                    </React.Suspense>
                </div>}
        </div>
    );
}

export function AssistantMessage(p: { msg: ChatMessageEntity; sendToolResponse: SendToolResponse }): React.ReactElement {
    const forceUpdate = useForceUpdate();
    const [isReasoningOpen, setIsReasoningOpen] = React.useState(false);

    const isFinalized = p.msg.id != undefined;

    async function handleThumbsUp(): Promise<void> {
        if (!isFinalized)
            return;

        const next = p.msg.userFeedback === UserFeedbackEnum.Positive ? null : UserFeedbackEnum.Positive;
        await ChatbotClient.API.setFeedback(p.msg.id!, next);
        p.msg.userFeedback = next;
        p.msg.userFeedbackMessage = null;
        forceUpdate();
    }

    async function handleThumbsDown(): Promise<void> {
        if (!isFinalized)
            return;

        if (p.msg.userFeedback === UserFeedbackEnum.Negative) {
            await ChatbotClient.API.setFeedback(p.msg.id!, null);
            p.msg.userFeedback = null;
            p.msg.userFeedbackMessage = null;
            forceUpdate();
        } else {
            await openFeedbackModal();
        }
    }

    async function openFeedbackModal(): Promise<void> {
        const newMessage = await FeedbackModal.show(p.msg.userFeedbackMessage ?? "");
        if (newMessage === undefined)
            return;

        await ChatbotClient.API.setFeedback(p.msg.id!, UserFeedbackEnum.Negative, newMessage || undefined);
        p.msg.userFeedback = UserFeedbackEnum.Negative;
        p.msg.userFeedbackMessage = newMessage || null;
        forceUpdate();
    }

    return (
        <div className="mb-2 justify-content-start">
            {p.msg.reasoningContent && <div className="chat-reasoning mt-1">
                <a className="chat-internal" href="#" onClick={e => { e.preventDefault(); setIsReasoningOpen(!isReasoningOpen); }}>
                    <FontAwesomeIcon icon="brain" /> {ChatbotMessage.Reasoning.niceToString()}
                </a>
                {isReasoningOpen && <div className="chat-bubble reasoning mt-1">
                    <React.Suspense fallback={null}>
                        {ChatbotClient.Options.renderMarkdown(p.msg.reasoningContent)}
                    </React.Suspense>
                </div>}
            </div>}

            {p.msg.content && <React.Suspense fallback={null}>
                {ChatbotClient.Options.renderMarkdown(p.msg.content)}
            </React.Suspense>}

            {p.msg.toolCalls.map((tc, i) => <ToolCall key={i} toolCall={tc} sendToolResponse={p.sendToolResponse} />)}

            {isFinalized && p.msg.toolCalls.length === 0 && (
                <div className="chat-feedback-buttons">
                    <button type="button"
                        className={classes("btn btn-link btn-sm chat-feedback-btn",
                            p.msg.userFeedback === UserFeedbackEnum.Positive ? "chat-feedback-active-positive" : undefined)}
                        onClick={handleThumbsUp} title="Good response">
                        <FontAwesomeIcon icon="thumbs-up" />
                    </button>
                    <button type="button"
                        className={classes("btn btn-link btn-sm chat-feedback-btn",
                            p.msg.userFeedback === UserFeedbackEnum.Negative ? "chat-feedback-active-negative" : undefined)}
                        onClick={handleThumbsDown} title="Bad response">
                        <FontAwesomeIcon icon="thumbs-down" />
                    </button>
                    {p.msg.userFeedback === UserFeedbackEnum.Negative && (
                        <button type="button" className="btn btn-link btn-sm chat-feedback-btn chat-feedback-edit"
                            onClick={openFeedbackModal} title={ChatbotMessage.ProvideFeedback.niceToString()}>
                            <FontAwesomeIcon icon="pen" />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

function ToolCall(p: { toolCall: ChatMessageEntity_ToolCall; sendToolResponse: SendToolResponse }): React.ReactElement {
    const [isOpen, setIsOpen] = React.useState(false);
    const isJson = looksLikeJson(p.toolCall.arguments);
    const [formatJson, setFormatJson] = React.useState(false);

    const response = p.toolCall._response;

    // A UI tool with a widget is shown INLINE instead of as a collapsible tool block.
    if (p.toolCall.isUITool) {
        const tool = ChatbotClient.getUITool(p.toolCall.toolId);
        if (tool?.renderWidget)
            return tool.renderWidget(p.toolCall, p.sendToolResponse);
    }

    return (
        <div className="mb-2 justify-content-start">
            <a className="chat-internal" href="#" onClick={e => { e.preventDefault(); setIsOpen(!isOpen); }}>
                <FontAwesomeIcon icon="hammer" /> {p.toolCall.toolId}
                {p.toolCall._response?.exception && <FontAwesomeIcon icon="bug" color="red" />}
            </a>
            {isOpen &&
                <div>
                    <h4 className="chatbot-request">Request {isJson && !formatJson &&
                        <button type="button" className="btn btn-sm btn-link" onClick={() => setFormatJson(!formatJson)}>
                            <FontAwesomeIcon icon="code" /> Format JSON
                        </button>}</h4>
                    <div className="chat-bubble tool-request">
                        <FormatJson code={p.toolCall.arguments} formatJson={formatJson} className="mb-0" />
                    </div>
                    {response && <ToolResponseBlock msg={response} />}
                </div>}
        </div>
    );
}

export function ToolResponseBlock(p: { msg: ChatMessageEntity }): React.ReactElement {
    const isJson = looksLikeJson(p.msg.content);
    const [formatJson, setFormatJson] = React.useState(false);

    return (
        <div>
            <h4 className="chatbot-response">Response {isJson && !formatJson &&
                <button type="button" className="btn btn-sm btn-link" onClick={() => setFormatJson(!formatJson)}>
                    <FontAwesomeIcon icon="code" /> Format JSON
                </button>}</h4>
            <div className="chat-bubble tool-response">
                {p.msg.exception
                    ? <pre className="text-danger">{p.msg.exception.toString()}</pre>
                    : <MarkdownOrJson content={p.msg.content} formatJson={formatJson} />}
            </div>
        </div>
    );
}

export function MarkdownOrJson(p: { content: string | null | undefined; formatJson?: boolean }): React.JSX.Element {
    if (!p.content)
        return <span className="text-muted">{String(p.content)}</span>;

    if (looksLikeJson(p.content))
        return <FormatJson code={p.content} formatJson={p.formatJson ?? true} className="mb-0" />;

    return (
        <React.Suspense fallback={null}>
            {ChatbotClient.Options.renderMarkdown(tryParseJsonString(p.content))}
        </React.Suspense>
    );
}

/** A tool result is `JSON.stringify(value)`, so a string result arrives quoted; unwrap it for display. */
export function tryParseJsonString(str: string): string {
    try {
        if (str.startsWith("\"") && str.endsWith("\""))
            return JSON.parse(str) as string;
        return str;
    } catch {
        return str;
    }
}

export function FormatJson({ code, formatJson, ...rest }: {
    code: string | undefined | null; formatJson: boolean;
} & React.HTMLAttributes<HTMLDivElement>): React.ReactElement {

    const formattedJson = React.useMemo(() => {
        if (!formatJson || code == undefined)
            return null;

        try {
            const obj = JSON.parse(code) as Record<string, unknown>;
            // Useful when the json is double serialized (a tool result inside a tool result).
            const unwrapped = Object.fromEntries(Object.entries(obj).map(([key, value]) =>
                typeof value === "string" && looksLikeJson(value) ? [key, JSON.parse(value)] : [key, value]));
            return JSON.stringify(unwrapped, undefined, 2);
        } catch {
            return "Invalid Json";
        }
    }, [formatJson, code]);

    return (
        <div {...rest}>
            <pre style={{ whiteSpace: "pre-wrap" }}>
                <code>{formatJson ? formattedJson : code}</code>
            </pre>
        </div>
    );
}

export function ToolMessage(p: { msg: ChatMessageEntity }): React.ReactElement {
    const [isOpen, setIsOpen] = React.useState(false);

    return (
        <div className="mb-2 justify-content-start">
            <a className="chat-internal" href="#" onClick={e => { e.preventDefault(); setIsOpen(!isOpen); }}>
                <FontAwesomeIcon icon="hammer" className="red" /> Response {p.msg.toolID}
            </a>
            {isOpen && <ToolResponseBlock msg={p.msg} />}
        </div>
    );
}

export function UserMessage(p: { msg: ChatMessageEntity }): React.ReactElement {
    return (
        <div className="mb-2 d-flex justify-content-end">
            <div className="chat-bubble user">
                <React.Suspense fallback={null}>
                    {ChatbotClient.Options.renderMarkdown(p.msg.content ?? "")}
                </React.Suspense>
            </div>
        </div>
    );
}
