import type { ChatbotLanguageModelEntity } from "../../data/LanguageModel";
import {
    fetchJson, readServerSentEvents, type ChatOptions, type ChatRequestMessage, type ChatStreamUpdate,
    type IChatClient, type IChatbotModelProvider, type ToolCall,
} from "../ChatClient";
import { parseArguments } from "./OpenAICompatible";

// Port of Signum.Agent's Providers/AnthropicProvider.cs. Signum uses the `Anthropic.SDK` package; the port
// speaks the **Messages API** directly (`POST /v1/messages`, `GET /v1/models`), because the JS ecosystem's
// equivalent SDK would be one more dependency for one endpoint — the same call the Graph and EWS ports made.
//
// What the protocol forces, and Signum's SDK hid:
//  - the SYSTEM prompt is a top-level `system` field, not a message with `role: "system"`. That is why
//    Signum needs `CustomizeMessagesAndOptions` at all: it lifts the system messages out of the list so
//    the SDK's own helper can't re-add them without cache control. Here the lift happens in the request
//    builder, and `customizeMessagesAndOptions` is not needed — but PROMPT CACHING is kept: the system
//    block carries `cache_control: { type: "ephemeral" }`, exactly as Signum's `SystemMessage` does. That
//    matters for cost, since the system prompt is the whole skill tree and it repeats every turn.
//  - content is always a BLOCK LIST: `text`, `thinking`, `tool_use` on an assistant turn, `tool_result`
//    on a user turn (Anthropic has no `tool` role — a tool result is a user message).
//  - tool schemas go in `input_schema`, and streaming deltas arrive as typed events
//    (`content_block_start` / `content_block_delta` / `message_delta`) rather than one `delta` object.

const anthropicVersion = "2023-06-01";

export class AnthropicProvider implements IChatbotModelProvider {

    constructor(private readonly getApiKey: () => string | undefined) { }

    private headers(): Record<string, string> {
        const apiKey = this.getApiKey();
        if (apiKey == undefined || apiKey === "")
            throw new Error("No API Key for Claude configured!");

        return {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-api-key": apiKey,
            "anthropic-version": anthropicVersion,
        };
    }

    async getModelNames(signal?: AbortSignal): Promise<string[]> {
        const json = await fetchJson<{ data: { id: string }[] }>("Anthropic",
            "https://api.anthropic.com/v1/models?limit=1000", { headers: this.headers(), signal });
        return json.data.map(m => m.id);
    }

    createChatClient(_model: ChatbotLanguageModelEntity): IChatClient {
        return {
            getStreamingResponse: (messages, options, signal) => this.stream(messages, options, signal),
        };
    }

    private async *stream(messages: ChatRequestMessage[], options: ChatOptions, signal?: AbortSignal): AsyncGenerator<ChatStreamUpdate> {

        // Signum's `CustomizeMessagesAndOptions`, done here: the system turns become ONE cached system
        // block and leave the message list.
        const systemText = messages.filter(m => m.role === "system").map(m => m.text ?? "").filter(t => t !== "").join("\n\n");
        const conversation = messages.filter(m => m.role !== "system");

        const body = {
            model: options.modelId,
            max_tokens: options.maxOutputTokens,
            stream: true,
            ...(options.temperature != undefined ? { temperature: options.temperature } : {}),
            ...(systemText !== ""
                ? { system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }] }
                : {}),
            messages: toAnthropicMessages(conversation),
            ...(options.tools != undefined && options.tools.length > 0
                ? {
                    tools: options.tools.map(t => ({
                        name: t.name,
                        ...(t.description != undefined ? { description: t.description } : {}),
                        input_schema: t.parameters,
                    })),
                }
                : {}),
        };

        // One accumulator per content block index; a `tool_use` block streams its input as JSON fragments.
        const blocks = new Map<number, { kind: "text" | "thinking" | "tool_use"; id?: string; name?: string; json: string }>();
        const toolCalls: ToolCall[] = [];

        for await (const event of readServerSentEvents("Anthropic", "https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(body),
        })) {
            switch (event.type) {
                case "message_start": {
                    const usage = event.message?.usage;
                    if (usage != undefined)
                        yield {
                            usage: {
                                inputTokenCount: usage.input_tokens,
                                // Anthropic reports cache reads separately from ordinary input tokens.
                                cachedInputTokenCount: usage.cache_read_input_tokens,
                                outputTokenCount: usage.output_tokens,
                            },
                        };
                    break;
                }
                case "content_block_start": {
                    const block = event.content_block;
                    blocks.set(event.index, {
                        kind: block?.type === "tool_use" ? "tool_use" : block?.type === "thinking" ? "thinking" : "text",
                        id: block?.id,
                        name: block?.name,
                        json: "",
                    });
                    break;
                }
                case "content_block_delta": {
                    const acc = blocks.get(event.index);
                    const delta = event.delta;
                    if (delta?.type === "text_delta" && delta.text != undefined)
                        yield { text: delta.text };
                    else if (delta?.type === "thinking_delta" && delta.thinking != undefined)
                        yield { reasoning: delta.thinking };
                    else if (delta?.type === "input_json_delta" && acc != undefined)
                        acc.json += delta.partial_json ?? "";
                    break;
                }
                case "content_block_stop": {
                    const acc = blocks.get(event.index);
                    if (acc?.kind === "tool_use")
                        toolCalls.push({ callId: acc.id ?? "", name: acc.name ?? "", arguments: parseArguments(acc.json) });
                    break;
                }
                case "message_delta": {
                    const usage = event.usage;
                    if (usage?.output_tokens != undefined)
                        yield { usage: { outputTokenCount: usage.output_tokens } };
                    break;
                }
                default:
                    break; // ping / message_stop / error-shaped events carry nothing the loop needs
            }
        }

        if (toolCalls.length > 0)
            yield { toolCalls };
    }
}

/** The four altea roles → Anthropic's two, with a tool result carried as a `tool_result` block. */
function toAnthropicMessages(messages: ChatRequestMessage[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    for (const m of messages) {
        if (m.role === "tool") {
            // Anthropic has no tool role: a result is a USER turn holding one tool_result block. Merge
            // into the previous user turn when possible, which is what the API expects for parallel calls.
            const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.text ?? "" };
            const last = result[result.length - 1];
            if (last?.["role"] === "user" && Array.isArray(last["content"]))
                (last["content"] as unknown[]).push(block);
            else
                result.push({ role: "user", content: [block] });
            continue;
        }

        if (m.role === "assistant") {
            const content: Record<string, unknown>[] = [];
            if (m.text != undefined && m.text !== "")
                content.push({ type: "text", text: m.text });
            for (const tc of m.toolCalls ?? [])
                content.push({ type: "tool_use", id: tc.callId, name: tc.name, input: tc.arguments });
            // The `thinking` block is NOT echoed back: replaying it requires the original signature, which
            // altea does not store (ChatMessageEntity keeps the reasoning TEXT, for display).
            if (content.length > 0)
                result.push({ role: "assistant", content });
            continue;
        }

        result.push({ role: "user", content: [{ type: "text", text: m.text ?? "" }] });
    }

    return result;
}
