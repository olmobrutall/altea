import type { ChatbotLanguageModelEntity, EmbeddingsLanguageModelEntity } from "../../data/LanguageModel";
import {
    fetchJson, readServerSentEvents, type ChatOptions, type ChatRequestMessage, type ChatStreamUpdate,
    type IChatClient, type IChatbotModelProvider, type IEmbeddingsProvider, type JsonSchema, type ToolCall,
} from "../ChatClient";

// Port of Signum.Agent's Providers/GeminiProvider.cs. Signum uses `Google_GenerativeAI.Microsoft`; the port
// speaks the **Generative Language API** directly (`:streamGenerateContent?alt=sse`,
// `:batchEmbedContents`, `GET /models`) — one endpoint family, so an SDK would not pay for itself.
//
// What the protocol forces:
//  - roles are `user` / `model` (no assistant, no tool, no system): the system prompt is a top-level
//    `systemInstruction`, and a tool result is a `user` turn holding a `functionResponse` part.
//  - a message is a list of PARTS; a tool call is a `functionCall` part with the arguments already parsed
//    (Gemini sends structured JSON, so there is nothing to accumulate — unlike the other two protocols).
//  - `generationConfig` holds maxOutputTokens / temperature, and `thinkingConfig.includeThoughts` is what
//    surfaces reasoning; a part with `thought: true` is the chain of thought.
//  - the tool schema is OpenAPI-flavoured: no `additionalProperties`, and `$schema` is rejected outright,
//    hence `toGeminiSchema` below.
//  - Signum sets `AutoCallFunction = false` on its client for exactly the same reason altea never needs
//    to: the agent loop runs the tools itself.

