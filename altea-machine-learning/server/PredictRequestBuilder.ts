import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { FilterOperationKeys } from "@altea/altea/server/dynamicQuery/requests";
import { deserializeFilterValue } from "@altea/altea/server/queryServer";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import {
    PredictorColumnUsage, PredictorSubQueryColumnUsage, toPredictorColumnUsage,
    type PredictorEntity, type PredictorEntity_Column,
    type PredictorSubQueryEntity, type PredictorSubQueryEntity_Column,
} from "../data/Predictor";
import {
    isPredictOutputTuple,
    type PredictColumnModel, type PredictRequestModel, type PredictSubQueryHeaderModel,
    type PredictSubQueryTableModel,
} from "../data/PredictRequest";
import {
    PredictorColumnSubQuery, emptyPredictDictionary, objectArrayKey,
    type PredictDictionary, type PredictorPredictContext,
} from "./PredictorAlgorithm";
import { PredictorLogicQuery } from "./PredictorLogicQuery";

// Port of Signum.MachineLearning's PredictRequest.cs (its extension methods) — turning a prediction into
// the editable model the page shows, and back.
//
// Three directions, and each is one function below:
//   - createPredictModel  : a PredictDictionary (inputs, and optionally the real outputs) to the DTO.
//   - inputsFromRequest   : the DTO the page posted back to a PredictDictionary to predict from.
//   - setOutput           : a fresh prediction written INTO the DTO, preserving the originals.
//
// altea divergences, documented inline:
//  - a token is a STRING in the DTO (see data/PredictRequest.ts), so the builder writes the token string
//    and the reader resolves through `QueryLogic.getToken` — Signum ships a `QueryTokenTS` and matches on
//    `token.fullKey`.
//  - a `ParseValues` pass over every value (`JsonElement.ToObject(token.Type)`) is unnecessary: the body has
//    already been through the entity Serializer (so a Lite arrives decoded), and what is left — an enum
//    member name, a date string, a decimal string — is exactly what `deserializeFilterValue` coerces
//    against a token. So the coercion is that one call rather than a private converter.
//  - the sub-query ROWS come from the CODIFICATIONS, where Signum reads
//    `pctx.SubQueryOutputCodifications[sq].Groups`. Same information: a codification of a sub-query column
//    carries the SplitBy `keys` it belongs to, and those distinct keys ARE the rows. Deriving it means the
//    predict context needs no second index of its own.

export namespace PredictRequestBuilder {

    // ---- the columns of a sub-query, split by role -----------------------------------------------------

    /**
     * A sub-query's columns are (one ParentKey, then the SplitBy keys, then the
     * values), and that order IS the row layout. The ParentKey is dropped: it identifies the entity being
     * predicted about, which the whole request is about already.
     */
    function splitColumns(sq: PredictorSubQueryEntity): {
        splitKeys: PredictorSubQueryEntity_Column[];
        values: PredictorSubQueryEntity_Column[];
    } {
        const columns = sq.columns.orderBy(a => a.rowOrder);
        return {
            splitKeys: columns.filter(c => c.usage === PredictorSubQueryColumnUsage.SplitBy),
            values: columns.filter(c => c.usage === PredictorSubQueryColumnUsage.Input
                || c.usage === PredictorSubQueryColumnUsage.Output),
        };
    }

    function mainColumns(predictor: PredictorEntity): PredictorEntity_Column[] {
        return predictor.columns.orderBy(a => a.rowOrder);
    }

    function subQueriesOf(predictor: PredictorEntity): PredictorSubQueryEntity[] {
        return predictor.subQueries.orderBy(a => a.rowOrder);
    }

