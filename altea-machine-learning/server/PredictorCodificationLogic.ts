import "@altea/altea/server"; // installs Entity.save()/delete()
import { table } from "@altea/altea/server/table";
import { Saver } from "@altea/altea/server/saver";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { SubTokensOptions } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { FilterTypeKeys } from "@altea/altea/data/dynamicQuery/queryUtils";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { toFloat, toInt } from "@altea/altea/data/basics";
import {
    PredictorCodificationEntity, PredictorColumnUsage, PredictorEntity, PredictorSubQueryColumnUsage,
} from "../data/Predictor";
import {
    PredictorCodification, PredictorColumnMain, PredictorColumnSubQuery,
} from "./PredictorAlgorithm";
import { PredictorLogicQuery } from "./PredictorLogicQuery";
import { parseFilterValue, stringifyFilterValue } from "@altea/altea-user-assets/data/FilterValueString";

// Port of Signum.MachineLearning's PredictorCodificationLogic.cs — persist the slot assignment, and read
// it back.
//
// Why it is persisted at all: a codification is a POSITION in the model's input vector plus, for a
// normalizing encoding, the statistics that scale a value into it. The model on disk is meaningless
// without both. Retraining reassigns them (new distinct values, a new distribution), which is why the old
// rows are deleted first — a prediction that mixed a new model with old codifications would feed the
// right numbers into the wrong slots and be confidently wrong.

export namespace PredictorCodificationLogic {

    /** Signum's `SaveCodifications` — replace this predictor's rows with the ones just assigned. */
    export async function saveCodifications(
        predictor: PredictorEntity, codifications: PredictorCodification[],
    ): Promise<void> {
        await ExecutionMode.global(async () => {
            await deleteCodifications(predictor);

            const rows = codifications.map(c => {
                const main = c.column as PredictorColumnMain;
                const sub = c.column as PredictorColumnSubQuery;
                const isSub = sub.subQuery != null;

                return PredictorCodificationEntity.create({
                    predictor: predictor.toLite(),
                    usage: c.column.usage,
                    index: toInt(c.index),
                    subQueryIndex: isSub ? toInt(indexOfSubQuery(predictor, sub)) : null,
                    originalColumnIndex: toInt(isSub ? sub.predictorColumnIndex : main.predictorColumnIndex),
                    // Signum keeps three split keys, which is the practical limit of a fixed-column
                    // flattening — a fourth would mean a table per predictor.
                    splitKey0: keyAt(sub, isSub, 0),
                    splitKey1: keyAt(sub, isSub, 1),
                    splitKey2: keyAt(sub, isSub, 2),
                    // Signum's `ToStringValue`: a Lite is stored by its KEY, everything else through
                    // the filter-value converter. It cannot be a plain `String(value)`: a Lite's
                    // toString is its DISPLAY text, while the one-hot dictionary looks a value up by
                    // `lite.key()` — so a stored "Margaret Peacock" never matched the incoming
                    // "Employee;4", every one-hot slot stayed 0, and a prediction over a categorical
                    // column silently answered as if the value were unknown. It trains fine (the values
                    // are still live objects there), which is exactly why it goes unnoticed.
                    isValue: isValueString(c, 100),
                    // `float` columns (Signum declares them `float?`), so brand the computed numbers.
                    average: c.average == null ? null : toFloat(c.average),
                    stdDev: c.stdDev == null ? null : toFloat(c.stdDev),
                    min: c.min == null ? null : toFloat(c.min),
                    max: c.max == null ? null : toFloat(c.max),
                });
            });

            // ONE save for every row: a predictor over a wide one-hot column has thousands of them, and
            // a save each would be thousands of round trips.
            await Saver.save(rows as never[]);
        });
    }

    export async function deleteCodifications(predictor: PredictorEntity): Promise<void> {
        await ExecutionMode.global(async () => {
            const id = predictor.id;
            await table(PredictorCodificationEntity).filter(c => c.predictor.id == id).executeDelete();
        });
    }

