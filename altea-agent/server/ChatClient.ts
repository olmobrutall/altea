// NEW in altea — the replacement for **`Microsoft.Extensions.AI`**, the .NET abstraction Signum.Agent is
// written against (`IChatClient`, `ChatMessage`, `AIContent`, `ChatOptions`, `AITool`, `ChatResponseUpdate`,
// `AIFunctionFactory`). There is no JavaScript counterpart: each vendor ships its own SDK with its own
// types, and nothing unifies them. So the module declares the SLICE of that abstraction Signum's agent loop
// actually uses, and each provider implements it (see Providers/).
//
// What the slice covers, and nothing more:
//   - a message list of four roles, where an assistant turn may carry TEXT, REASONING and TOOL CALLS at
//     once, and a tool turn carries one result keyed by call id;
//   - STREAMING generation, because the chat UI echoes tokens as they arrive;
//   - TOOL declarations as JSON Schema (see the note on `AIToolDefinition`);
//   - a usage report (the four token counts ChatMessageEntity stores).
//
// What it deliberately does NOT cover: embeddings generation as a client (it is a one-shot call, so
// `IEmbeddingsProvider.getEmbeddings` returns arrays directly, as in Signum), images / audio content,
// `RawRepresentationFactory` (a provider that needs a vendor-specific wire tweak does it inside its own
// request builder — see AnthropicProvider's prompt caching and DeepSeekProvider's reasoning echo), and
// automatic function invocation (Signum drives the tool loop itself, and so does altea).

import type { ChatbotLanguageModelEntity, EmbeddingsLanguageModelEntity } from "../data/LanguageModel";

/** `Microsoft.Extensions.AI.ChatRole`. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A tool call the model asked for (`FunctionCallContent`). */
export interface ToolCall {
    callId: string;
    name: string;
    /** The parsed arguments object. A provider streams these as a JSON string; the client parses. */
    arguments: Record<string, unknown>;
}

/**
 * One message in the request (`Microsoft.Extensions.AI.ChatMessage`, flattened). Signum models an
 * assistant turn as a LIST of `AIContent`; the three kinds that occur are folded into fields here,
 * because a provider request has to split them apart again anyway.
 */
export interface ChatRequestMessage {
    role: ChatRole;
    text?: string;
    /** Assistant only — the model's own chain of thought, when the provider exposes it. */
    reasoning?: string;
    /** Assistant only. */
    toolCalls?: ToolCall[];
    /** Tool only — which call this answers (`FunctionResultContent.CallId`). */
    toolCallId?: string;
}

/**
 * A tool the model may call (`AITool` / `AIFunction`).
 *
 * **The divergence that shapes every skill.** Signum builds this from a C# METHOD: `[McpServerTool]` marks
 * it, and `AIFunctionFactory.Create(delegate)` reflects the signature into a JSON Schema and binds the
 * invocation. TypeScript erases parameter types at runtime — there is no signature to reflect — so a tool
 * declares its schema EXPLICITLY and carries its own invoke. `SkillCode.registerTool` is the one place
 * that happens (see SkillCode.ts).
 */
