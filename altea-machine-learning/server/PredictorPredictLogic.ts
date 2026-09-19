import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import {
    Column, FilterCondition, FilterOperationKeys, Pagination, QueryRequest,
} from "@altea/altea/server/dynamicQuery/requests";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    PredictorEntity, PredictorPublicationSymbol, PredictorState, PredictorSubQueryColumnUsage,
} from "../data/Predictor";
import {
    PredictorPredictContext, emptyPredictDictionary, objectArrayKey, type PredictDictionary,
} from "./PredictorAlgorithm";
import { PredictorCodificationLogic } from "./PredictorCodificationLogic";
import { PredictorLogic } from "./PredictorLogic";
import { PredictorLogicQuery } from "./PredictorLogicQuery";
import type { PredictionOptions } from "./tensorflow/Encodings";

// Port of Signum.MachineLearning's PredictorPredictLogic.cs — using a trained predictor.
//
// The context is CACHED, and that is the point of this module rather than an implementation detail:
// answering one prediction needs the codification rows (a database read) and the model (a file read plus
// a tfjs graph build). Doing that per call would make a prediction cost more than the query it predicts
// about. Signum caches 50 contexts in a `RecentDictionary`; this is the same bounded LRU.
//
// altea divergences, documented inline:
//  - `RecentDictionary<K,V>` has no counterpart in altea, so the LRU is a small local Map (insertion
//    order + delete-and-reinsert on a hit is an LRU in JS, since Map preserves insertion order).
//  - loading is ASYNC (the model read and the codification query both are), so `getPredictContext`
//    returns a promise and the cache stores the PROMISE — two concurrent first calls then share one load
//    rather than both building a graph.
//  - `QueryDescription` is gone, so the token replacement Signum does through it resolves against the
//    query NAME instead.

export namespace PredictorPredictLogic {

    /** Signum's `TrainedPredictorCache` — a bounded LRU of ready-to-use contexts. */
    const cache = new Map<string, Promise<PredictorPredictContext>>();
    export let cacheSize = 50;

    /** Drop a predictor's cached context — after a retrain, an untrain, or a definition change. */
    export function invalidate(predictor: Lite<PredictorEntity> | PredictorEntity): void {
        cache.delete(keyOf(predictor));
    }

    export function invalidateAll(): void {
        cache.clear();
    }

    function keyOf(predictor: Lite<PredictorEntity> | PredictorEntity): string {
        const lite = predictor as Lite<PredictorEntity>;
        return typeof lite.key === "function" ? lite.key() : String((predictor as PredictorEntity).id);
    }

    /** Signum's `GetCurrentPredictor(publication)` — the ONE trained predictor published for a purpose. */
    export async function currentPredictor(publication: PredictorPublicationSymbol): Promise<PredictorEntity> {
        const key = publication.key;
        const found = await ExecutionMode.global(async () =>
            await table(PredictorEntity)
                .filter(p => p.publication!.key == key && p.state == PredictorState.Trained)
                .toArray() as PredictorEntity[]);

        if (found.length === 0)
            throw new Error(`No trained predictor is published for '${key}'`);
        if (found.length > 1)
            // The Publish operation unpublishes the others, so this means the rows were edited directly.
            throw new Error(`${found.length} trained predictors are published for '${key}' — exactly one may be`);

        return found[0]!;
    }

    /** Signum's `GetPredictContext(publication)`. */
    export async function predictContextFor(publication: PredictorPublicationSymbol): Promise<PredictorPredictContext> {
        return await predictContext(await currentPredictor(publication));
    }

    /**
     * Signum's `GetPredictContext(lite)` — the cached context, loading it on first use.
     *
     * The promise itself is cached (see the header): two requests arriving together share one load.
     */
    export function predictContext(predictor: PredictorEntity | Lite<PredictorEntity>): Promise<PredictorPredictContext> {
        const key = keyOf(predictor);
        const hit = cache.get(key);
        if (hit != null) {
            // Re-insert, so the most recently used is last — which is what makes the eviction below LRU.
            cache.delete(key);
            cache.set(key, hit);
            return hit;
        }

        const loading = createPredictContext(predictor).catch(e => {
            // A failed load must not be cached: the next caller should retry rather than inherit it.
            cache.delete(key);
            throw e;
        });

        cache.set(key, loading);

        // Evict the least recently used — the FIRST key, since a hit re-inserts at the end.
        while (cache.size > cacheSize) {
            const oldest = cache.keys().next().value;
            if (oldest == null)
                break;
            cache.delete(oldest);
        }

        return loading;
    }

    /** Signum's `CreatePredictContext(p)` — read the codifications, build the context, load the model. */
    export async function createPredictContext(
        predictor: PredictorEntity | Lite<PredictorEntity>,
    ): Promise<PredictorPredictContext> {
        const entity = (predictor as PredictorEntity).columns != null
            ? predictor as PredictorEntity
            : await ExecutionMode.global(() => retrieve(PredictorEntity, (predictor as Lite<PredictorEntity>).id));

        if (entity.state !== PredictorState.Trained)
            throw new Error(`Predictor '${entity.name}' is ${PredictorState[entity.state]}, not Trained`);

        const algorithm = PredictorLogic.algorithmOf(entity);
        const codifications = await PredictorCodificationLogic.retrieveCodifications(entity);

        if (codifications.length === 0)
            throw new Error(`Predictor '${entity.name}' has no codifications — retrain it`);

        const ctx = new PredictorPredictContext(entity, algorithm, codifications);
        await algorithm.loadModel(ctx);
        return ctx;
    }

    // ---- building the inputs ---------------------------------------------------------------------------

    /** Signum's `GetInputsEmpty(ctx)` — every input unset, for a caller that fills them by hand. */
    export function inputsEmpty(ctx: PredictorPredictContext): PredictDictionary {
        return emptyPredictDictionary(ctx.predictor);
    }

