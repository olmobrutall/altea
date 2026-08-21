import "@altea/altea/server";
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { graph } from "@altea/altea/server/graphBuilder";
import { table as tableQuery } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import type { Lite } from "@altea/altea/data/lite";
import { Temporal } from "@altea/altea/data/basics";
import type { int } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { Serializer } from "@altea/altea/data/serializer";
import "@altea/altea/data/globals";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";
import {
    ChatbotMessage, ChatbotPermission, ChatMessageEntity, ChatMessageEntity_ToolCall, ChatMessageOperation,
    ChatMessageRoleEnum, ChatSessionEntity, ChatSessionOperation,
} from "../data/ChatSession";
import type { ChatbotConfigurationEmbedded, ChatbotLanguageModelEntity } from "../data/LanguageModel";
import type { AssistantMode } from "../data/ChatbotProtocol";
import { AgentLogic } from "./AgentLogic";
import { LanguageModelLogic } from "./LanguageModelLogic";
import { SkillCode } from "./SkillCode";
import type { AIToolDefinition, ChatRequestMessage, ToolCall } from "./ChatClient";
import { describeToolName } from "./Skills/IntroductionSkill";
import { DefaultAgent } from "../data/SkillCustomization";

// Port of Signum.Agent's ChatbotLogic.cs — the CHAT tables and, at its centre, `runAgentLoopAsync`: the
// generate → tool-call → generate cycle, with context-window summarization, usage accounting and titling.
//
// altea divergences, documented inline:
//  - the three `[AutoExpressionField]` computed expressions (`Messages()`, `Price()`, `TotalPrice()`) are
//    NOT registered as query expressions: `QueryLogic.Expressions.Register` from an isomorphic entity would
//    make the data layer import the server query API (the same call the scheduler and processes ports
//    declined). `price` / `totalPrice` are exposed as plain async helpers, used by the ChatSession view's
//    columns through an ordinary query instead.
//  - `Microsoft.Extensions.AI` is replaced by ./ChatClient.ts; a `ChatMessage` with a content LIST becomes
//    the flattened `ChatRequestMessage`, and `updates.ToChatResponse()` becomes `collectResponse`.
//  - `AIFunction.UnderlyingMethod.GetCustomAttribute<UIToolAttribute>()` becomes the declared
//    `tool.isUITool` (there is no method to reflect — see SkillCode.ts).
//  - the token totals are updated with a set-based UPDATE as in Signum, but through a read-then-write pair
//    rather than a `NullableAdd.Evaluate(...)` expression: altea's `executeUpdate` takes a value expression
//    per column, and a NULL-preserving addition over four columns is clearer read back than lowered.
//  - `Stopwatch` → `HeavyProfiler`-free explicit timing on `Temporal.Now`; `TimeSpan` → `Temporal.Duration`.
export namespace ChatbotLogic {

    /** Signum's `Messages(session)` expression, as a query helper. */
    export function messagesOf(session: Lite<ChatSessionEntity>): Promise<ChatMessageEntity[]> {
        return tableQuery(ChatMessageEntity).filter(a => a.chatSession.is(session)).toArray();
    }

    export function start(sb: SchemaBuilder, config: () => ChatbotConfigurationEmbedded): void {
        if (sb.alreadyDefined(start))
            return;

        LanguageModelLogic.start(sb, config);

        sb.include(ChatSessionEntity)
            .withDelete(ChatSessionOperation.Delete)
            .withQuery();

        // Signum's PreUnsafeDelete cascade: a session's messages go with it.
        sb.schema.entityEvents(ChatSessionEntity).preUnsafeDelete.push(async query => {
            // Filtered by ID, not by a lite: `Array.includes(value)` is what altea's binder lowers to an
            // `IN (…)`, whereas a `some` with a lambda over a captured array has no SQL translation.
            const ids = await query.map(a => a.id).toArray();
            if (ids.length === 0)
                return;
            await tableQuery(ChatMessageEntity).filter(m => ids.includes(m.chatSession.id)).executeDelete();
        });

        sb.include(ChatMessageEntity)
            .withIndex(a => [a.chatSession, a.creationDate])
            .withQuery();

        sb.include(ChatMessageEntity_ToolCall).withQuery();

        graph(ChatMessageEntity, g => {
            g.Delete(ChatMessageOperation.Delete, {
                canDelete: () => null, // the "must be the last message" check is async; see below
                delete: async e => {
                    const session = e.chatSession;
                    const last = await tableQuery(ChatMessageEntity)
                        .filter(a => a.chatSession.is(session))
                        .orderByDescending(a => a.creationDate)
                        .firstOrNull();
                    if (last != null && last.id !== e.id)
                        throw new Error(ChatbotMessage.MessageMustBeTheLastToDelete.niceToString());
                    await e.delete();
                },
            });
        }).register();

        // A PermissionSymbol declared with init() is seeded by PermissionAuthLogic; reaching it is enough.
        void ChatbotPermission.UseChatbot;
    }