const baseUrl = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiProvider implements IChatbotModelProvider, IEmbeddingsProvider {

    constructor(private readonly getApiKey: () => string | undefined) { }

    private apiKey(): string {
        const key = this.getApiKey();
        if (key == undefined || key === "")
            throw new Error("No API Key for Gemini configured!");
        return key;
    }

    private headers(): Record<string, string> {
        return { "Content-Type": "application/json", Accept: "application/json", "x-goog-api-key": this.apiKey() };
    }

    private async allModelNames(signal?: AbortSignal): Promise<string[]> {
        const json = await fetchJson<{ models: { name: string }[] }>("Gemini",
            `${baseUrl}/models?pageSize=1000`, { headers: this.headers(), signal });
        return json.models.map(m => m.name);
    }

    async getModelNames(signal?: AbortSignal): Promise<string[]> {
        return (await this.allModelNames(signal)).filter(n => !n.toLowerCase().includes("embed"));
    }

    async getEmbeddingModelNames(signal?: AbortSignal): Promise<string[]> {
        return (await this.allModelNames(signal)).filter(n => n.toLowerCase().includes("embed"));
    }

    createChatClient(_model: ChatbotLanguageModelEntity): IChatClient {
        return {
            getStreamingResponse: (messages, options, signal) => this.stream(messages, options, signal),
        };
    }

    async getEmbeddings(inputs: string[], model: EmbeddingsLanguageModelEntity, signal?: AbortSignal): Promise<number[][]> {
        // Signum's `BatchEmbedContentAsync` with a per-request OutputDimensionality.
        const modelPath = model.model.startsWith("models/") ? model.model : `models/${model.model}`;
        const json = await fetchJson<{ embeddings: { values: number[] }[] }>("Gemini",
            `${baseUrl}/${modelPath}:batchEmbedContents`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
                requests: inputs.map(text => ({
                    model: modelPath,
                    content: { parts: [{ text }] },
                    ...(model.dimensions != null ? { outputDimensionality: model.dimensions } : {}),
                })),
            }),
        });
        return json.embeddings.map(e => e.values);
    }

    private async *stream(messages: ChatRequestMessage[], options: ChatOptions, signal?: AbortSignal): AsyncGenerator<ChatStreamUpdate> {

        const systemText = messages.filter(m => m.role === "system").map(m => m.text ?? "").filter(t => t !== "").join("\n\n");
        const conversation = messages.filter(m => m.role !== "system");

        const body = {
            contents: toGeminiContents(conversation),
            ...(systemText !== "" ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
            generationConfig: {
                maxOutputTokens: options.maxOutputTokens,
                ...(options.temperature != undefined ? { temperature: options.temperature } : {}),
                thinkingConfig: { includeThoughts: true },
            },
            ...(options.tools != undefined && options.tools.length > 0
                ? {
                    tools: [{
                        functionDeclarations: options.tools.map(t => ({
                            name: t.name,
                            ...(t.description != undefined ? { description: t.description } : {}),
                            parameters: toGeminiSchema(t.parameters),
                        })),
                    }],
                    // The loop drives the tools; never let the model's own runtime call them.
                    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                }
                : {}),
        };

        const modelPath = options.modelId.startsWith("models/") ? options.modelId : `models/${options.modelId}`;
        const toolCalls: ToolCall[] = [];

        for await (const event of readServerSentEvents("Gemini",
            `${baseUrl}/${modelPath}:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(body),
        })) {
            const usage = event.usageMetadata as {
                promptTokenCount?: number; candidatesTokenCount?: number;
                cachedContentTokenCount?: number; thoughtsTokenCount?: number;
            } | undefined;

            if (usage != undefined) {
                yield {
                    usage: {
                        inputTokenCount: usage.promptTokenCount,
                        outputTokenCount: usage.candidatesTokenCount,
                        cachedInputTokenCount: usage.cachedContentTokenCount,
                        reasoningTokenCount: usage.thoughtsTokenCount,
                    },
                };
            }

            for (const part of event.candidates?.[0]?.content?.parts ?? []) {
                if (part.functionCall != undefined) {
                    toolCalls.push({
                        // Gemini has no call id, so the tool NAME is the correlation key — which is what
                        // its own `functionResponse` uses too (see toGeminiContents).
                        callId: part.functionCall.id ?? part.functionCall.name,
                        name: part.functionCall.name,
                        arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
                    });
                } else if (part.text != undefined && part.text !== "") {
                    if (part.thought === true)
                        yield { reasoning: part.text };
                    else
                        yield { text: part.text };
                }
            }
        }

        if (toolCalls.length > 0)
            yield { toolCalls };
    }
}

function toGeminiContents(messages: ChatRequestMessage[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    for (const m of messages) {
        if (m.role === "tool") {
            // A tool result is a USER turn holding a functionResponse keyed by the tool NAME (Gemini's
            // correlation key — see the callId note in `stream`). The stored callId IS that name unless the
            // provider supplied an id, so prefer the toolId the loop recorded.
            result.push({
                role: "user",
                parts: [{
                    functionResponse: {
                        name: m.toolCallId ?? "",
                        response: { result: m.text ?? "" },
                    },
                }],
            });
            continue;
        }

        if (m.role === "assistant") {
            const parts: Record<string, unknown>[] = [];
            if (m.text != undefined && m.text !== "")
                parts.push({ text: m.text });
            for (const tc of m.toolCalls ?? [])
                parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
            if (parts.length > 0)
                result.push({ role: "model", parts });
            continue;
        }

        result.push({ role: "user", parts: [{ text: m.text ?? "" }] });
    }

    return result;
}

/**
 * Gemini accepts an OpenAPI subset, not full JSON Schema: `additionalProperties` and `$schema` are
 * rejected, and `type` must be a single UPPERCASE name. Strip and translate rather than hoping.
 */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
        if (key === "additionalProperties" || key === "$schema")
            continue;

        if (key === "type") {
            const single = Array.isArray(value) ? value.find(t => t !== "null") ?? "string" : value;
            out["type"] = String(single).toUpperCase();
            if (Array.isArray(value) && value.includes("null"))
                out["nullable"] = true;
            continue;
        }

        if (key === "properties" && value != null && typeof value === "object") {
            out["properties"] = Object.fromEntries(
                Object.entries(value as Record<string, JsonSchema>).map(([k, v]) => [k, toGeminiSchema(v)]));
            continue;
        }

        if (key === "items" && value != null && typeof value === "object") {
            out["items"] = toGeminiSchema(value as JsonSchema);
            continue;
        }

        out[key] = value;
    }

    return out;
}
