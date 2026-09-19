import type { Vector } from "../../data/vector";
import type { QueryToken } from "../../data/dynamicQuery/tokens";
import type { Filter } from "./requests";

/**
 * Port of Signum's `Filter.GetEmbeddingForSmartSearch` (DynamicQuery/Requests/Filter.cs) — the seam that
 * turns the PROSE a user typed into a `SmartSearch` filter into the embedding a vector column is ranked
 * against.
 *
 * It lives in CORE for the same reason `PermissionLogic.isAuthorizedImplementation` does: core owns the
 * question (a query engine has to know that a vector column can be searched by meaning) and some other
 * module owns the answer (@altea/altea-agent, which has the model rows, the provider registry and the
 * credentials). Core must not depend on the agent package, and the agent package must not have to patch
 * the query engine — so the engine declares a hook and `LanguageModelLogic.start` fills it.
 *
 * TWO DIVERGENCES from Signum, both forced and both deliberate:
 *
 *  1. **It is ASYNC, and therefore resolved BEFORE the query is built.** Signum calls the Func from inside
 *     `VectorDistanceToken.BuildExpressionInternal` and blocks on the HTTP round-trip (`.ResultSafe()`).
 *     Node has no such move, and building an expression tree is synchronous everywhere in altea, so the
 *     resolution is a PASS over the request's filters (`resolveEmbeddings`) run by the DynamicQueryContainer
 *     before execution, exactly where the SystemTime scope is opened. The Vector it produces is parked on
 *     the condition (`FilterCondition.resolvedVector`) and the token reads it synchronously — which is
 *     Signum's own second branch, the one that accepts a `Vector` value handed in directly.
 *
 *  2. **It is resolved EAGERLY**, for every SmartSearch condition in the request, where Signum resolves
 *     lazily — only if a `Distance` token is actually selected. Eager costs one embeddings call for a
 *     request that asked for prose and then never ranked by it; lazy costs a SILENT no-op for a request
 *     whose seam was never installed, because nothing would have called it. Reporting a misconfiguration
 *     at the filter that needs it is worth more than the saved call.
 */
export type GetEmbeddingForSmartSearch = (token: QueryToken, searchText: string) => Promise<Vector>;

let implementation: GetEmbeddingForSmartSearch | undefined;

export namespace SmartSearchLogic {

    /**
     * Install the embedding provider. @altea/altea-agent calls this from `LanguageModelLogic.start`; an
     * application with its own embeddings source may call it instead. LAST ONE WINS — unlike
     * `PermissionLogic`, which collects a LIST because every registered rule must agree before a
     * permission is granted. There is nothing to combine here: a search has exactly one query vector,
     * so a second provider is a replacement, not an additional opinion.
     */
    export function registerGetEmbedding(getEmbedding: GetEmbeddingForSmartSearch): void {
        implementation = getEmbedding;
    }

    /** Whether an implementation is installed (so a caller can offer smart search, or not). */
    export function isConfigured(): boolean {
        return implementation != undefined;
    }

    /**
     * The embedding for `searchText`, as the column `token` is indexed for.
     *
     * **With no implementation registered this THROWS**, and the decision is the opposite of
     * `PermissionLogic.isAuthorizedString`'s (which allows). The reason is that the two have different
     * safe directions. A permission check with no policy installed has nothing to refuse BY — allowing is
     * the honest answer for an application with no authorization module, and it is also the answer the
     * auth module itself gives a request with no role. A smart search with no embeddings model installed
     * has no ANSWER: the alternatives are to drop the filter (the result list then looks ranked and is
     * not) or to rank against a zero vector (every row equidistant, in arbitrary order). Both hand back a
     * plausible ordering that is wrong, which is precisely the failure the `MatchRank` port refused on
     * SQL Server. So it throws, naming the seam and who installs it — Signum's behaviour too, via the
     * throwing initializer of its Func.
     */
    export async function getEmbedding(token: QueryToken, searchText: string): Promise<Vector> {
        if (implementation == undefined)
            throw new Error(
                `A SmartSearch filter on '${token.fullKey()}' needs an embeddings provider, and none is registered. ` +
                `Start @altea/altea-agent (ChatbotLogic.start installs one from the default EmbeddingsLanguageModelEntity), ` +
                `or call SmartSearchLogic.registerGetEmbedding with your own.`);
        return await implementation(token, searchText);
    }

    /**
     * Resolve every `SmartSearch` filter's prose to a vector, in place, before the query is built
     * (see the class comment above for why this is a pass and not a lazy call). A request with no such
     * filter — which is nearly all of them — does no work and never touches the seam.
     */
    export async function resolveEmbeddings(filters: readonly Filter[]): Promise<void> {
        for (const filter of filters)
            for (const condition of filter.smartSearchConditions())
                if (condition.resolvedVector == undefined)
                    condition.resolvedVector = await getEmbedding(condition.token, condition.value as string);
    }
}