    /** Signum's RegisterUserTypeCondition — a role sees only its own sessions. */
    export function registerUserTypeCondition(userEntities: TypeConditionSymbol): void {
        TypeConditionLogic.registerCompile(ChatSessionEntity, userEntities,
            cm => cm.user.is(UserHolder.currentUserLite() as Lite<UserEntity> | null));
        // Signum nests the condition (`cm.ChatSession.Entity.InCondition(userEntities)`); altea has no
        // `inCondition` on an entity, so the same predicate is written out one level deeper.
        TypeConditionLogic.registerCompile(ChatMessageEntity, userEntities,
            cm => cm.chatSession.entity!.user.is(UserHolder.currentUserLite() as Lite<UserEntity> | null));
    }

    /** Signum's `Price(message)` expression, in memory (see the header note on why it is not a query token). */
    export function priceOf(message: ChatMessageEntity, model: ChatbotLanguageModelEntity | null): number | null {
        if (model == null)
            return null;
        const anyPrice = model.pricePerInputToken ?? model.pricePerOutputToken
            ?? model.pricePerCachedInputToken ?? model.pricePerReasoningOutputToken;
        if (anyPrice == null)
            return null;

        const price = (tokens: number | null, perMillion: { toNumber(): number } | null): number =>
            (tokens ?? 0) * (perMillion?.toNumber() ?? 0);

        return (price(message.inputTokens, model.pricePerInputToken)
            + price(message.outputTokens, model.pricePerOutputToken)
            + price(message.cachedInputTokens, model.pricePerCachedInputToken)
            + price(message.reasoningOutputTokens, model.pricePerReasoningOutputToken)) / 1_000_000;
    }

    // ---- summarization + titling (Signum's SumarizeConversation / SumarizeTitle) -----------------

    export async function sumarizeConversation(messagesToSummarize: ChatMessageEntity[],
        languageModel: ChatbotLanguageModelEntity, signal?: AbortSignal): Promise<string> {

        const lines: string[] = [];
        for (const msg of messagesToSummarize) {
            if (msg.role === ChatMessageRoleEnum.System)
                continue;

            const roleName = msg.role === ChatMessageRoleEnum.User ? "User"
                : msg.role === ChatMessageRoleEnum.Assistant ? "Assistant"
                    : msg.role === ChatMessageRoleEnum.Tool ? `Tool(${msg.toolID ?? ""})`
                        : ChatMessageRoleEnum[msg.role];

            const content = msg.content != null ? etc(msg.content, 500) : msg.exception != null ? "[error]" : "[empty]";
            lines.push(`${roleName}: ${content}`);
        }

        const skill = await AgentLogic.getEffectiveSkillCode(DefaultAgent.ConversationSumarizer);
        return await oneShot(skill.getInstruction(lines.join("\n")), languageModel, signal);
    }

    export async function sumarizeTitle(history: ConversationHistory, signal?: AbortSignal): Promise<string> {
        const skill = await AgentLogic.getEffectiveSkillCode(DefaultAgent.QuestionSummarizer);
        return await oneShot(skill.getInstruction(history), history.languageModel, signal);
    }

    /** One prompt, no tools, no persistence — what Signum's two summarizers do with `GetResponseAsync`. */
    async function oneShot(prompt: string, languageModel: ChatbotLanguageModelEntity, signal?: AbortSignal): Promise<string> {
        const client = LanguageModelLogic.getChatClient(languageModel);
        const options = LanguageModelLogic.chatOptions(languageModel, []);
        let text = "";
        for await (const update of client.getStreamingResponse([{ role: "user", text: prompt }], options, signal))
            text += update.text ?? "";
        return text.trim();
    }

