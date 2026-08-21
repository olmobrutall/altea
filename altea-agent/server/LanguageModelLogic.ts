import "@altea/altea/server";
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { graph } from "@altea/altea/server/graphBuilder";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { table as tableQuery } from "@altea/altea/server/table";
import type { Lite } from "@altea/altea/data/lite";
import { ValidationMessage } from "@altea/altea/data/validators";
import "@altea/altea/data/globals";
import {
    ChatbotConfigurationEmbedded, ChatbotLanguageModelEntity, ChatbotLanguageModelOperation,
    EmbeddingsLanguageModelEntity, EmbeddingsLanguageModelOperation, LanguageModelProviderSymbol,
    LanguageModelProviders,
} from "../data/LanguageModel";
import { ChatbotMessage, ChatMessageEntity } from "../data/ChatSession";
import type {
    AIToolDefinition, ChatOptions, IChatClient, IChatbotModelProvider, IEmbeddingsProvider,
} from "./ChatClient";
import { OpenAICompatibleProvider } from "./Providers/OpenAICompatible";
import { AnthropicProvider } from "./Providers/AnthropicProvider";
import { GeminiProvider } from "./Providers/GeminiProvider";

// Port of Signum.Agent's LanguageModelLogic.cs — the two model tables (chat + embeddings), the provider
// registry, and the `ChatOptions` factory.
//
// altea divergences, documented inline:
//  - the provider registries are keyed by the symbol's KEY, not the symbol object (same reason as
//    AgentLogic's agent registry: a symbol read from a row is a different instance).
//  - Signum instantiates seven provider classes; altea instantiates three, because five of Signum's speak
//    ONE protocol behind five SDKs (see Providers/OpenAICompatible.ts).
//  - `Filter.GetEmbeddingForSmartSearch` is NOT wired: altea's query engine does not expose a vector
//    smart-search filter operation yet (see client/FinderRules.tsx's note on `VectorSmartSearch`), so
//    there is no hook to install. `getEmbeddings` is fully ported and callable directly, which is what the
//    other Southwind consumers (EmployeesLogic, the terminal) use it for.
//  - `HeavyProfiler.Log("GetEmbeddings", …)` is kept, on altea's profiler.
export namespace LanguageModelLogic {

    /** Signum's `GetConfig` — supplied by the app (its own configuration entity holds the credentials). */
    export let getConfig: () => ChatbotConfigurationEmbedded = () => {
        throw new Error("LanguageModelLogic.getConfig was not set (pass it to ChatbotLogic.start)");
    };

    let languageModels: ResetLazy<Map<string, ChatbotLanguageModelEntity>> | undefined;
    let defaultLanguageModel: ResetLazy<Lite<ChatbotLanguageModelEntity> | null> | undefined;
    let embeddingsModels: ResetLazy<Map<string, EmbeddingsLanguageModelEntity>> | undefined;
    let defaultEmbeddingsModel: ResetLazy<Lite<EmbeddingsLanguageModelEntity> | null> | undefined;

    /** Signum's `ChatbotModelProviders`. */
    export const chatbotModelProviders = new Map<string, IChatbotModelProvider>();
    /** Signum's `EmbeddingsProviders`. */
    export const embeddingsProviders = new Map<string, IEmbeddingsProvider>();

    export function registerChatbotModelProvider(symbol: LanguageModelProviderSymbol, provider: IChatbotModelProvider): void {
        chatbotModelProviders.set(symbol.key, provider);
    }

    export function registerEmbeddingsProvider(symbol: LanguageModelProviderSymbol, provider: IEmbeddingsProvider): void {
        embeddingsProviders.set(symbol.key, provider);
    }

