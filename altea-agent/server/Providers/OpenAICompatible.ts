import type { ChatbotLanguageModelEntity, EmbeddingsLanguageModelEntity } from "../../data/LanguageModel";
import {
    fetchJson, readServerSentEvents, type AIToolDefinition, type ChatOptions, type ChatRequestMessage,
    type ChatStreamUpdate, type IChatClient, type IChatbotModelProvider, type IEmbeddingsProvider,
    type ToolCall,
} from "../ChatClient";

// Port of Signum.Agent's Providers/OpenAIProvider.cs, DeepSeekProvider.cs, GithubModelsProvider.cs,
// MistralProvider.cs and OllamaProvider.cs — FIVE Signum files, ONE here.
//
// Signum reaches each of these through a different .NET SDK (`OpenAI`, `Mistral.SDK`, `OllamaSharp`, and
// the OpenAI SDK re-pointed at another Endpoint for DeepSeek / GitHub Models). Under those SDKs they all
// speak the SAME wire protocol — OpenAI's `POST /chat/completions`, `GET /models`, `POST /embeddings` — so
// the port implements the protocol once and configures it five times (see the `LanguageModelProviders`
// wiring in LanguageModelLogic). What is genuinely per-vendor stays per-vendor: GitHub Models lists its
// catalogue from its own endpoint, Ollama lists local tags from `/api/tags`, and DeepSeek has to echo
// `reasoning_content` back on assistant turns (`customizeMessagesAndOptions`, exactly as in Signum).
//
// Other divergences from those five files:
//  - `Anthropic`-style prompt caching and `RawRepresentationFactory` are not needed here.
//  - Signum's `GetModelNames` filters out anything whose id contains "embed" and `GetEmbeddingModelNames`
//    keeps only those — kept verbatim, including the case-insensitive match.

export interface OpenAICompatibleOptions {
    /** For error messages and the profiler label. */
    readonly name: string;
    readonly baseUrl: () => string;
    /** `undefined` ⇒ no Authorization header (Ollama). */
    readonly apiKey: () => string | undefined;
    /** Extra request headers (GitHub Models' API version). */
    readonly headers?: () => Record<string, string>;
    /** Replaces `GET {baseUrl}/models` where the vendor lists its catalogue elsewhere. */
    readonly listModels?: (signal?: AbortSignal) => Promise<string[]>;
    /** Signum's per-vendor `CustomizeMessagesAndOptions`. */
    readonly customizeMessagesAndOptions?: (messages: ChatRequestMessage[], options: ChatOptions) => void;
    /** DeepSeek has no embeddings endpoint (Signum's comment says so). */
    readonly supportsEmbeddings?: boolean;
}

export class OpenAICompatibleProvider implements IChatbotModelProvider, IEmbeddingsProvider {

    constructor(private readonly o: OpenAICompatibleOptions) { }

    private headers(): Record<string, string> {
        const key = this.o.apiKey();
        return {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(key != undefined ? { Authorization: `Bearer ${key}` } : {}),
            ...(this.o.headers?.() ?? {}),
        };
    }

    private async allModelNames(signal?: AbortSignal): Promise<string[]> {
        if (this.o.listModels != undefined)
            return await this.o.listModels(signal);

        const json = await fetchJson<{ data: { id: string }[] }>(this.o.name,
            `${this.o.baseUrl()}/models`, { headers: this.headers(), signal });
        return json.data.map(m => m.id);
    }

    async getModelNames(signal?: AbortSignal): Promise<string[]> {
        return (await this.allModelNames(signal)).filter(n => !n.toLowerCase().includes("embed"));
    }

    async getEmbeddingModelNames(signal?: AbortSignal): Promise<string[]> {
        if (this.o.supportsEmbeddings === false)
            return [];
        return (await this.allModelNames(signal)).filter(n => n.toLowerCase().includes("embed"));
    }

    createChatClient(_model: ChatbotLanguageModelEntity): IChatClient {
        return {
            getStreamingResponse: (messages, options, signal) => this.stream(messages, options, signal),
        };
    }

    customizeMessagesAndOptions(messages: ChatRequestMessage[], options: ChatOptions): void {
        this.o.customizeMessagesAndOptions?.(messages, options);
    }

