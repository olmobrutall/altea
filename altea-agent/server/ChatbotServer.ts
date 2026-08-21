import type { Response } from "express";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { table as tableQuery } from "@altea/altea/server/table";
import * as Database from "@altea/altea/server/Database";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import type { int } from "@altea/altea/data/basics";
import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "@altea/altea-auth/data/User";
import {
    ChatMessageEntity, ChatMessageRoleEnum, ChatSessionEntity, UserFeedbackEnum,
} from "../data/ChatSession";
import type { AssistantMode, ChatbotUICommand, SetFeedbackRequest, SkillCodeInfo } from "../data/ChatbotProtocol";
import { DefaultAgent } from "../data/SkillCustomization";
import { AgentLogic } from "./AgentLogic";
import { ChatbotLogic, ConversationHistory, type IAgentOutput } from "./ChatbotLogic";
import { LanguageModelLogic } from "./LanguageModelLogic";
import { SkillCodeLogic } from "./SkillCodeLogic";

// Port of Signum.Agent's ChatbotController.cs + LanguageModelController.cs — the HTTP surface. The
// streaming FRAMING (`$!Command:payload` lines over `text/plain`) is kept verbatim, because it is the
// contract the chat modal parses; see data/ChatbotProtocol.ts.
//
// altea divergences, documented inline:
//  - the session / UI-reply / recover inputs stay REQUEST HEADERS, as in Signum, so the body remains the
//    raw question text.
//  - `Response.Body.FlushAsync()` has no Express counterpart and needs none: `res.write` on a non-buffered
//    `text/plain` response goes out immediately. `res.flushHeaders()` is called once, so the browser starts
//    reading before the first token.
//  - Signum reads the last SYSTEM message's date and everything after it in TWO queries with
//    `ExpandLite(a => a.Exception, EntityEager)`; altea has no ExpandLite, so the messages come back with a
//    thin exception lite — which is all the stream needs (the id) and all the modal renders.
//  - `Schema.Current.AssertAllowed(typeof(ChatMessageEntity), true)` is dropped: reading the session's
//    messages already goes through altea's type-READ gate on the retrieve path.
export namespace ChatbotServer {