    // ---- the agent loop ------------------------------------------------------------------------

    export async function runAgentLoopAsync(history: ConversationHistory, output: IAgentOutput, signal?: AbortSignal): Promise<void> {
        const client = LanguageModelLogic.getChatClient(history.languageModel);

        while (true) {
            await summarizeIfNeeded(history, output, signal);

            const tools = history.getTools();
            const options = LanguageModelLogic.chatOptions(history.languageModel, tools);
            const messages = history.getMessages();
            LanguageModelLogic.getProvider(history.languageModel).customizeMessagesAndOptions?.(messages, options);

            const started = Temporal.Now.instant();
            let mode: AssistantMode | undefined;
            let text = "";
            let reasoning = "";
            const toolCalls: ToolCall[] = [];
            let usage: { inputTokenCount?: number; cachedInputTokenCount?: number; outputTokenCount?: number; reasoningTokenCount?: number } | undefined;

            using _prof = HeavyProfiler.log("Chatbot.Generate", () => history.languageModel.model);

            for await (const update of client.getStreamingResponse(messages, options, signal)) {
                if (update.reasoning != undefined && update.reasoning !== "") {
                    if (mode == undefined)
                        await output.onAssistantMode(undefined);
                    if (mode !== "Reasoning") {
                        await output.onAssistantMode("Reasoning");
                        mode = "Reasoning";
                    }
                    reasoning += update.reasoning;
                    await output.onChunk(update.reasoning);
                }

                if (update.text != undefined && update.text !== "") {
                    if (mode == undefined)
                        await output.onAssistantMode(undefined);
                    if (mode !== "Text") {
                        await output.onAssistantMode("Text");
                        mode = "Text";
                    }
                    text += update.text;
                    await output.onChunk(update.text);
                }

                if (update.toolCalls != undefined)
                    toolCalls.push(...update.toolCalls);

                if (update.usage != undefined)
                    usage = { ...usage, ...update.usage };
            }

            const duration = Temporal.Now.instant().since(started);

            // Signum refuses to continue on a content kind it does not model; the equivalent here is a
            // tool call naming a tool that does not exist, which is what the UI-tool check below catches.
            const uiToolCalls = toolCalls.filter(fc => {
                const tool = history.rootSkill?.findTool(fc.name);
                if (tool == undefined)
                    throw new Error(`Tool '${fc.name}' not found`);
                return tool.isUITool === true;
            });

            if (uiToolCalls.length > 1)
                throw new Error(`The LLM invoked more than one UITool in a single response (${uiToolCalls.map(t => t.name).join(", ")}). Only one UITool can be active at a time.`);

            const answer = ChatMessageEntity.create({
                chatSession: history.session,
                role: ChatMessageRoleEnum.Assistant,
                content: text === "" ? null : text,
                reasoningContent: reasoning === "" ? null : reasoning,
                languageModel: history.languageModelLite,
                inputTokens: asInt(usage?.inputTokenCount),
                cachedInputTokens: asInt(usage?.cachedInputTokenCount),
                outputTokens: asInt(usage?.outputTokenCount),
                reasoningOutputTokens: asInt(usage?.reasoningTokenCount),
                duration,
                toolCalls: toolCalls.map(fc => ChatMessageEntity_ToolCall.create({
                    toolId: fc.name,
                    callId: fc.callId,
                    arguments: JSON.stringify(fc.arguments),
                    isUITool: uiToolCalls.some(u => u.callId === fc.callId),
                })),
            });
            await answer.save();

            await addToSessionTotals(history.session, answer);

            await output.onAssistantMessage(answer);
            history.messages.push(answer);

            if (toolCalls.length === 0 || uiToolCalls.length > 0)
                break;

            for (const funCall of toolCalls)
                await executeToolAsync(history, funCall.name, funCall.callId, funCall.arguments, output, signal);
        }

        await titleIfNeeded(history, output, signal);
    }