export interface AIToolDefinition {
    name: string;
    description?: string;
    /** JSON Schema for the arguments object (`{ type: "object", properties: {…}, required: [...] }`). */
    parameters: JsonSchema;
    /** For the SkillCode editors: what the tool returns, as a display string (Signum reflects it). */
    returnType?: string;
    /**
     * Signum's `[UITool]`: the SERVER never runs the body. The controller streams the call to the browser,
     * which answers it in the next request. Such a tool has no `invoke`.
     */
    isUITool?: boolean;
    /** Signum's `[McpServerTool(Destructive = true)]` — advisory, surfaced to an MCP host. */
    destructive?: boolean;
    invoke?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/** Enough of JSON Schema to describe a tool's arguments. */
export interface JsonSchema {
    type?: string | string[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    additionalProperties?: boolean | JsonSchema;
    [key: string]: unknown;
}

/** `Microsoft.Extensions.AI.ChatOptions`, narrowed to what LanguageModelLogic.chatOptions sets. */
export interface ChatOptions {
    modelId: string;
    maxOutputTokens: number;
    temperature?: number;
    tools?: AIToolDefinition[];
}

/** `Microsoft.Extensions.AI.UsageDetails`. */
export interface ChatUsage {
    inputTokenCount?: number;
    cachedInputTokenCount?: number;
    outputTokenCount?: number;
    reasoningTokenCount?: number;
}

/**
 * One streaming delta (`ChatResponseUpdate`). Exactly one of `text` / `reasoning` / `toolCalls` / `usage`
 * is normally set; the loop folds a stream of these into a response with `collectResponse`.
 */
export interface ChatStreamUpdate {
    text?: string;
    reasoning?: string;
    /** COMPLETE tool calls only. A provider that streams argument fragments accumulates them itself. */
    toolCalls?: ToolCall[];
    usage?: ChatUsage;
}

/** The folded result of a stream (`updates.ToChatResponse()` in Signum). */
export interface ChatResponse {
    text: string;
    reasoning: string;
    toolCalls: ToolCall[];
    usage?: ChatUsage;
}

/** `Microsoft.Extensions.AI.IChatClient`, reduced to streaming generation. */
export interface IChatClient {
    getStreamingResponse(
        messages: ChatRequestMessage[],
        options: ChatOptions,
        signal?: AbortSignal,
    ): AsyncIterable<ChatStreamUpdate>;
}

/** Signum's `IChatbotModelProvider`. */
export interface IChatbotModelProvider {
    getModelNames(signal?: AbortSignal): Promise<string[]>;
    createChatClient(model: ChatbotLanguageModelEntity): IChatClient;
    /**
     * Signum's `CustomizeMessagesAndOptions` — a last chance to rewrite the request the way one vendor
     * needs it (Anthropic's cache-control on the system prompt; DeepSeek echoing `reasoning_content` back).
     * Mutates in place, exactly as in Signum.
     */
    customizeMessagesAndOptions?(messages: ChatRequestMessage[], options: ChatOptions): void;
}

/** Signum's `IEmbeddingsProvider`. */
export interface IEmbeddingsProvider {
    getEmbeddingModelNames(signal?: AbortSignal): Promise<string[]>;
    getEmbeddings(inputs: string[], model: EmbeddingsLanguageModelEntity, signal?: AbortSignal): Promise<number[][]>;
}

/** Signum's `updates.ToChatResponse()` — fold a stream's deltas into the final answer. */
export async function collectResponse(stream: AsyncIterable<ChatStreamUpdate>,
    onUpdate?: (update: ChatStreamUpdate) => Promise<void>): Promise<ChatResponse> {

    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    let usage: ChatUsage | undefined;

    for await (const update of stream) {
        if (update.text != undefined) text += update.text;
        if (update.reasoning != undefined) reasoning += update.reasoning;
        if (update.toolCalls != undefined) toolCalls.push(...update.toolCalls);
        if (update.usage != undefined) usage = { ...usage, ...update.usage };
        if (onUpdate != undefined) await onUpdate(update);
    }

    return { text, reasoning, toolCalls, usage };
}

/** A non-2xx from a provider, with the body — the message the chat UI shows when a key is wrong. */
export class LanguageModelException extends Error {
    constructor(readonly provider: string, readonly status: number, body: string) {
        super(`${provider} returned ${status}: ${body.slice(0, 2000)}`);
        this.name = "LanguageModelException";
    }
}

/** Shared fetch: JSON in, parsed JSON out, a LanguageModelException on failure. */
export async function fetchJson<T>(provider: string, url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok)
        throw new LanguageModelException(provider, response.status, await response.text().catch(() => ""));
    return await response.json() as T;
}

/**
 * Shared **Server-Sent Events** reader — the wire format all three protocols stream in (`data: {…}` lines
 * terminated by `data: [DONE]`). Yields each parsed data payload.
 */
export async function* readServerSentEvents(provider: string, url: string, init: RequestInit): AsyncGenerator<any> {
    const response = await fetch(url, init);
    if (!response.ok)
        throw new LanguageModelException(provider, response.status, await response.text().catch(() => ""));
    if (response.body == null)
        throw new LanguageModelException(provider, response.status, "the response has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;

        buffer += decoder.decode(value, { stream: true });

        // An SSE event ends at a blank line; a line may be a `data:` payload, an `event:` name we ignore,
        // or a comment (`:` keep-alive).
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);

            if (!line.startsWith("data:"))
                continue;

            const payload = line.slice("data:".length).trim();
            if (payload === "" || payload === "[DONE]")
                continue;

            try {
                yield JSON.parse(payload);
            } catch {
                // A provider may split one JSON payload across chunks only in the middle of a LINE, which
                // the buffering above already handles; anything else is genuinely malformed.
                console.warn(`[${provider}] unparseable SSE payload: ${payload.slice(0, 200)}`);
            }
        }
    }
}