    export function start(ws: WebBuilder): void {

        // ---- skill introspection (Signum's agentSkill routes) --------------------------------

        ws.get("/api/agentSkill/skillCodeInfo/:skillCodeName",
            { params: CustomType<{ skillCodeName: string }>(), res: CustomType<SkillCodeInfo>() },
            async (req, res) => {
                const { skillCodeName } = (req as unknown as { params: { skillCodeName: string } }).params;
                res.jsonTyped(SkillCodeLogic.getDefaultSkillCodeInfo(decodeURIComponent(skillCodeName)));
            });

        ws.get("/api/agentSkill/defaultAgentSkillCodeInfo/:agentName",
            { params: CustomType<{ agentName: string }>(), res: CustomType<SkillCodeInfo>() },
            async (req, res) => {
                const { agentName } = (req as unknown as { params: { agentName: string } }).params;
                const factory = AgentLogic.factoryFor(decodeURIComponent(agentName));
                if (factory == undefined)
                    throw new Error(`Agent '${agentName}' is not registered.`);
                res.jsonTyped(SkillCodeLogic.getDefaultSkillCodeInfo(factory()));
            });

        // ---- provider model catalogues (Signum's LanguageModelController) --------------------

        ws.get("/api/chatbot/provider/:providerKey/models",
            { params: CustomType<{ providerKey: string }>(), res: CustomType<string[]>() },
            async (req, res) => {
                const { providerKey } = (req as unknown as { params: { providerKey: string } }).params;
                const names = await LanguageModelLogic.getModelNames(decodeURIComponent(providerKey));
                res.jsonTyped(names.sort());
            });

        ws.get("/api/chatbot/provider/:providerKey/embeddingModels",
            { params: CustomType<{ providerKey: string }>(), res: CustomType<string[]>() },
            async (req, res) => {
                const { providerKey } = (req as unknown as { params: { providerKey: string } }).params;
                const names = await LanguageModelLogic.getEmbeddingModelNames(decodeURIComponent(providerKey));
                res.jsonTyped(names.sort());
            });

        // ---- transcript + feedback ------------------------------------------------------------

        ws.get("/api/chatbot/messages/:sessionID",
            { params: CustomType<{ sessionID: string }>(), res: CustomType<ChatMessageEntity[]>() },
            async (req, res) => {
                const { sessionID } = (req as unknown as { params: { sessionID: string } }).params;
                const id = ChatSessionEntity.parseId(sessionID);
                const messages = await tableQuery(ChatMessageEntity)
                    .filter(m => m.chatSession.id == id)
                    .orderBy(m => m.creationDate)
                    .toArray();
                res.jsonTyped(messages);
            });

        ws.post("/api/chatbot/feedback/:messageId",
            { params: CustomType<{ messageId: string }>(), req: CustomType<SetFeedbackRequest>() },
            async (req, res) => {
                const { messageId } = (req as unknown as { params: { messageId: string } }).params;
                const request = await req.jsonTyped() as SetFeedbackRequest;

                const message = await Database.retrieve(ChatMessageEntity, ChatMessageEntity.parseId(messageId));
                if (message.role !== ChatMessageRoleEnum.Assistant)
                    throw new Error("Feedback can only be set on Assistant messages.");

                message.userFeedback = request.feedback;
                message.userFeedbackMessage = request.feedback === UserFeedbackEnum.Negative ? (request.message ?? null) : null;
                await message.save();
                res.status(204).end();
            });

        // ---- the streaming turn (Signum's AskQuestionAsync) ----------------------------------

        ws.post("/api/chatbot/ask", { req: CustomType<string>() }, async (req, res) => {
            const raw = req as unknown as {
                headers: Record<string, string | string[] | undefined>;
                body?: string;
                on(event: "close", listener: () => void): void;
            };
            const response = res as unknown as Response;

            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            // Without this the first tokens sit in the response buffer until something else forces a write,
            // which for a slow first token looks like a hung request.
            response.flushHeaders();

            // The client aborts the fetch on Stop; propagate that into the provider call and the loop.
            const abort = new AbortController();
            raw.on("close", () => abort.abort());

            const output = new HttpAgentOutput(response);

            try {
                const sessionID = header(raw.headers, "x-chatbot-session-id");
                const question = raw.body ?? "";

                const isNewSession = sessionID == undefined || sessionID === "" || sessionID === "undefined";
                const session = await getOrCreateSession(isNewSession ? undefined : sessionID);

                let history: ConversationHistory;

                if (isNewSession) {
                    write(response, output.notification("SessionId", String(session.id)));
                    history = await createNewConversationHistory(session);
                    await output.onSystemMessage(history.messages[0]!);
                } else {
                    history = await resumeConversationHistory(session);
                }

                const uiReplyCallId = header(raw.headers, "x-chatbot-uireply-callid");
                const uiReplyToolId = header(raw.headers, "x-chatbot-uireply-toolid");
                const isRecover = header(raw.headers, "x-chatbot-recover") === "true";

                if (uiReplyCallId != undefined && uiReplyToolId != undefined) {
                    // The browser answered a UI tool: persist its reply as the Tool message and echo it back
                    // so the modal shows the same thing a server-run tool would have shown.
                    const toolMsg = ChatMessageEntity.create({
                        chatSession: session.toLite(),
                        role: ChatMessageRoleEnum.Tool,
                        toolCallID: uiReplyCallId,
                        toolID: uiReplyToolId,
                        content: question,
                    });
                    await toolMsg.save();

                    write(response, output.notification("Tool", `${uiReplyToolId}/${uiReplyCallId}`));
                    write(response, question);
                    write(response, "\n");
                    write(response, output.notification("MessageId", String(toolMsg.id)));
                    history.messages.push(toolMsg);
                } else if (isRecover) {
                    if (question !== "")
                        throw new Error("Recover requests must have an empty body.");

                    const lastAssistant = [...history.messages].reverse().find(m => m.role === ChatMessageRoleEnum.Assistant);
                    const pending = lastAssistant?.toolCalls.find(tc => !tc.isUITool
                        && !history.messages.some(m => m.role === ChatMessageRoleEnum.Tool && m.toolCallID === tc.callId));

                    if (pending != undefined) {
                        const parsedArgs = safeParse(pending.arguments);
                        await ChatbotLogic.executeToolAsync(history, pending.toolId, pending.callId, parsedArgs, output, abort.signal);
                    }
                } else {
                    const userQuestion = ChatMessageEntity.create({
                        chatSession: session.toLite(),
                        role: ChatMessageRoleEnum.User,
                        content: question,
                    });
                    await userQuestion.save();
                    history.messages.push(userQuestion);
                    await output.onUserQuestion(userQuestion);
                }

                await ChatbotLogic.runAgentLoopAsync(history, output, abort.signal);
                response.end();
            } catch (e) {
                // Signum's catch-all: log it, stream the id + the message, and end cleanly — the modal turns
                // the pair into a ServiceError, so a mid-stream failure still surfaces with a real exception.
                const exception = await ExecutionMode.global(() =>
                    Transaction.forceNew(() => ExceptionLogic.logException(e)));

                write(response, output.notification("Exception", String(exception?.id ?? "")));
                write(response, `${e instanceof Error ? e.name : "Error"}:${e instanceof Error ? e.message : String(e)}`);
                write(response, "\n");
                response.end();
            }
        });
    }

    async function getOrCreateSession(sessionID: string | undefined): Promise<ChatSessionEntity> {
        if (sessionID != undefined)
            return await Database.retrieve(ChatSessionEntity, ChatSessionEntity.parseId(sessionID));

        const modelLite = await LanguageModelLogic.getDefaultLanguageModel();
        if (modelLite == null)
            throw new Error("No default ChatbotLanguageModel");

        const session = ChatSessionEntity.create({
            languageModel: modelLite,
            user: UserHolder.currentUserLite() as Lite<UserEntity>,
            startDate: Clock.now,
            title: null,
            // Explicit, not a field initializer: a non-nullable field must be SET by whoever creates the row
            // (altea's implicit NotNull rejects undefined), and C#'s int gives Signum this 0 for free.
            totalToolCalls: 0 as unknown as int,
        });
        await session.save();
        return session;
    }