    /**
     * Signum's `GetInputsFromEntity(ctx, entity)` — run the predictor's own queries restricted to ONE
     * entity, and fill its inputs from the result.
     *
     * This is the ordinary way to predict about a row that exists: the predictor already knows which
     * columns it reads, so the caller only names the entity.
     */
    export async function inputsFromEntity(
        ctx: PredictorPredictContext, entity: Lite<Entity>, options?: PredictionOptions,
    ): Promise<PredictDictionary> {
        void options;
        const predictor = ctx.predictor;
        const queryName = PredictorLogicQuery.queryNameOf(predictor);
        const mainOptions = PredictorLogicQuery.mainOptions(predictor);

        // altea's ROOT entity token is the EMPTY string, where Signum spells it "Entity" — there is no
        // storable root token here (the divergence the user-asset token rules document).
        const entityToken = QueryLogic.getToken(queryName, "", mainOptions);
        const columns = [...predictor.columns].sort((a, b) => (a.rowOrder as number) - (b.rowOrder as number));

        const request = new QueryRequest(
            queryName,
            [new FilterCondition(entityToken, FilterOperationKeys.EqualTo, entity)],
            [],
            columns.map(c => new Column(QueryLogic.getToken(queryName, c.token.tokenString, mainOptions))),
            new Pagination.All(),
            predictor.mainQuery.groupResults,
        );

        const result = await ExecutionMode.global(() => QueryLogic.queries.executeQueryAsync(request));
        if (result.rows.length === 0)
            throw new Error(`The predictor's main query returns no row for ${entity.toString()}`);

        const row = result.rows[0]!;
        const dic = emptyPredictDictionary(predictor, entity);

        // EVERY column, inputs and outputs alike — Signum's `FromFilters` does the same, and it matters:
        // one dictionary serves as the prediction's INPUTS and as the record of what actually happened, so
        // an interactive prediction can show "the model says 98.53, the truth was 38.28". The outputs are
        // ignored when the vector is encoded (`encodeInputs` reads only the input codifications), so
        // carrying them cannot influence the answer.
        columns.forEach((col, i) => dic.mainQueryValues.set(col, row.value(i)));

        await fillSubQueries(ctx, dic, entity);
        return dic;
    }

    /**
     * The sub-query half of `inputsFromEntity`: for each sub-query, the values of THIS entity's rows,
     * grouped by their SplitBy key — the same flattening the training used (see PredictorLogicQuery).
     */
    async function fillSubQueries(
        ctx: PredictorPredictContext, dic: PredictDictionary, entity: Lite<Entity>,
    ): Promise<void> {
        const predictor = ctx.predictor;

        for (const sq of [...predictor.subQueries].sort((a, b) => (a.rowOrder as number) - (b.rowOrder as number))) {
            const request = PredictorLogicQuery.subQueryRequest(predictor, sq);
            const sqQueryName = QueryLogic.toQueryName(sq.query.key);
            const sqColumns = [...sq.columns].sort((a, b) => (a.rowOrder as number) - (b.rowOrder as number));

            const parentKeyColumn = sqColumns.find(c => c.usage === PredictorSubQueryColumnUsage.ParentKey)!;
            const parentToken = QueryLogic.getToken(sqQueryName, parentKeyColumn.token.tokenString,
                PredictorLogicQuery.mainOptions(predictor));

            // Narrow to this entity — the training ran over the whole population, a prediction over one.
            request.filters = [
                ...request.filters,
                new FilterCondition(parentToken, FilterOperationKeys.EqualTo, entity),
            ];

            const result = await ExecutionMode.global(() => QueryLogic.queries.executeQueryAsync(request));

            const splitIndexes = sqColumns
                .map((c, i) => c.usage === PredictorSubQueryColumnUsage.SplitBy ? i : -1)
                .filter(i => i >= 0);

            const byKey = new Map<string, Map<typeof sqColumns[number], unknown>>();
            for (const row of result.rows) {
                const splitKey = objectArrayKey(splitIndexes.map(i => row.value(i)));
                let group = byKey.get(splitKey);
                if (group == null) {
                    group = new Map();
                    byKey.set(splitKey, group);
                }
                // Input AND Output, for the reason the main-query loop above documents. The ParentKey and
                // the SplitBy columns are excluded because they are not values: one identifies the row's
                // owner and the others are the group key itself.
                sqColumns.forEach((c, i) => {
                    if (c.usage === PredictorSubQueryColumnUsage.Input
                        || c.usage === PredictorSubQueryColumnUsage.Output)
                        group!.set(c, row.value(i));
                });
            }

            dic.subQueryValues.set(sq, byKey);
        }
    }

    /** Signum's `PredictBasic(input)` — the prediction itself. */
    export async function predict(
        ctx: PredictorPredictContext, input: PredictDictionary,
    ): Promise<PredictDictionary> {
        return await ctx.algorithm.predict(ctx, input);
    }

    /** Signum's `PredictMultiple`. */
    export async function predictMultiple(
        ctx: PredictorPredictContext, inputs: PredictDictionary[],
    ): Promise<PredictDictionary[]> {
        return await ctx.algorithm.predictMultiple(ctx, inputs);
    }

    /**
     * The convenience the callers actually want: predict about one entity, through the predictor
     * published for a purpose. Signum's `publication.GetPredictContext().GetInputsFromEntity(e).Predict()`
     * in one call.
     */
    export async function predictFor(
        publication: PredictorPublicationSymbol, entity: Lite<Entity>,
    ): Promise<PredictDictionary> {
        const ctx = await predictContextFor(publication);
        return await predict(ctx, await inputsFromEntity(ctx, entity));
    }
}
