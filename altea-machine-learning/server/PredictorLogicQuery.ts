import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Column, Filter, FilterCondition, FilterGroup, Pagination, QueryRequest } from "@altea/altea/server/dynamicQuery/requests";
import type { ResultRow, ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { SubTokensOptions, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { getKey, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { QueryFilterUtils } from "@altea/altea-user-assets/server/QueryFilterUtils";
import {
    PredictorColumnUsage, PredictorEntity, PredictorSubQueryColumnUsage, PredictorSubQueryEntity,
} from "../data/Predictor";
import {
    PredictorCodification, PredictorColumnMain, PredictorColumnSubQuery, objectArrayKey,
    type IPredictorAlgorithm, type PredictorColumnBase, type PredictorTrainingContext,
} from "./PredictorAlgorithm";

// Port of Signum.MachineLearning's PredictorLogicQuery.cs — run the queries and turn their rows into the
// codified vectors the network trains on.
//
// The interesting mechanic is the SUB-QUERY flattening, because it is what lets a predictor learn from a
// one-to-many relationship at all. A network's input is a fixed-width vector, but "this order's lines"
// is a variable number of rows. A sub-query resolves that with two structural column usages:
//   • `ParentKey` — how a sub-query row joins back to a main-query row;
//   • `SplitBy`   — the value that turns "the rows" into a fixed SET of slots. With SplitBy = the
//     product's category, an order contributes one slot per category, whatever its line count.
// Every distinct SplitBy value seen across the training data becomes its own column, and a row that has
// no line for that value simply leaves those slots at their null handling.
//
// altea divergences, documented inline:
//  - the main query's filters and columns live on the PREDICTOR rather than inside
//    PredictorMainQueryEmbedded (see data/Predictor's header on why a `@part` row needs a real owner).
//  - `QueryDescription` is gone, so a stored token is resolved through `QueryLogic.getToken` against the
//    query NAME, and a token that no longer resolves throws HERE with the predictor named — rather than
//    being precomputed into a ParseException the entity carries.
//  - Signum's `ObjectArrayComparer` becomes `objectArrayKey` (a joined string), because a JS Map takes no
//    structural comparer.
//  - `HeavyProfiler` scopes are dropped; @altea/altea-profiler instruments the query layer already.

export namespace PredictorLogicQuery {

    /** What the main query produced, and how to read a row's parent key out of it. */
    export interface MainQueryResult {
        request: QueryRequest;
        resultTable: ResultTable;
        /** The identity a sub-query row joins against. */
        getParentKey: (row: ResultRow) => unknown[];
    }

    /** What one sub-query produced, grouped ready for flattening. */
    export interface SubQueryResult {
        subQuery: PredictorSubQueryEntity;
        request: QueryRequest;
        resultTable: ResultTable;
        /** parent key → (SplitBy key → the value columns of that row). */
        groupedValues: Map<string, Map<string, unknown[]>>;
        /** The DISTINCT SplitBy keys across every parent, sorted — these become the slots. */
        distinctSplitKeys: string[];
        /** The indexes (within the sub-query's own column list) of its value columns. */
        valueColumnIndexes: number[];
    }

    /**
     * Execute everything, generate the codifications, and fill the
     * training / validation row sets.
     */
    export async function retrieveData(ctx: PredictorTrainingContext, algorithm: IPredictorAlgorithm): Promise<void> {
        const predictor = ctx.predictor;

        ctx.reportProgress(`Executing the main query for ${predictor.name ?? ""}`);
        const main = await executeMainQuery(predictor);

        const subQueries: SubQueryResult[] = [];
        for (const sq of [...predictor.subQueries].sort((a, b) => (a.order as number) - (b.order as number))) {
            ctx.reportProgress(`Executing sub-query ${sq.name}`);
            subQueries.push(await executeSubQuery(predictor, sq));
        }

        ctx.reportProgress("Creating columns");

        // ---- the codifications ------------------------------------------------------------------------
        const codifications: PredictorCodification[] = [];
        const mainQueryName = queryNameOf(predictor);

        const orderedColumns = [...predictor.columns].sort((a, b) => (a.order as number) - (b.order as number));
        orderedColumns.forEach((col, i) => {
            const resolved = resolveToken(mainQueryName, col.token.tokenString, mainOptions(predictor));
            const mainCol = new PredictorColumnMain(col, i, resolved);
            codifications.push(...algorithm.generateCodifications(col.encoding, main.resultTable.columns[i]!.values, mainCol));
        });

        // A sub-query contributes one column PER (SplitBy key × value column) — see the module header.
        for (const sq of subQueries) {
            const sqColumns = [...sq.subQuery.columns].sort((a, b) => (a.order as number) - (b.order as number));
            const sqQueryName = QueryLogic.toQueryName(sq.subQuery.query.key);

            for (const splitKey of sq.distinctSplitKeys) {
                for (const valueIndex of sq.valueColumnIndexes) {
                    const col = sqColumns[valueIndex]!;
                    const resolved = resolveToken(sqQueryName, col.token.tokenString,
                        SubTokensOptions.CanElement | SubTokensOptions.CanAggregate);
                    const subCol = new PredictorColumnSubQuery(col, valueIndex, sq.subQuery, [splitKey], resolved);
                    // The values this slot has ACROSS the training data, so the encoding can fit on them.
                    const values = [...sq.groupedValues.values()]
                        .map(byKey => byKey.get(splitKey)?.[positionOf(sq, valueIndex)])
                        .filter(v => v !== undefined);
                    codifications.push(...algorithm.generateCodifications(col.encoding!, values, subCol));
                }
            }
        }

        setCodifications(ctx, codifications);

        // ---- the rows ---------------------------------------------------------------------------------
        ctx.reportProgress("Codifying rows");
        const rows = main.resultTable.rows.map(row => {
            const inputs = new Float32Array(ctx.inputCodifications.length);
            const outputs = new Float32Array(ctx.outputCodifications.length);
            const parentKey = objectArrayKey(main.getParentKey(row));

            for (const [column, cods] of allColumns(ctx)) {
                const value = readValue(column, row, main, subQueries, parentKey);
                const target = column.usage === PredictorColumnUsage.Input ? inputs : outputs;
                // Through the ALGORITHM, so a custom encoding an app registered is reached the same way
                // its codifications were generated.
                algorithm.encodeValue(column, cods, value, target);
            }

            return { entity: row.entity as Lite<Entity> | null, inputs, outputs };
        });

        // The `testPercentage` split, with `seed` making it reproducible — which matters: comparing
        // two trainings is meaningless if they held back different rows.
        const shuffled = shuffle(rows, predictor.settings.seed as number | null);
        const testCount = Math.round(shuffled.length * predictor.settings.testPercentage);
        ctx.validation = shuffled.slice(0, testCount);
        ctx.training = shuffled.slice(testCount);
    }

    /** Assign each slot its index within its own vector, then group. */
    export function setCodifications(ctx: PredictorTrainingContext, codifications: PredictorCodification[]): void {
        ctx.codifications = codifications;
        ctx.inputCodifications = codifications.filter(c => c.column.usage === PredictorColumnUsage.Input);
        ctx.outputCodifications = codifications.filter(c => c.column.usage === PredictorColumnUsage.Output);

        // The index is per VECTOR, not global — the inputs and the outputs are separate tensors.
        ctx.inputCodifications.forEach((c, i) => c.index = i);
        ctx.outputCodifications.forEach((c, i) => c.index = i);

        ctx.inputCodificationsByColumn = groupByColumn(ctx.inputCodifications);
        ctx.outputCodificationsByColumn = groupByColumn(ctx.outputCodifications);
    }

    function groupByColumn(list: PredictorCodification[]): Map<PredictorColumnBase, PredictorCodification[]> {
        const map = new Map<PredictorColumnBase, PredictorCodification[]>();
        for (const c of list) {
            const existing = map.get(c.column);
            if (existing != null) existing.push(c);
            else map.set(c.column, [c]);
        }
        return map;
    }

    function allColumns(ctx: PredictorTrainingContext): [PredictorColumnBase, PredictorCodification[]][] {
        return [...ctx.inputCodificationsByColumn, ...ctx.outputCodificationsByColumn];
    }

    /** Read the value one column contributes for one main-query row. */
    function readValue(
        column: PredictorColumnBase, row: ResultRow, main: MainQueryResult,
        subQueries: SubQueryResult[], parentKey: string,
    ): unknown {
        const asMain = column as PredictorColumnMain;
        if (asMain.predictorColumn != null)
            return row.value(asMain.predictorColumnIndex);

        const asSub = column as PredictorColumnSubQuery;
        const sq = subQueries.find(s => s.subQuery === asSub.subQuery);
        if (sq == null)
            return null;

        const byKey = sq.groupedValues.get(parentKey);
        const values = byKey?.get(String(asSub.keys[0]));
        return values?.[positionOf(sq, asSub.predictorColumnIndex)] ?? null;
    }

    /** Where a sub-query column's value sits within the row's VALUE columns (the non-structural ones). */
    function positionOf(sq: SubQueryResult, columnIndex: number): number {
        return sq.valueColumnIndexes.indexOf(columnIndex);
    }

    // ---- the requests ----------------------------------------------------------------------------------

    export function mainQueryRequest(predictor: PredictorEntity): QueryRequest {
        const queryName = queryNameOf(predictor);
        const options = mainOptions(predictor);

        return new QueryRequest(
            queryName,
            QueryFilterUtils.toFilterList(queryName, predictor.filters),
            [],
            [...predictor.columns]
                .sort((a, b) => (a.order as number) - (b.order as number))
                .map(c => new Column(resolveToken(queryName, c.token.tokenString, options))),
            new Pagination.All(),
            predictor.mainQuery.groupResults,
        );
    }

    async function executeMainQuery(predictor: PredictorEntity): Promise<MainQueryResult> {
        const request = mainQueryRequest(predictor);
        const resultTable = await QueryLogic.queries.executeQueryAsync(request);

        // An ungrouped query is identified by its ENTITY; a grouped one by its non-aggregate
        // columns, because there is no single entity behind a group.
        const getParentKey = !request.groupResults
            ? (row: ResultRow): unknown[] => [row.entity]
            : (() => {
                const plain = request.columns
                    .map((c, i) => ({ c, i }))
                    .filter(({ c }) => !isAggregate(c.token))
                    .map(({ i }) => i);
                return (row: ResultRow): unknown[] => plain.map(i => row.value(i));
            })();

        return { request, resultTable, getParentKey };
    }

    /**
     * The sub-query, filtered so it only sees the rows
     * belonging to the main query's population.
     *
     * The `prependToken` step is what makes that work when the sub-query runs over a DIFFERENT query: a
     * main-query filter on `state` becomes a filter on `<parentKey>.state`, so "orders in this state" and
     * "the lines OF orders in this state" select the same population.
     */
    export function subQueryRequest(predictor: PredictorEntity, sq: PredictorSubQueryEntity): QueryRequest {
        const sqQueryName = QueryLogic.toQueryName(sq.query.key);
        const mainQueryName = queryNameOf(predictor);
        const options = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate;

        const parentKeyColumn = sq.columns.find(c => c.usage === PredictorSubQueryColumnUsage.ParentKey);
        if (parentKeyColumn == null)
            throw new Error(`Sub-query '${sq.name}' has no ParentKey column`);

        const mainFilters = QueryFilterUtils.toFilterList(mainQueryName, predictor.filters);
        const sameQuery = sq.query.key === predictor.mainQuery.query.key;
        const prefix = sameQuery ? null : resolveToken(sqQueryName, parentKeyColumn.token.tokenString, options);

        const filters = [
            ...(prefix == null ? mainFilters : mainFilters.map(f => prependToken(f, prefix, sqQueryName, options))),
            ...QueryFilterUtils.toFilterList(sqQueryName, sq.filters),
        ];

        return new QueryRequest(
            sqQueryName,
            filters,
            [],
            [...sq.columns]
                .sort((a, b) => (a.order as number) - (b.order as number))
                .map(c => new Column(resolveToken(sqQueryName, c.token.tokenString, options))),
            new Pagination.All(),
            // ALWAYS grouped: a sub-query's job is to aggregate the many rows per parent into one value
            // per (parent, SplitBy) pair.
            true,
        );
    }

    async function executeSubQuery(predictor: PredictorEntity, sq: PredictorSubQueryEntity): Promise<SubQueryResult> {
        const request = subQueryRequest(predictor, sq);
        const resultTable = await QueryLogic.queries.executeQueryAsync(request);

        const sqColumns = [...sq.columns].sort((a, b) => (a.order as number) - (b.order as number));
        const parentIndexes = indexesWhere(sqColumns, c => c.usage === PredictorSubQueryColumnUsage.ParentKey);
        const splitIndexes = indexesWhere(sqColumns, c => c.usage === PredictorSubQueryColumnUsage.SplitBy);
        const valueColumnIndexes = indexesWhere(sqColumns,
            c => c.usage === PredictorSubQueryColumnUsage.Input || c.usage === PredictorSubQueryColumnUsage.Output);

        const groupedValues = new Map<string, Map<string, unknown[]>>();
        const splitKeys = new Set<string>();

        for (const row of resultTable.rows) {
            const parent = objectArrayKey(parentIndexes.map(i => row.value(i)));
            const split = objectArrayKey(splitIndexes.map(i => row.value(i)));
            splitKeys.add(split);

            let byKey = groupedValues.get(parent);
            if (byKey == null) {
                byKey = new Map();
                groupedValues.set(parent, byKey);
            }
            byKey.set(split, valueColumnIndexes.map(i => row.value(i)));
        }

        // Sorted, so the slot ORDER is stable across trainings — a model's input vector is positional, so
        // an unstable order would silently invalidate every saved model.
        const distinctSplitKeys = [...splitKeys].sort();

        return { subQuery: sq, request, resultTable, groupedValues, distinctSplitKeys, valueColumnIndexes };
    }

    export function prependToken(
        filter: Filter, prefix: QueryToken, queryName: QueryName, options: SubTokensOptions,
    ): Filter {
        if (filter instanceof FilterCondition)
            return new FilterCondition(appendToken(prefix, filter.token, queryName, options), filter.operation, filter.value);

        if (filter instanceof FilterGroup)
            return new FilterGroup(
                filter.groupOperation,
                filter.token == null ? undefined : appendToken(prefix, filter.token, queryName, options),
                filter.filters.map(f => prependToken(f, prefix, queryName, options)));

        throw new Error("Unexpected filter kind");
    }

    /**
     * Walk `suffix`'s own path onto `baseToken`.
     *
     * Signum's version special-cases the `Entity` step (skipping it when the types already match, else
     * inserting a `[CleanName]` cast). altea's rootless tokens make that unnecessary in the common case:
     * a stored token has no `Entity` prefix to skip.
     */
    export function appendToken(
        baseToken: QueryToken, suffix: QueryToken, _queryName: QueryName, options: SubTokensOptions,
    ): QueryToken {
        const steps: string[] = [];
        for (let t: QueryToken | undefined = suffix; t != null && t.parent != null; t = t.parent)
            steps.unshift(t.key);

        let token = baseToken;
        for (const step of steps) {
            const next = token.subToken(step, options);
            if (next == null)
                throw new Error(`Token '${step}' not found in '${token.fullKey()}'`);
            token = next;
        }
        return token;
    }

    // ---- helpers ---------------------------------------------------------------------------------------

    /** Aggregates are offered on the main query only when it GROUPS. */
    export function mainOptions(predictor: PredictorEntity): SubTokensOptions {
        return SubTokensOptions.CanElement
            | (predictor.mainQuery.groupResults ? SubTokensOptions.CanAggregate : 0);
    }

    export function queryNameOf(predictor: PredictorEntity): QueryName {
        return QueryLogic.toQueryName(predictor.mainQuery.query.key);
    }

    /** Resolve a stored token string, naming the predictor when it no longer resolves. */
    function resolveToken(queryName: QueryName, tokenString: string, options: SubTokensOptions): QueryToken {
        try {
            return QueryLogic.getToken(queryName, tokenString, options);
        } catch (e) {
            throw new Error(`Token '${tokenString}' does not resolve on query '${getKey(queryName)}' `
                + `— the schema changed since this predictor was defined `
                + `(see @altea/altea-user-assets' token migrations): ${(e as Error).message}`);
        }
    }

    function isAggregate(token: QueryToken): boolean {
        // An aggregate token's key is the aggregate function's name; altea's AggregateToken answers it.
        return token.constructor.name === "AggregateToken";
    }

    function indexesWhere<T>(list: T[], predicate: (x: T) => boolean): number[] {
        return list.map((x, i) => predicate(x) ? i : -1).filter(i => i >= 0);
    }

    /**
     * A deterministic shuffle when a seed is given, else a plain random one.
     *
     * The determinism is the point: two trainings of the same predictor must hold back the SAME rows, or
     * their metrics are not comparable — which is exactly what the Autoconfigure search compares.
     */
    function shuffle<T>(list: T[], seed: number | null): T[] {
        const result = [...list];
        const rand = seed == null ? Math.random : mulberry32(seed);
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [result[i], result[j]] = [result[j]!, result[i]!];
        }
        return result;
    }

    /** A small seeded PRNG — Node has none built in, and `Math.random` cannot be seeded. */
    function mulberry32(seed: number): () => number {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
}
