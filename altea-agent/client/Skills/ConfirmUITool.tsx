import * as React from "react";
import type { ChatMessageEntity, ChatMessageEntity_ToolCall } from "../../data/ChatSession";
import { UITool } from "../ChatbotClient";
import ChatMarkdown from "../Templates/ChatMarkdown";

// Port of Signum.Agent's Skills/ConfirmUITool.tsx — the browser half of the server's `Confirm` UI tool: an
// inline confirmation with the buttons the model asked for. Once answered (or when replayed from history) the
// buttons freeze, with the chosen one highlighted.
interface ConfirmPayload {
    title: string;
    message: string;
    buttons: string[];
}

function ConfirmWidget(p: {
    payload: ConfirmPayload;
    onConfirm: (label: string) => void;
    /** undefined = live (waiting for the user), defined = replayed (frozen). */
    response?: ChatMessageEntity | null;
}): React.ReactElement {

    // The persisted answer is the JSON-serialized label (the tool result), so unwrap it.
    const answeredLabel: string | null = p.response?.content ? JSON.parse(p.response.content) as string : null;

    return (
        <div className="chat-ui-confirm mb-2">
            <div className="chat-bubble bot">
                <strong>{p.payload.title}</strong>
                <p className="mb-2"><ChatMarkdown content={p.payload.message} /></p>
                <div className="d-flex gap-2 flex-wrap">
                    {p.payload.buttons.map(label => (
                        <button key={label} type="button"
                            className={`btn btn-sm ${answeredLabel === label ? "btn-primary" : "btn-outline-primary"}`}
                            onClick={() => p.onConfirm(label)}
                            disabled={answeredLabel !== null}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

export class ConfirmUITool extends UITool {
    uiToolName = "Confirm";

    override renderWidget(call: ChatMessageEntity_ToolCall,
        sendToolResponse: (call: ChatMessageEntity_ToolCall, response: unknown) => void): React.ReactElement {

        const payload = JSON.parse(call.arguments) as ConfirmPayload;
        return (
            <ConfirmWidget payload={payload}
                onConfirm={label => sendToolResponse(call, label)}
                response={call._response} />
        );
    }
}