    /**
     * The distinct SplitBy keys a trained predictor has slots for — the rows of a sub-query's table.
     *
     * Read off the codifications (see the header), in the order the codifications were assigned, which is
     * the order the training saw them.
     */
    function splitKeysOf(ctx: PredictorPredictContext, sq: PredictorSubQueryEntity): unknown[][] {
        const seen = new Map<string, unknown[]>();
        for (const cod of ctx.codifications) {
            const col = cod.column;
            if (col instanceof PredictorColumnSubQuery && col.subQuery.id === sq.id) {
                const key = objectArrayKey(col.keys);
                if (!seen.has(key))
                    seen.set(key, col.keys);
            }
        }
        return [...seen.values()];
    }

    // ---- dictionary -> DTO -----------------------------------------------------------------------------

    /**
     * The model the page renders.
     *
     * `originalOutputs` is what makes a prediction ABOUT a real row worth looking at: with it, each output
     * comes back as {predicted, original} so the page can colour agreement green and disagreement red.
     * Without it (a hand-built what-if) the output is the bare prediction.
     */
    export function createPredictModel(
        ctx: PredictorPredictContext,
        inputs: PredictDictionary | null,
        originalOutputs: PredictDictionary | null,
        predictedOutputs: PredictDictionary,
    ): PredictRequestModel {
        const predictor = ctx.predictor;
        const hasOriginal = originalOutputs != null;

        const columns: PredictColumnModel[] = mainColumns(predictor).map(col => ({
            token: col.token.tokenString,
            usage: col.usage,
            value: col.usage === PredictorColumnUsage.Input
                ? inputs?.mainQueryValues.get(col) ?? null
                : !hasOriginal
                    ? predictedOutputs.mainQueryValues.get(col) ?? null
                    : {
                        original: originalOutputs.mainQueryValues.get(col) ?? null,
                        predicted: predictedOutputs.mainQueryValues.get(col) ?? null,
                    },
        }));

        const tables: PredictSubQueryTableModel[] = subQueriesOf(predictor).map(sq => {
            const { splitKeys, values } = splitColumns(sq);

            const columnHeaders: PredictSubQueryHeaderModel[] = [
                ...splitKeys.map((k): PredictSubQueryHeaderModel => ({
                    token: k.token.tokenString, headerType: "Key",
                })),
                ...values.map((v): PredictSubQueryHeaderModel => ({
                    token: v.token.tokenString,
                    headerType: v.usage === PredictorSubQueryColumnUsage.Input ? "Input" : "Output",
                })),
            ];

            const inputsSQ = inputs?.subQueryValues.get(sq);
            const originalSQ = originalOutputs?.subQueryValues.get(sq);
            const predictedSQ = predictedOutputs.subQueryValues.get(sq);

            const rows = splitKeysOf(ctx, sq).map(key => {
                const k = objectArrayKey(key);
                const inputsGroup = inputsSQ?.get(k);
                const originalGroup = originalSQ?.get(k);
                const predictedGroup = predictedSQ?.get(k);

                return [
                    ...key,
                    ...values.map(v => v.usage === PredictorSubQueryColumnUsage.Input
                        ? inputsGroup?.get(v) ?? null
                        : !hasOriginal
                            ? predictedGroup?.get(v) ?? null
                            : {
                                original: originalGroup?.get(v) ?? null,
                                predicted: predictedGroup?.get(v) ?? null,
                            }),
                ];
            });

            return { subQuery: sq.toLite(), columnHeaders, rows };
        });

        return {
            predictor: predictor.toLite(),
            hasOriginal,
            alternativesCount: null,
            columns,
            subQueries: tables,
        };
    }

    // ---- DTO -> dictionary -----------------------------------------------------------------------------