    function registerBuiltInProviders(): void {
        const cfg = (): ChatbotConfigurationEmbedded => getConfig();

        const openAI = new OpenAICompatibleProvider({
            name: "OpenAI",
            baseUrl: () => "https://api.openai.com/v1",
            apiKey: () => required(cfg().openAIAPIKey, "No API Key for OpenAI configured!"),
        });

        const deepSeek = new OpenAICompatibleProvider({
            name: "DeepSeek",
            baseUrl: () => "https://api.deepseek.com/v1",
            apiKey: () => required(cfg().deepSeekAPIKey, "No API Key for DeepSeek configured!"),
            // Signum's comment: DeepSeek has no embedding models, so every model is a chat model.
            supportsEmbeddings: false,
        });

        const githubModels = new OpenAICompatibleProvider({
            name: "GithubModels",
            baseUrl: () => "https://models.github.ai/inference",
            apiKey: () => required(cfg().githubModelsToken, "No Token for Github Models configured!"),
            headers: () => ({ "X-GitHub-Api-Version": "2022-11-28" }),
            // The catalogue lives outside the inference endpoint (Signum fetches the same URL by hand).
            listModels: async signal => {
                const response = await fetch("https://models.github.ai/catalog/models", {
                    headers: { Accept: "application/json" }, signal,
                });
                if (!response.ok)
                    throw new Error(`Github Models catalog returned ${response.status}`);
                return (await response.json() as { id: string }[]).map(m => m.id);
            },
        });

        const mistral = new OpenAICompatibleProvider({
            name: "Mistral",
            baseUrl: () => "https://api.mistral.ai/v1",
            apiKey: () => required(cfg().mistralAPIKey, "No API Key for Mistral configured!"),
        });

        const ollama = new OpenAICompatibleProvider({
            name: "Ollama",
            // Ollama exposes an OpenAI-compatible surface under /v1 and its own tag list under /api/tags.
            baseUrl: () => `${ollamaRoot()}/v1`,
            apiKey: () => undefined,
            listModels: async signal => {
                const response = await fetch(`${ollamaRoot()}/api/tags`, { headers: { Accept: "application/json" }, signal });
                if (!response.ok)
                    throw new Error(`Ollama returned ${response.status}`);
                return (await response.json() as { models: { name: string }[] }).models.map(m => m.name);
            },
        });

        registerChatbotModelProvider(LanguageModelProviders.OpenAI, openAI);
        registerChatbotModelProvider(LanguageModelProviders.Gemini, new GeminiProvider(() => cfg().geminiAPIKey ?? undefined));
        registerChatbotModelProvider(LanguageModelProviders.Anthropic, new AnthropicProvider(() => cfg().anthropicAPIKey ?? undefined));
        registerChatbotModelProvider(LanguageModelProviders.GithubModels, githubModels);
        registerChatbotModelProvider(LanguageModelProviders.Mistral, mistral);
        registerChatbotModelProvider(LanguageModelProviders.Ollama, ollama);
        registerChatbotModelProvider(LanguageModelProviders.DeepSeek, deepSeek);

        // Signum registers embeddings for five of the seven (Anthropic and DeepSeek have none).
        registerEmbeddingsProvider(LanguageModelProviders.OpenAI, openAI);
        registerEmbeddingsProvider(LanguageModelProviders.Gemini, new GeminiProvider(() => cfg().geminiAPIKey ?? undefined));
        registerEmbeddingsProvider(LanguageModelProviders.GithubModels, githubModels);
        registerEmbeddingsProvider(LanguageModelProviders.Mistral, mistral);
        registerEmbeddingsProvider(LanguageModelProviders.Ollama, ollama);
    }

    function ollamaRoot(): string {
        const url = required(getConfig().ollamaUrl, "No Ollama URL configured!");
        return url.replace(/\/+$/, "");
    }

    function required(value: string | null | undefined, message: string): string {
        if (value == undefined || value === "")
            throw new Error(message);
        return value;
    }