    /**
     * Signum's in-loop context-window guard: once the last turn's input tokens pass 80% of the model's
     * budget, everything up to the last turn under 50% is replaced by a summary.
     */
    async function summarizeIfNeeded(history: ConversationHistory, output: IAgentOutput, signal?: AbortSignal): Promise<void> {
        const maxTokens = history.languageModel.maxTokens;
        if (maxTokens == null)
            return;

        const previous = history.messages.slice(1).at(-1);
        if (previous?.inputTokens == null || previous.inputTokens <= maxTokens * 0.8)
            return;

        const systemMsg = history.messages[0];
        if (systemMsg == undefined || systemMsg.role !== ChatMessageRoleEnum.System)
            throw new Error("First message is expected to be system");

        const normalMessages = history.messages.slice(1);
        const lastUnderHalf = normalMessages.map(a => a.inputTokens)
            .reduce<number>((found, tokens, i) => tokens != null && tokens < maxTokens * 0.5 ? i : found, -1);
        const toKeepIndex = lastUnderHalf >= 0 ? lastUnderHalf : normalMessages.length - 1;

        const summaryContent = await sumarizeConversation(normalMessages.slice(0, toKeepIndex), history.languageModel, signal);

        const summary = ChatMessageEntity.create({
            chatSession: history.session,
            role: ChatMessageRoleEnum.System,
            content: `## Summary of earlier conversation\n${summaryContent}\n\n---\nRecent messages follow:`,
        });
        await summary.save();

        await output.onSummarization(summary);
        history.messages = [systemMsg, summary, ...normalMessages.slice(toKeepIndex)];
    }

    /** Signum's trailing title block: an untitled (or placeholder-titled) session gets summarized once. */
    async function titleIfNeeded(history: ConversationHistory, output: IAgentOutput, signal?: AbortSignal): Promise<void> {
        const needsTitle = (t: string | null | undefined): boolean => t == null || t.startsWith("!*$");
        if (!needsTitle(history.sessionTitle))
            return;

        const stored = await tableQuery(ChatSessionEntity).filter(a => a.id == history.session.id).map(a => a.title).singleOrNull();
        history.sessionTitle = stored ?? null;
        if (!needsTitle(history.sessionTitle))
            return;

        const title = await sumarizeTitle(history, signal);
        if (title !== "" && title.toLowerCase() !== "pending") {
            await tableQuery(ChatSessionEntity).filter(a => a.id == history.session.id).executeUpdate(() => ({ title }));
            history.sessionTitle = title;
            await output.onTitleUpdated(title);
        }
    }

    /** Signum's `NullableAdd`-based UnsafeUpdate over the five session totals. */
    async function addToSessionTotals(session: Lite<ChatSessionEntity>, answer: ChatMessageEntity): Promise<void> {
        const current = await tableQuery(ChatSessionEntity).filter(a => a.id == session.id).singleOrNull();
        if (current == null)
            return;

        const add = (a: number | null, b: number | null): int | null =>
            a == null && b == null ? null : ((a ?? 0) + (b ?? 0)) as unknown as int;

        const totalInputTokens = add(current.totalInputTokens, answer.inputTokens);
        const totalCachedInputTokens = add(current.totalCachedInputTokens, answer.cachedInputTokens);
        const totalOutputTokens = add(current.totalOutputTokens, answer.outputTokens);
        const totalReasoningOutputTokens = add(current.totalReasoningOutputTokens, answer.reasoningOutputTokens);
        const totalToolCalls = ((current.totalToolCalls ?? 0) + answer.toolCalls.length) as unknown as int;

        await tableQuery(ChatSessionEntity).filter(a => a.id == session.id).executeUpdate(() => ({
            totalInputTokens,
            totalCachedInputTokens,
            totalOutputTokens,
            totalReasoningOutputTokens,
            totalToolCalls,
        }));
    }

