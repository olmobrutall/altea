import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Symbol } from "@altea/altea/data/symbol";
import { entity, format, quoted, stringLengthValidator, unit } from "@altea/altea/data/decorators";
import { Decimal } from "@altea/altea/data/basics";
import type { int } from "@altea/altea/data/basics";
import type { DeleteSymbol, ExecuteSymbol } from "@altea/altea/data/operations";

// Port of Signum.Agent's ChatbotLanguageModel.cs — WHICH model to talk to, and what it costs.
//
// altea divergences, documented inline:
//  - `float? Temperature` → `number | null` (altea has no float/double distinction in a field type).
//  - `decimal?` prices → `Decimal | null` (altea's decimal.js class), keeping `[Unit]` + 4 decimals.
//  - `[Format(FormatAttribute.Password)]` → `@format("Password")`; the `[Description("Open AI API Key")]`
//    on the first key becomes `@niceName`-free — the field name already reads "Open AI API Key" once
//    de-camelCased, and Signum's attribute exists only because C# cannot express `openAIAPIKey`.

/** Signum's LanguageModelProviderSymbol — names a registered provider (one wire protocol + credential). */
@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class LanguageModelProviderSymbol extends Symbol {
}

/** Signum's LanguageModelProviders — the built-in provider symbols. */
export namespace LanguageModelProviders {
    export const OpenAI: LanguageModelProviderSymbol = init();
    export const Gemini: LanguageModelProviderSymbol = init();
    export const Anthropic: LanguageModelProviderSymbol = init();
    export const Mistral: LanguageModelProviderSymbol = init();
    export const GithubModels: LanguageModelProviderSymbol = init();
    export const Ollama: LanguageModelProviderSymbol = init();
    export const DeepSeek: LanguageModelProviderSymbol = init();
}

@reflect
@entity("Main", "Master")
export class ChatbotLanguageModelEntity extends Entity {

    provider: LanguageModelProviderSymbol;

    @stringLengthValidator({ max: 50 })
    model: string;

    temperature: number | null = null;

    maxTokens: int | null = null;

    isDefault: boolean;

    @unit("$ / 1M tokens") @format("N4")
    pricePerInputToken: Decimal | null = null;

    @unit("$ / 1M tokens") @format("N4")
    pricePerOutputToken: Decimal | null = null;

    @unit("$ / 1M tokens") @format("N4")
    pricePerCachedInputToken: Decimal | null = null;

    @unit("$ / 1M tokens") @format("N4")
    pricePerReasoningOutputToken: Decimal | null = null;

    @quoted
    toString(): string {
        return `${this.provider}: ${this.model}`;
    }
}

export namespace ChatbotLanguageModelOperation {
    export const Save: ExecuteSymbol<ChatbotLanguageModelEntity> = init();
    export const MakeDefault: ExecuteSymbol<ChatbotLanguageModelEntity> = init();
    export const Delete: DeleteSymbol<ChatbotLanguageModelEntity> = init();
}

@reflect
@entity("Main", "Master")
export class EmbeddingsLanguageModelEntity extends Entity {

    provider: LanguageModelProviderSymbol;

    @stringLengthValidator({ max: 50 })
    model: string;

    dimensions: int | null = null;

    isDefault: boolean;

    /** Signum's internal `GetMessage()` — the label the profiler logs an embedding call under. */
    getMessage(): string {
        return `${this.provider} - ${this.model}` + (this.dimensions == null ? "" : ` (${this.dimensions} dims)`);
    }

    @quoted
    toString(): string {
        return `${this.provider}: ${this.model}`;
    }
}

export namespace EmbeddingsLanguageModelOperation {
    export const Save: ExecuteSymbol<EmbeddingsLanguageModelEntity> = init();
    export const MakeDefault: ExecuteSymbol<EmbeddingsLanguageModelEntity> = init();
    export const Delete: DeleteSymbol<EmbeddingsLanguageModelEntity> = init();
}

/**
 * Signum's ChatbotConfigurationEmbedded — the credentials, one per provider. Embedded in the APP's own
 * configuration entity (Southwind: `ApplicationConfigurationEntity.Chatbot`), which is why the module
 * takes a `() => ChatbotConfigurationEmbedded` accessor rather than owning a table.
 */
@reflect
export class ChatbotConfigurationEmbedded extends EmbeddedEntity {

    @stringLengthValidator({ max: 300 }) @format("Password")
    openAIAPIKey: string | null = null;

    @stringLengthValidator({ max: 300 }) @format("Password")
    anthropicAPIKey: string | null = null;

    @stringLengthValidator({ max: 300 }) @format("Password")
    geminiAPIKey: string | null = null;

    @stringLengthValidator({ max: 300 }) @format("Password")
    mistralAPIKey: string | null = null;

    @stringLengthValidator({ max: 300 }) @format("Password")
    githubModelsToken: string | null = null;

    @stringLengthValidator({ max: 300 }) @format("Password")
    deepSeekAPIKey: string | null = null;

    @stringLengthValidator({ max: 300 })
    ollamaUrl: string | null = null;
}