    /**
     * Read the edited inputs back out of the posted model.
     *
     * Only the INPUTS are read: whatever the page happens to be showing as an output is the previous
     * prediction, and re-feeding it would make the answer depend on the answer.
     */
    export function inputsFromRequest(
        ctx: PredictorPredictContext, request: PredictRequestModel,
    ): PredictDictionary {
        const predictor = ctx.predictor;
        const dic = emptyPredictDictionary(predictor);
        const queryName = PredictorLogicQuery.queryNameOf(predictor);
        const options = PredictorLogicQuery.mainOptions(predictor);

        const columns = mainColumns(predictor);
        if (request.columns.length !== columns.length)
            // The predictor's definition changed under the open page; re-opening rebuilds it.
            throw new Error(`The request carries ${request.columns.length} columns, `
                + `the predictor has ${columns.length}`);

        columns.forEach((col, i) => {
            if (col.usage !== PredictorColumnUsage.Input)
                return;
            const token = QueryLogic.getToken(queryName, col.token.tokenString, options);
            dic.mainQueryValues.set(col, coerce(token, request.columns[i]!.value));
        });

        for (const sq of subQueriesOf(predictor)) {
            const table = request.subQueries.find(t => t.subQuery.id === sq.id);
            if (table == null)
                throw new Error(`The request carries no table for sub-query '${sq.name}'`);

            const { splitKeys, values } = splitColumns(sq);
            const sqQueryName = QueryLogic.toQueryName(sq.query.key);
            const sqTokens = [...splitKeys, ...values].map(c =>
                QueryLogic.getToken(sqQueryName, c.token.tokenString, options));

            const groups = new Map<string, Map<PredictorSubQueryEntity_Column, unknown>>();
            for (const row of table.rows) {
                const key = splitKeys.map((_, i) => coerce(sqTokens[i]!, row[i]));
                const group = new Map<PredictorSubQueryEntity_Column, unknown>();
                values.forEach((v, i) => {
                    if (v.usage === PredictorSubQueryColumnUsage.Input)
                        group.set(v, coerce(sqTokens[splitKeys.length + i]!, row[splitKeys.length + i]));
                });
                groups.set(objectArrayKey(key), group);
            }

            dic.subQueryValues.set(sq, groups);
        }

        return dic;
    }

    /**
     * Write a fresh prediction into the model the page posted, leaving the inputs
     * (and each output's `original`) exactly as they were.
     */
    export function setOutput(request: PredictRequestModel, predicted: PredictDictionary): void {
        const predictor = predicted.predictor;

        mainColumns(predictor).forEach((col, i) => {
            if (col.usage !== PredictorColumnUsage.Output)
                return;
            const cell = request.columns[i]!;
            const value = predicted.mainQueryValues.get(col) ?? null;
            cell.value = isPredictOutputTuple(cell.value)
                ? { original: cell.value.original, predicted: value }
                : value;
        });

        for (const sq of subQueriesOf(predictor)) {
            const table = request.subQueries.find(t => t.subQuery.id === sq.id);
            if (table == null)
                continue;

            const { splitKeys, values } = splitColumns(sq);
            const groups = predicted.subQueryValues.get(sq);

            for (const row of table.rows) {
                const group = groups?.get(objectArrayKey(row.slice(0, splitKeys.length)));
                values.forEach((v, i) => {
                    if (v.usage !== PredictorSubQueryColumnUsage.Output)
                        return;
                    const at = splitKeys.length + i;
                    const value = group?.get(v) ?? null;
                    const existing = row[at];
                    row[at] = isPredictOutputTuple(existing)
                        ? { original: existing.original, predicted: value }
                        : value;
                });
            }
        }
    }

    /**
     * A posted value, coerced against its token.
     *
     * `EqualTo` is passed only because that is the parameter `deserializeFilterValue` uses to decide
     * whether the value is a LIST — a prediction input never is.
     */
    function coerce(token: QueryToken, raw: unknown): unknown {
        return deserializeFilterValue(token, FilterOperationKeys.EqualTo, raw);
    }

    /** The usage of a sub-query column as the main enum — for a caller reading the header type. */
    export function usageOf(column: PredictorSubQueryEntity_Column): PredictorColumnUsage {
        return toPredictorColumnUsage(column.usage);
    }
}
