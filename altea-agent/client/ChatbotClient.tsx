import * as React from "react";
import { ajaxGet, ajaxPost, wrapRequest, type AjaxOptions } from "@altea/altea/client/Services";
import { toAbsoluteUrl } from "@altea/altea/client/AppContext";
import { Finder } from "@altea/altea/client/Finder";
import { Dic } from "@altea/altea/data/globals";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import {
    ChatMessageEntity, ChatMessageEntity_ToolCall, ChatSessionEntity, UserFeedbackEnum,
} from "../data/ChatSession";
import type { SetFeedbackRequest } from "../data/ChatbotProtocol";
import { MarkdownOrJson } from "./Message";

const ChatMarkdown = React.lazy(() => import("./Templates/ChatMarkdown"));

// Port of Signum.Agent's ChatbotClient.tsx — the chat entity views, the streaming `ask` call, and the UI-TOOL
// registry (a tool the server declares but the BROWSER answers).
//
// altea divergences:
//  - `Navigator.addSettings(new EntitySettings(…))` → `cb.configure(…).withView(…)`.
//  - `AppContext.clearSettingsActions` is dropped (see AgentClient's note); `clearUITools` is exported.
//  - the `ask` call keeps Signum's shape — `wrapRequest` around a raw `fetch`, so the auth token and the
//    error filter still apply while the response stays a readable STREAM that `ajaxPost` would consume.
export namespace ChatbotClient {

    /** Signum's `Options.renderMarkdown` — replaceable, so an app can swap the renderer. */
    export const Options = {
        renderMarkdown: (markdown: string): React.JSX.Element => <ChatMarkdown content={markdown} />,
    };

    export function start(cb: ClientBuilder): void {
        cb.configure(ChatSessionEntity)
            .withView(() => import("./Templates/ChatSession"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.title),
                    token(a => a.user),
                    token(a => a.startDate),
                    token(a => a.languageModel),
                    token(a => a.totalInputTokens),
                    token(a => a.totalOutputTokens),
                    token(a => a.totalToolCalls),
                ],
            }));

        cb.configure(ChatMessageEntity)
            .withView(() => import("./Templates/ChatMessage"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.chatSession),
                    token(a => a.role),
                    token(a => a.toolID),
                    token(a => a.content),
                    token(a => a.exception),
                ],
            }));

        cb.configure(ChatMessageEntity_ToolCall).withQuerySettings();

        // A message's `content` is markdown or JSON, not a plain string — render it as such in a grid cell.
        Finder.registerPropertyFormatter(PropertyRoute.root(ChatMessageEntity).addLambda(a => a.content),
            new Finder.CellFormatter((cell: string | undefined) => cell ? <MarkdownOrJson content={cell} /> : undefined, true));
    }

    const uiToolRegistry = new Map<string, UITool>();

    export function registerUITool(tool: UITool, override = false): void {
        if (uiToolRegistry.has(tool.uiToolName) && !override)
            throw new Error(`UITool '${tool.uiToolName}' is already registered.`);
        uiToolRegistry.set(tool.uiToolName, tool);
    }

    export function getUITool(uiToolName: string): UITool | undefined {
        return uiToolRegistry.get(uiToolName);
    }

    export function clearUITools(): void {
        uiToolRegistry.clear();
    }

    export namespace API {

        export function ask(question: string,
            options: { sessionId?: string | number; callId?: string; toolId?: string; recover?: boolean },
            signal?: AbortSignal): Promise<Response> {

            const ajaxOptions: AjaxOptions = { url: "/api/chatbot/ask" };

            return wrapRequest(ajaxOptions, () => {
                const headers = {
                    Accept: "text/plain",
                    "Content-Type": "text/plain",
                    "X-Chatbot-Session-Id": options.sessionId?.toString(),
                    "X-Chatbot-UIReply-CallId": options.callId,
                    "X-Chatbot-UIReply-ToolId": options.toolId,
                    "X-Chatbot-Recover": options.recover ? "true" : undefined,
                    ...ajaxOptions.headers,
                } as Record<string, string | undefined>;

                return fetch(toAbsoluteUrl(ajaxOptions.url), {
                    method: "POST",
                    credentials: "same-origin",
                    headers: Dic.simplify(headers) as Record<string, string>,
                    cache: "no-store",
                    body: question,
                    signal,
                });
            });
        }

        export function getMessagesBySessionId(sessionId: string | number | undefined): Promise<ChatMessageEntity[]> {
            return ajaxGet({ url: `/api/chatbot/messages/${sessionId}` });
        }

        export function setFeedback(messageId: string | number, feedback: UserFeedbackEnum | null, message?: string): Promise<void> {
            return ajaxPost({ url: `/api/chatbot/feedback/${messageId}` },
                { feedback, message } satisfies SetFeedbackRequest);
        }
    }
}

/**
 * Port of Signum's `UITool` — a tool the server DECLARES but never runs (see server/Skills/ConfirmUISkill.ts).
 * Implement exactly one of:
 *  • `handleDirectly()` — resolve without showing anything (GetUIContext just reads browser state);
 *  • `renderWidget()`  — render a widget inline in the conversation and call `sendToolResponse` from it.
 */
export abstract class UITool {
    abstract uiToolName: string;

    handleDirectly?(call: ChatMessageEntity_ToolCall,
        sendToolResponse: (call: ChatMessageEntity_ToolCall, response: unknown) => void): Promise<void>;

    renderWidget?(call: ChatMessageEntity_ToolCall,
        sendToolResponse: (call: ChatMessageEntity_ToolCall, response: unknown) => void): React.ReactElement;
}
