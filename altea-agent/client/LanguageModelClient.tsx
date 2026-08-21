import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import {
    ChatbotLanguageModelEntity, EmbeddingsLanguageModelEntity, LanguageModelProviderSymbol,
} from "../data/LanguageModel";

// Port of Signum.Agent's LanguageModelClient.tsx — the two model editors and the model-catalogue calls.
// altea divergence: `Navigator.addSettings(new EntitySettings(…))` → `cb.configure(…).withView(…)`, plus the
// query settings altea registers per type (Signum's search pages fall back to the query's declared columns).
export namespace LanguageModelClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(ChatbotLanguageModelEntity)
            .withView(() => import("./Templates/ChatbotLanguageModel"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.isDefault),
                    token(a => a.provider),
                    token(a => a.model),
                    token(a => a.temperature),
                    token(a => a.maxTokens),
                ],
            }));

        cb.configure(EmbeddingsLanguageModelEntity)
            .withView(() => import("./Templates/EmbeddingsLanguageModel"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.isDefault),
                    token(a => a.provider),
                    token(a => a.model),
                    token(a => a.dimensions),
                ],
            }));

        cb.configure(LanguageModelProviderSymbol)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.key),
                ],
            }));
    }

    export namespace API {
        export function getModels(provider: LanguageModelProviderSymbol): Promise<string[]> {
            return ajaxGet({ url: `/api/chatbot/provider/${encodeURIComponent(provider.key)}/models` });
        }

        export function getEmbeddingModels(provider: LanguageModelProviderSymbol): Promise<string[]> {
            return ajaxGet({ url: `/api/chatbot/provider/${encodeURIComponent(provider.key)}/embeddingModels` });
        }
    }
}