    export function start(sb: SchemaBuilder, config: () => ChatbotConfigurationEmbedded): void {
        if (sb.alreadyDefined(start))
            return;

        getConfig = config;
        registerBuiltInProviders();

        SymbolLogic.start(sb, LanguageModelProviderSymbol,
            () => [...new Set([...chatbotModelProviders.keys(), ...embeddingsProviders.keys()])]
                .map(key => symbolByKey(key)));

        // SymbolLogic.start includes the TABLE but registers no QUERY; the provider picker on both model
        // editors is an EntityCombo, which loads its options through one.
        sb.include(LanguageModelProviderSymbol).withQuery();

        sb.include(ChatbotLanguageModelEntity)
            .withSave(ChatbotLanguageModelOperation.Save, async m => {
                // Signum: once a message has been produced with this model row, the model / provider is
                // frozen — the recorded token counts and prices would otherwise describe a different model.
                if (!m.isNew) {
                    const lite = m.toLite();
                    const used = await tableQuery(ChatMessageEntity).some(a => a.languageModel!.is(lite));
                    if (used) {
                        const inDb = await tableQuery(ChatbotLanguageModelEntity)
                            .filter(a => a.id == m.id)
                            .map(a => ({ model: a.model, provider: a.provider }))
                            .singleOrNull();
                        if (inDb != null && (inDb.model !== m.model || inDb.provider.key !== m.provider.key))
                            throw new Error(ChatbotMessage.UnableToChangeModelOrProviderOnceUsed.niceToString());
                    }
                }
            })
            .withUniqueIndex(a => a.isDefault, a => a.isDefault == true)
            .withQuery();

        graph(ChatbotLanguageModelEntity, g => {
            g.Execute(ChatbotLanguageModelOperation.MakeDefault, {
                canExecute: a => !a.isDefault ? null
                    : ValidationMessage._0IsSet.niceToString(ChatbotLanguageModelEntity.nicePropertyName(x => x.isDefault)),
                execute: async e => {
                    const other = await tableQuery(ChatbotLanguageModelEntity).singleOrNull(a => a.isDefault);
                    if (other != null) {
                        other.isDefault = false;
                        await other.save();
                    }
                    e.isDefault = true;
                },
            });
            g.Delete(ChatbotLanguageModelOperation.Delete, { delete: async e => { await e.delete(); } });
        }).register();

        languageModels = sb.globalLazy(async () => {
            const rows = await ExecutionMode.global(() => tableQuery(ChatbotLanguageModelEntity).toArray());
            return rows.toMap(r => r.toLite().key());
        }, { invalidateWith: [ChatbotLanguageModelEntity] });

        defaultLanguageModel = sb.globalLazy(async () => {
            const map = await languageModels!.value();
            return [...map.values()].find(a => a.isDefault)?.toLite() ?? null;
        }, { invalidateWith: [ChatbotLanguageModelEntity] });

        sb.include(EmbeddingsLanguageModelEntity)
            .withSave(EmbeddingsLanguageModelOperation.Save)
            .withUniqueIndex(a => a.isDefault, a => a.isDefault == true)
            .withQuery();

        graph(EmbeddingsLanguageModelEntity, g => {
            g.Execute(EmbeddingsLanguageModelOperation.MakeDefault, {
                canExecute: a => !a.isDefault ? null
                    : ValidationMessage._0IsSet.niceToString(EmbeddingsLanguageModelEntity.nicePropertyName(x => x.isDefault)),
                execute: async e => {
                    const other = await tableQuery(EmbeddingsLanguageModelEntity).singleOrNull(a => a.isDefault);
                    if (other != null) {
                        other.isDefault = false;
                        await other.save();
                    }
                    e.isDefault = true;
                },
            });
            g.Delete(EmbeddingsLanguageModelOperation.Delete, { delete: async e => { await e.delete(); } });
        }).register();

        embeddingsModels = sb.globalLazy(async () => {
            const rows = await ExecutionMode.global(() => tableQuery(EmbeddingsLanguageModelEntity).toArray());
            return rows.toMap(r => r.toLite().key());
        }, { invalidateWith: [EmbeddingsLanguageModelEntity] });

        defaultEmbeddingsModel = sb.globalLazy(async () => {
            const map = await embeddingsModels!.value();
            return [...map.values()].find(a => a.isDefault)?.toLite() ?? null;
        }, { invalidateWith: [EmbeddingsLanguageModelEntity] });
    }