    async function createNewConversationHistory(session: ChatSessionEntity): Promise<ConversationHistory> {
        const rootSkill = await AgentLogic.getEffectiveSkillCode(DefaultAgent.Chatbot);

        const systemMsg = ChatMessageEntity.create({
            role: ChatMessageRoleEnum.System,
            chatSession: session.toLite(),
            content: rootSkill.getInstruction(null),
        });
        await systemMsg.save();

        const history = new ConversationHistory(session.toLite(), session.languageModel,
            await LanguageModelLogic.retrieveFromCache(session.languageModel), rootSkill, [systemMsg]);
        history.sessionTitle = session.title;
        return history;
    }

    /**
     * Signum's else-branch: replay the SYSTEM messages (the original prompt plus every summary) and only the
     * ordinary messages that came after the LAST of them — everything before it is covered by that summary.
     */
    async function resumeConversationHistory(session: ChatSessionEntity): Promise<ConversationHistory> {
        const sessionLite = session.toLite();

        const all = await ExecutionMode.global(() => tableQuery(ChatMessageEntity)
            .filter(c => c.chatSession.is(sessionLite))
            .orderBy(c => c.creationDate)
            .toArray());

        const systemAndSummaries = all.filter(a => a.role === ChatMessageRoleEnum.System);
        const lastSystem = systemAndSummaries.at(-1);
        const remaining = all.filter(a => a.role !== ChatMessageRoleEnum.System
            && (lastSystem == undefined || Temporal.PlainDateTime.compare(a.creationDate, lastSystem.creationDate) > 0));

        const history = new ConversationHistory(sessionLite, session.languageModel,
            await LanguageModelLogic.retrieveFromCache(session.languageModel),
            await AgentLogic.getEffectiveSkillCode(DefaultAgent.Chatbot),
            [...systemAndSummaries, ...remaining]);
        history.sessionTitle = session.title;
        return history;
    }
}



function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const value = headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return single == undefined || single === "" ? undefined : single;
}

function write(response: Response, text: string): void {
    response.write(text);
}

function safeParse(json: string): Record<string, unknown> {
    try {
        return JSON.parse(json) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** Port of Signum's HttpAgentOutput — the agent loop's progress, as the `$!Command` stream. */
export class HttpAgentOutput implements IAgentOutput {

    constructor(private readonly response: Response) { }

    notification(cmd: ChatbotUICommand, payload?: string): string {
        if (payload == undefined)
            return `$!${cmd}\n`;
        if (payload.includes("\n"))
            throw new Error("Payload has newlines!");
        return `$!${cmd}:${payload}\n`;
    }

    async onSystemMessage(msg: ChatMessageEntity): Promise<void> {
        this.response.write(this.notification("System"));
        this.response.write(msg.content ?? "");
        this.response.write("\n");
        this.response.write(this.notification("MessageId", String(msg.id)));
    }

    async onUserQuestion(msg: ChatMessageEntity): Promise<void> {
        this.response.write(this.notification("QuestionId", String(msg.id)));
    }

    async onSummarization(msg: ChatMessageEntity): Promise<void> {
        this.response.write(this.notification("System"));
        this.response.write(msg.content ?? "");
        this.response.write("\n");
        this.response.write(this.notification("MessageId", String(msg.id)));
    }

    async onAssistantMode(mode: AssistantMode | undefined): Promise<void> {
        const cmd: ChatbotUICommand = mode == undefined ? "AssistantStarted"
            : mode === "Text" ? "AssistantAnswer" : "AssistantReasoning";
        this.response.write(this.notification(cmd));
    }

    async onChunk(chunk: string): Promise<void> {
        this.response.write(chunk);
    }

    async onAssistantMessage(msg: ChatMessageEntity): Promise<void> {
        for (const item of msg.toolCalls) {
            this.response.write("\n");
            this.response.write(this.notification(item.isUITool ? "AssistantUITool" : "AssistantTool",
                `${item.toolId}/${item.callId}`));
            this.response.write(item.arguments);
        }
        this.response.write("\n");
        this.response.write(this.notification("MessageId", String(msg.id)));
    }

    async onToolStart(toolId: string, callId: string): Promise<void> {
        this.response.write(this.notification("Tool", `${toolId}/${callId}`));
    }

    async onToolFinished(toolMsg: ChatMessageEntity): Promise<void> {
        if (toolMsg.exception != null)
            this.response.write(this.notification("Exception", String(toolMsg.exception.id)));

        this.response.write(toolMsg.content ?? "");
        this.response.write("\n");
        this.response.write(this.notification("MessageId", String(toolMsg.id)));
    }

    async onTitleUpdated(title: string): Promise<void> {
        this.response.write(this.notification("SessionTitle", title));
    }
}
