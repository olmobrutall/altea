import { reflect } from "@altea/altea/data/reflection";
import { ModelEntity, EmbeddedEntity } from "@altea/altea/data/entity";
import { stringLengthValidator, fieldValidation } from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { type int } from "@altea/altea/data/basics";
import type { TimeSeriesUnit } from "@altea/altea/data/dynamicQueries";
import { enumColumn } from "@altea/altea-user-assets/data/UserAssets";
import { AggregateToken } from "@altea/altea/data/dynamicQuery/tokens/aggregateToken";
import { ChartScriptSymbol, type ChartScript } from "./ChartScript";
import { ChartColumnEmbedded } from "./ChartColumn";
import { ChartParameterEmbedded } from "./ChartParameter";
import * as ChartUtils from "./ChartUtils";

// Port of Signum.Chart/ChartRequest.cs.

// Signum's IChartBase — the contract shared by ChartRequestModel and (later) UserChartEntity.
export interface IChartBase {
    chartScript: ChartScriptSymbol;
    getChartScript(): ChartScript;
    columns: ChartColumnEmbedded[];
    parameters: ChartParameterEmbedded[];
    maxRows: int | null;
    chartTimeSeries: ChartTimeSeriesEmbedded | null;
    fixParameters(chartColumnEntity: ChartColumnEmbedded): void;
}

// Signum's `ChartRequestModel.GetChartScriptFunc` — the resolver from a symbol to its registered
// ChartScript definition, installed by whichever tier is active (server: ChartScriptLogic; client:
// ChartClient after fetching /api/chart/scripts).
export let getChartScriptFunc: ((symbol: ChartScriptSymbol) => ChartScript) | null = null;
export function setGetChartScriptFunc(fn: (symbol: ChartScriptSymbol) => ChartScript): void {
    getChartScriptFunc = fn;
}

// Signum's ChartRequestModel — the transient (never-persisted) chart request DTO. altea divergences:
//  - Signum's `[InTypeScript(false)] object QueryName` (+ server queryKey serialization) becomes an
//    isomorphic `queryKey` string (the client already works in query keys).
//  - Signum's `[InTypeScript(false)] List<Filter> Filters` is not on the model — the chart editor carries
//    filters as FindOptions-style filter options alongside the request; the QueryRequest is assembled in
//    the request-builder (client ChartClient.getRequest / server), not on this isomorphic model. So
//    GetQueryColumns/GetQueryOrders/AllTokens/Multiplications/ToQueryRequest live there too.
//  - Signum's ChartScript SETTER (which runs SynchronizeColumns) has no altea equivalent (no property
//    setters); the editor calls ChartUtils.synchronizeColumns on change.
@reflect
export class ChartRequestModel extends ModelEntity implements IChartBase {
    // Signum's `object QueryName` — here the query's key string.
    queryKey: string = "";

    chartScript: ChartScriptSymbol;

    getChartScript(): ChartScript {
        return getChartScriptFunc!(this.chartScript);
    }

    // Signum's `[BindParent] MList<ChartColumnEmbedded> Columns`.
    columns: ChartColumnEmbedded[];

    // Signum's `[NoRepeatValidator] MList<ChartParameterEmbedded> Parameters`.
    parameters: ChartParameterEmbedded[];

    // Signum's `[NumberIsValidator(GreaterThan, 0)]`-free `int? MaxRows`.
    maxRows: int | null = null;

    chartTimeSeries: ChartTimeSeriesEmbedded | null = null;

    fixParameters(chartColumn: ChartColumnEmbedded): void {
        ChartUtils.fixParameters(this, chartColumn);
    }

    // Signum's HasAggregates(). altea divergence: filter-side aggregates are detected in the request-builder
    // (where the filters live); here we test the column tokens only.
    hasAggregates(): boolean {
        return this.columns.some(a => a.token?.token instanceof AggregateToken);
    }
}

// Signum's ChartTimeSeriesEmbedded — the optional time-series window. altea divergence: ToXml/FromXml and
// ToSystemTimeRequest are server-side (XML / SystemTimeRequest) and live with the server request-builder.
@reflect
export class ChartTimeSeriesEmbedded extends EmbeddedEntity {
    @stringLengthValidator({ max: 100 })
    startDate: string | null = null;

    @stringLengthValidator({ max: 100 })
    endDate: string | null = null;

    @enumColumn()
    timeSeriesUnit: TimeSeriesUnit | null = null;

    @fieldValidation<ChartTimeSeriesEmbedded>(t =>
        t.timeSeriesStep != null && t.timeSeriesStep <= 0 ? ValidationMessage.NumberIsTooSmall.niceToString() : null)
    timeSeriesStep: int | null = null;

    @fieldValidation<ChartTimeSeriesEmbedded>(t =>
        t.timeSeriesMaxRowsPerStep != null && t.timeSeriesMaxRowsPerStep <= 0 ? ValidationMessage.NumberIsTooSmall.niceToString() : null)
    timeSeriesMaxRowsPerStep: int | null = null;

    splitQueries: boolean = false;
}