    async getEmbeddings(inputs: string[], model: EmbeddingsLanguageModelEntity, signal?: AbortSignal): Promise<number[][]> {
        const json = await fetchJson<{ data: { embedding: number[] }[] }>(this.o.name,
            `${this.o.baseUrl()}/embeddings`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
                model: model.model,
                input: inputs,
                ...(model.dimensions != null ? { dimensions: model.dimensions } : {}),
            }),
        });
        return json.data.map(d => d.embedding);
    }

    private async *stream(messages: ChatRequestMessage[], options: ChatOptions, signal?: AbortSignal): AsyncGenerator<ChatStreamUpdate> {

        const body = {
            model: options.modelId,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: options.maxOutputTokens,
            ...(options.temperature != undefined ? { temperature: options.temperature } : {}),
            messages: messages.map(toOpenAIMessage),
            ...(options.tools != undefined && options.tools.length > 0
                ? { tools: options.tools.map(toOpenAITool), tool_choice: "auto" }
                : {}),
        };

        // Tool-call arguments arrive as a stream of string FRAGMENTS keyed by index, so they are
        // accumulated here and emitted once, complete, at the end (what ChatStreamUpdate.toolCalls means).
        const pending = new Map<number, { id: string; name: string; args: string }>();

        for await (const event of readServerSentEvents(this.o.name, `${this.o.baseUrl()}/chat/completions`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(body),
        })) {
            const usage = event.usage as {
                prompt_tokens?: number; completion_tokens?: number;
                prompt_tokens_details?: { cached_tokens?: number };
                completion_tokens_details?: { reasoning_tokens?: number };
            } | undefined;

            if (usage != undefined) {
                yield {
                    usage: {
                        inputTokenCount: usage.prompt_tokens,
                        outputTokenCount: usage.completion_tokens,
                        cachedInputTokenCount: usage.prompt_tokens_details?.cached_tokens,
                        reasoningTokenCount: usage.completion_tokens_details?.reasoning_tokens,
                    },
                };
            }

            const delta = event.choices?.[0]?.delta as {
                content?: string | null;
                reasoning_content?: string | null;
                reasoning?: string | null;
                tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
            } | undefined;

            if (delta == undefined)
                continue;

            // DeepSeek names it `reasoning_content`; some OpenAI-compatible gateways use `reasoning`.
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (reasoning != undefined && reasoning !== "")
                yield { reasoning };

            if (delta.content != undefined && delta.content !== "")
                yield { text: delta.content };

            for (const tc of delta.tool_calls ?? []) {
                let acc = pending.get(tc.index);
                if (acc == undefined)
                    pending.set(tc.index, acc = { id: tc.id ?? "", name: "", args: "" });
                if (tc.id != undefined) acc.id = tc.id;
                if (tc.function?.name != undefined) acc.name += tc.function.name;
                if (tc.function?.arguments != undefined) acc.args += tc.function.arguments;
            }
        }

        if (pending.size > 0) {
            yield {
                toolCalls: [...pending.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([, acc]) => ({ callId: acc.id, name: acc.name, arguments: parseArguments(acc.args) } satisfies ToolCall)),
            };
        }
    }
}

/** `ChatRequestMessage` → one OpenAI `messages[]` entry. */
function toOpenAIMessage(m: ChatRequestMessage): Record<string, unknown> {
    if (m.role === "tool")
        return { role: "tool", tool_call_id: m.toolCallId, content: m.text ?? "" };

    if (m.role === "assistant") {
        return {
            role: "assistant",
            content: m.text ?? null,
            // DeepSeek requires the reasoning echoed back on the assistant turn when in thinking mode
            // (Signum reconstructs a raw AssistantChatMessage to carry it; here it is just a field).
            ...(m.reasoning != undefined && m.reasoning !== "" ? { reasoning_content: m.reasoning } : {}),
            ...(m.toolCalls != undefined && m.toolCalls.length > 0
                ? {
                    tool_calls: m.toolCalls.map(tc => ({
                        id: tc.callId,
                        type: "function",
                        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                    })),
                }
                : {}),
        };
    }

    return { role: m.role, content: m.text ?? "" };
}

export function toOpenAITool(tool: AIToolDefinition): Record<string, unknown> {
    return {
        type: "function",
        function: {
            name: tool.name,
            ...(tool.description != undefined ? { description: tool.description } : {}),
            parameters: tool.parameters,
        },
    };
}

/** A model can emit malformed JSON; the loop reports that as a tool error rather than dying mid-stream. */
export function parseArguments(json: string): Record<string, unknown> {
    if (json.trim() === "")
        return {};
    try {
        return JSON.parse(json) as Record<string, unknown>;
    } catch {
        return { __malformedArguments: json };
    }
}