    function symbolByKey(key: string): LanguageModelProviderSymbol {
        const symbol = Object.values(LanguageModelProviders).find(s => s.key === key);
        if (symbol == undefined)
            throw new Error(`No LanguageModelProviderSymbol declared for '${key}' — register its symbol too.`);
        return symbol;
    }

    // ---- cached reads (Signum's RetrieveFromCache / DefaultLanguageModel) ----------------------

    export async function retrieveFromCache(lite: Lite<ChatbotLanguageModelEntity>): Promise<ChatbotLanguageModelEntity> {
        const map = await languageModels!.value();
        const model = map.get(lite.key());
        if (model == undefined)
            throw new Error(`ChatbotLanguageModel '${lite.key()}' not found`);
        return model;
    }

    export async function retrieveEmbeddingsFromCache(lite: Lite<EmbeddingsLanguageModelEntity>): Promise<EmbeddingsLanguageModelEntity> {
        const map = await embeddingsModels!.value();
        const model = map.get(lite.key());
        if (model == undefined)
            throw new Error(`EmbeddingsLanguageModel '${lite.key()}' not found`);
        return model;
    }

    export function getDefaultLanguageModel(): Promise<Lite<ChatbotLanguageModelEntity> | null> {
        return defaultLanguageModel!.value();
    }

    export function getDefaultEmbeddingsModel(): Promise<Lite<EmbeddingsLanguageModelEntity> | null> {
        return defaultEmbeddingsModel!.value();
    }

    // ---- provider access ----------------------------------------------------------------------

    export function getProvider(model: ChatbotLanguageModelEntity): IChatbotModelProvider {
        const provider = chatbotModelProviders.get(model.provider.key);
        if (provider == undefined)
            throw new Error(`No chat provider registered for '${model.provider.key}'`);
        return provider;
    }

    export function getChatClient(model: ChatbotLanguageModelEntity): IChatClient {
        return getProvider(model).createChatClient(model);
    }

    /** The symbol overload Signum has, plus a KEY overload — a route only ever has the key. */
    export function getModelNames(provider: LanguageModelProviderSymbol | string, signal?: AbortSignal): Promise<string[]> {
        const key = typeof provider === "string" ? provider : provider.key;
        const p = chatbotModelProviders.get(key);
        if (p == undefined)
            throw new Error(`No chat provider registered for '${key}'`);
        return p.getModelNames(signal);
    }

    export function getEmbeddingModelNames(provider: LanguageModelProviderSymbol | string, signal?: AbortSignal): Promise<string[]> {
        const key = typeof provider === "string" ? provider : provider.key;
        const p = embeddingsProviders.get(key);
        if (p == undefined)
            throw new Error(`No embeddings provider registered for '${key}'`);
        return p.getEmbeddingModelNames(signal);
    }

    export async function getEmbeddings(model: EmbeddingsLanguageModelEntity, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
        using _prof = HeavyProfiler.log("GetEmbeddings", () => `${model.getMessage()}\n${inputs.join("\n")}`);
        const provider = embeddingsProviders.get(model.provider.key);
        if (provider == undefined)
            throw new Error(`No embeddings provider registered for '${model.provider.key}'`);
        return await provider.getEmbeddings(inputs, model, signal);
    }

    /** Signum's `ChatOptions(languageModel, tools)` — including its 64000-token default. */
    export function chatOptions(languageModel: ChatbotLanguageModelEntity, tools: AIToolDefinition[] | undefined): ChatOptions {
        return {
            modelId: languageModel.model,
            maxOutputTokens: languageModel.maxTokens ?? 64000,
            ...(languageModel.temperature != null ? { temperature: languageModel.temperature } : {}),
            ...(tools != undefined && tools.length > 0 ? { tools } : {}),
        };
    }
}