    /** Signum's ExecuteToolAsync — run the tool, persist the result (or the failure) as a Tool message. */
    export async function executeToolAsync(history: ConversationHistory, toolId: string, callId: string,
        args: Record<string, unknown>, output: IAgentOutput, signal?: AbortSignal): Promise<void> {

        await output.onToolStart(toolId, callId);
        const started = Temporal.Now.instant();

        try {
            const tool = history.rootSkill?.findTool(toolId);
            if (tool == undefined)
                throw new Error(`Tool '${toolId}' not found`);
            if (tool.invoke == undefined)
                throw new Error(`Tool '${toolId}' is a UI tool and cannot be invoked on the server`);

            using _prof = HeavyProfiler.log("Chatbot.Tool", () => toolId);
            const result = await tool.invoke(args, signal);

            const toolMsg = ChatMessageEntity.create({
                chatSession: history.session,
                role: ChatMessageRoleEnum.Tool,
                toolCallID: callId,
                toolID: toolId,
                content: Serializer.stringify(result ?? null),
                duration: Temporal.Now.instant().since(started),
            });
            await toolMsg.save();

            await output.onToolFinished(toolMsg);
            history.messages.push(toolMsg);
        } catch (e) {
            const errorContent = formatToolError(toolId, e, args);
            // Signum wraps the failure row in AuthLogic.Disable(): the tool may have failed BECAUSE of
            // authorization, and the transcript still has to record it. `ExecutionMode.global` is altea's.
            const exception = await ExecutionMode.global(() =>
                Transaction.forceNew(() => ExceptionLogic.logException(e)));

            const toolMsg = ChatMessageEntity.create({
                chatSession: history.session,
                role: ChatMessageRoleEnum.Tool,
                toolCallID: callId,
                toolID: toolId,
                content: errorContent,
                exception: exception?.toLite() ?? null,
                duration: Temporal.Now.instant().since(started),
            });
            await ExecutionMode.global(() => toolMsg.save());

            await output.onToolFinished(toolMsg);
            history.messages.push(toolMsg);
        }
    }