    /**
     * Signum's `RetrieveCodifications` — rebuild the runtime codifications from the stored rows, so a
     * prediction uses exactly the slot assignment the training produced.
     *
     * The columns are rebuilt from the predictor's own definition (the stored row carries only INDEXES
     * into it), which is also the check that matters: a predictor edited since training no longer lines
     * up, and that surfaces here rather than as a wrong prediction.
     */
    export async function retrieveCodifications(predictor: PredictorEntity): Promise<PredictorCodification[]> {
        const id = predictor.id;
        const rows = await ExecutionMode.global(async () =>
            await table(PredictorCodificationEntity).filter(c => c.predictor.id == id)
                .toArray() as PredictorCodificationEntity[]);

        const mainQueryName = PredictorLogicQuery.queryNameOf(predictor);
        const mainOptions = PredictorLogicQuery.mainOptions(predictor);
        const mainColumns = [...predictor.columns].sort((a, b) => (a.order as number) - (b.order as number));
        const subQueries = [...predictor.subQueries].sort((a, b) => (a.order as number) - (b.order as number));

        // One runtime COLUMN per distinct (sub-query, column index, split keys) — the codifications of a
        // one-hot column must share the column object, because that is where its value→slot memo lives.
        const columnCache = new Map<string, PredictorColumnMain | PredictorColumnSubQuery>();

        return rows
            .sort((a, b) => (a.index as number) - (b.index as number))
            .map(row => {
                const cacheKey = [row.subQueryIndex, row.originalColumnIndex, row.splitKey0, row.splitKey1, row.splitKey2].join("|");
                let column = columnCache.get(cacheKey);

                if (column == null) {
                    if (row.subQueryIndex == null) {
                        const col = mainColumns[row.originalColumnIndex as number];
                        if (col == null)
                            throw new Error(codificationMismatch(predictor, `main column ${row.originalColumnIndex}`));
                        column = new PredictorColumnMain(col, row.originalColumnIndex as number,
                            QueryLogic.getToken(mainQueryName, col.token.tokenString, mainOptions));
                    } else {
                        const sq = subQueries[row.subQueryIndex as number];
                        if (sq == null)
                            throw new Error(codificationMismatch(predictor, `sub-query ${row.subQueryIndex}`));
                        const sqColumns = [...sq.columns].sort((a, b) => (a.order as number) - (b.order as number));
                        const col = sqColumns[row.originalColumnIndex as number];
                        if (col == null)
                            throw new Error(codificationMismatch(predictor, `sub-query column ${row.originalColumnIndex}`));

                        const splitBy = sqColumns.filter(c => c.usage === PredictorSubQueryColumnUsage.SplitBy);
                        const keys = [row.splitKey0, row.splitKey1, row.splitKey2]
                            .filter(k => k != null)
                            .map((k, i) => {
                                const col = splitBy[i];
                                if (col == null)
                                    return k;
                                const t = QueryLogic.getToken(QueryLogic.toQueryName(sq.query.key),
                                    col.token.tokenString, SubTokensOptions.CanElement | SubTokensOptions.CanAggregate);
                                return parseFilterValue(k, t.filterType) ?? k;
                            });
                        column = new PredictorColumnSubQuery(col, row.originalColumnIndex as number, sq, keys,
                            QueryLogic.getToken(QueryLogic.toQueryName(sq.query.key), col.token.tokenString,
                                SubTokensOptions.CanElement | SubTokensOptions.CanAggregate));
                    }
                    columnCache.set(cacheKey, column);
                }

                const c = new PredictorCodification(column);
                c.index = row.index as number;
                // Signum's `ParseValue`: back into a typed value, so the one-hot dictionary keys it the
                // same way the training did AND a decoded prediction hands the caller a real Lite rather
                // than the stored text (see the write side).
                c.isValue = row.isValue == null ? null
                    : parseFilterValue(row.isValue, column.token.filterType) ?? row.isValue;
                c.average = row.average;
                c.stdDev = row.stdDev;
                c.min = row.min;
                c.max = row.max;
                return c;
            });
    }

    function codificationMismatch(predictor: PredictorEntity, what: string): string {
        return `Predictor '${predictor.name ?? predictor.id}' has a stored codification referring to ${what}, `
            + `which its current definition does not have — it was edited since it was trained. Retrain it.`;
    }

    function indexOfSubQuery(predictor: PredictorEntity, column: PredictorColumnSubQuery): number {
        const sorted = [...predictor.subQueries].sort((a, b) => (a.order as number) - (b.order as number));
        const index = sorted.indexOf(column.subQuery);
        if (index < 0)
            throw new Error(`Sub-query '${column.subQuery.name}' is not part of predictor '${predictor.name}'`);
        return index;
    }

    function keyAt(column: PredictorColumnSubQuery, isSub: boolean, i: number): string | null {
        if (!isSub)
            return null;
        const key = column.keys[i];
        if (key == null)
            return null;
        // Same rule as isValue above (Signum's `GetSplitpKey` calls the same `ToStringValue`): a Lite
        // split key is stored by its key, so two employees with the same display name cannot collapse
        // into one slot.
        return truncate(stringifyFilterValue(key, filterTypeOfKey(column, i)) ?? String(key), 100);
    }

    /** The stored form of a codification's one-hot value. */
    function isValueString(c: PredictorCodification, max: number): string | null {
        if (c.isValue == null)
            return null;
        const s = stringifyFilterValue(c.isValue, c.column.token.filterType);
        return s == null ? null : truncate(s, max);
    }

    /**
     * The filter type of a sub-query's Nth SplitBy column.
     *
     * Resolved off the column's already-resolved token where possible; a split key whose column cannot be
     * resolved falls back to plain stringification, which is what the value would have been anyway.
     */
    function filterTypeOfKey(column: PredictorColumnSubQuery, i: number): FilterTypeKeys | undefined {
        const splitBy = [...column.subQuery.columns]
            .sort((a, b) => (a.order as number) - (b.order as number))
            .filter(c => c.usage === PredictorSubQueryColumnUsage.SplitBy);
        const col = splitBy[i];
        if (col == null)
            return undefined;
        try {
            return QueryLogic.getToken(QueryLogic.toQueryName(column.subQuery.query.key), col.token.tokenString,
                SubTokensOptions.CanElement | SubTokensOptions.CanAggregate).filterType;
        } catch {
            return undefined;
        }
    }

    /** The three split-key columns are varchar(100) — a longer key is cut rather than failing the save. */
    function truncate(text: string, max: number): string {
        return text.length <= max ? text : text.substring(0, max - 1) + "…";
    }

    /** Signum's usage check, used by the savers: which sub-query columns carry data. */
    export function isDataColumn(usage: PredictorSubQueryColumnUsage): boolean {
        return usage === PredictorSubQueryColumnUsage.Input || usage === PredictorSubQueryColumnUsage.Output;
    }

    export function isOutput(usage: PredictorColumnUsage): boolean {
        return usage === PredictorColumnUsage.Output;
    }
}