    /** Signum's FormatToolError — the message the MODEL reads to correct itself. */
    export function formatToolError(toolName: string, e: unknown, args: Record<string, unknown> | undefined): string {
        const lines = [`Tool '${toolName}' failed.`];
        if (args != undefined && Object.keys(args).length > 0)
            lines.push(`Arguments: ${etc(JSON.stringify(args), 300)}`);
        lines.push(`Error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
        lines.push("Please review the error and try again with corrected arguments.");
        return lines.join("\n");
    }

    /** Signum's RunHeadlessAsync — one prompt through a full agent loop, with no HTTP in sight. */
    export async function runHeadlessAsync(prompt: string, agentKey: Parameters<typeof AgentLogic.getEffectiveSkillCode>[0],
        options?: { languageModel?: Lite<ChatbotLanguageModelEntity>; output?: IAgentOutput; signal?: AbortSignal },
    ): Promise<ConversationHistory> {

        const output = options?.output ?? nullAgentOutput;
        const modelLite = options?.languageModel ?? await LanguageModelLogic.getDefaultLanguageModel();
        if (modelLite == null)
            throw new Error("No default ChatbotLanguageModel configured.");

        const rootSkill = await AgentLogic.getEffectiveSkillCode(agentKey);

        const session = ChatSessionEntity.create({
            languageModel: modelLite,
            user: UserHolder.currentUserLite() as Lite<UserEntity>,
            startDate: Clock.now,
            totalToolCalls: 0 as unknown as int, // see ChatbotServer.getOrCreateSession
        });
        await session.save();

        const systemMsg = ChatMessageEntity.create({
            role: ChatMessageRoleEnum.System,
            chatSession: session.toLite(),
            content: rootSkill.getInstruction(null),
        });
        await systemMsg.save();
        await output.onSystemMessage(systemMsg);

        const userMsg = ChatMessageEntity.create({
            role: ChatMessageRoleEnum.User,
            chatSession: session.toLite(),
            content: prompt,
        });
        await userMsg.save();
        await output.onUserQuestion(userMsg);

        const history = new ConversationHistory(session.toLite(), modelLite,
            await LanguageModelLogic.retrieveFromCache(modelLite), rootSkill, [systemMsg, userMsg]);

        await runAgentLoopAsync(history, output, options?.signal);
        return history;
    }
}

function asInt(value: number | undefined): int | null {
    return value == undefined ? null : Math.round(value) as unknown as int;
}

function etc(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** Signum's IAgentOutput — where a turn's progress goes (an HTTP stream, or nowhere). */
export interface IAgentOutput {
    onSystemMessage(msg: ChatMessageEntity): Promise<void>;
    onUserQuestion(msg: ChatMessageEntity): Promise<void>;
    onSummarization(summaryMsg: ChatMessageEntity): Promise<void>;
    onAssistantMode(mode: AssistantMode | undefined): Promise<void>;
    onChunk(chunk: string): Promise<void>;
    onAssistantMessage(msg: ChatMessageEntity): Promise<void>;
    onToolStart(toolId: string, callId: string): Promise<void>;
    onToolFinished(toolMsg: ChatMessageEntity): Promise<void>;
    onTitleUpdated(title: string): Promise<void>;
}

/** Signum's NullAgentOutput. */
export const nullAgentOutput: IAgentOutput = {
    onSystemMessage: async () => { },
    onUserQuestion: async () => { },
    onSummarization: async () => { },
    onAssistantMode: async () => { },
    onChunk: async () => { },
    onAssistantMessage: async () => { },
    onToolStart: async () => { },
    onToolFinished: async () => { },
    onTitleUpdated: async () => { },
};

/** Signum's ConversationHistory — the live state of one turn's conversation. */
export class ConversationHistory {
    sessionTitle: string | null = null;

    constructor(
        readonly session: Lite<ChatSessionEntity>,
        readonly languageModelLite: Lite<ChatbotLanguageModelEntity>,
        readonly languageModel: ChatbotLanguageModelEntity,
        readonly rootSkill: SkillCode | undefined,
        public messages: ChatMessageEntity[],
    ) { }

    /** Signum's `GetMessages()` — the persisted rows as the provider-facing request list. */
    getMessages(): ChatRequestMessage[] {
        return this.messages.map(c => {
            const content = c.content ?? (c.exception != null ? `${c.exception.toString()}` : undefined);

            if (c.role === ChatMessageRoleEnum.Tool)
                return { role: "tool", toolCallId: c.toolCallID ?? undefined, text: content ?? "" };

            const role = c.role === ChatMessageRoleEnum.System ? "system"
                : c.role === ChatMessageRoleEnum.User ? "user" : "assistant";

            return {
                role,
                ...(content != undefined && content !== "" ? { text: content } : {}),
                ...(c.reasoningContent != null && c.reasoningContent !== "" ? { reasoning: c.reasoningContent } : {}),
                ...(c.toolCalls.length > 0
                    ? {
                        toolCalls: c.toolCalls.map(tc => ({
                            callId: tc.callId,
                            name: tc.toolId,
                            arguments: parseArgumentsSafe(tc.arguments),
                        } satisfies ToolCall)),
                    }
                    : {}),
            } satisfies ChatRequestMessage;
        });
    }

    /**
     * Signum's `GetTools()` — the eager skills' tools, PLUS anything a past `Describe` call unlocked. The
     * activation set is rebuilt from the transcript rather than held in memory, so a resumed session (a new
     * process, a new request) has exactly the tools the model already knows about.
     */
    getTools(): AIToolDefinition[] {
        if (this.rootSkill == undefined)
            return [];

        const activated = new Set([...this.rootSkill.getEagerSkillsRecursive()].map(s => s.name));

        for (const m of this.messages) {
            if (m.role !== ChatMessageRoleEnum.Assistant)
                continue;
            for (const tc of m.toolCalls) {
                if (tc.toolId !== describeToolName)
                    continue;
                try {
                    const skillName = (JSON.parse(tc.arguments) as { skillName?: string }).skillName;
                    const newSkill = skillName == undefined ? undefined : this.rootSkill.findSkill(skillName);
                    if (newSkill != undefined)
                        for (const s of newSkill.getEagerSkillsRecursive())
                            activated.add(s.name);
                } catch { /* a malformed argument unlocks nothing, as in Signum */ }
            }
        }

        return [...activated]
            .map(name => this.rootSkill!.findSkill(name))
            .filter((s): s is SkillCode => s != undefined)
            .flatMap(skill => skill.getTools());
    }
}

function parseArgumentsSafe(json: string): Record<string, unknown> {
    try {
        return JSON.parse(json) as Record<string, unknown>;
    } catch {
        return {};
    }
}
