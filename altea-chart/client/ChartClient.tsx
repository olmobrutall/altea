import * as React from 'react'
import { ajaxGet } from '@altea/altea/client/Services';
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder';
import { ImportComponent } from '@altea/altea/client/ImportComponent';
import { Dic } from '@altea/altea/data/globals/index';
import { Localization } from '@altea/altea/data/utils/localization';
import type { Lite } from '@altea/altea/data/lite';
import type { Entity } from '@altea/altea/data/entity';
import type { OrderType } from '@altea/altea/data/dynamicQueries';
import type { QueryToken } from '@altea/altea/data/dynamicQuery/tokens/queryToken';
import { AggregateToken } from '@altea/altea/data/dynamicQuery/tokens/aggregateToken';
import type { QueryRequest, ColumnRequest, OrderRequest, ResultTable, SystemTime } from '@altea/altea/data/dynamicQuery/queryRequest';
import type { FilterOptionParsed } from '@altea/altea/client/FindOptions';
import { Finder } from '@altea/altea/client/Finder';
import { toNumberFormat } from '@altea/altea/client/numberFormat';
import * as DataChartUtils from '../data/ChartUtils';
import { ChartColumnType } from '../data/ChartScriptColumn';
import type { ChartParameterType, SpecialParameterType } from '../data/ChartScriptParameter';
import { ChartColumnEmbedded } from '../data/ChartColumn';
import { ChartParameterEmbedded } from '../data/ChartParameter';
import type { IChartBase, ChartRequestModel } from '../data/ChartRequest';
import { ChartScriptSymbol, D3ChartScript, HtmlChartScript, SvgMapsChartScript, GoogleMapsChartScript } from '../data/ChartScript';
import { ChartMessage } from '../data/ChartMessage';
import { colorSchemes, colorInterpolators, getColorInterpolation } from './ColorPalette/ColorUtils';
import type { MemoRepository } from './D3Scripts/Components/ReactChart';
import type { DashboardFilter } from './DashboardFilterStub';
// altea Array/String prototype extensions (.toObject/.first/.contains/.before/.after) — see ColorUtils.
import '@altea/altea/data/globals/arrayExtensions';
import '@altea/altea/data/globals/stringExtensions';

// The chart editor carries its filters as client-side FilterOptionParsed on the request instance (Signum's
// ChartRequestModel client field). altea keeps the data-layer ChartRequestModel free of the client-only
// filter type, so it is added here by declaration-merging — no data-layer coupling to the client.
declare module '../data/ChartRequest' {
  interface ChartRequestModel {
    filterOptions: FilterOptionParsed[];
  }
}

// Partial port of Signum.Chart/ChartClient.tsx — the keystone every renderer + the editor import. This
// slice covers the client ChartScript DTO shapes, the render data contracts, the renderer registry, the
// script catalog fetch, and the parameter/column logic. Deferred to later slices (documented on the task):
// start()/routes, getActiveDetector + drilldown (Dashboard/UserQuery), the data bridge (getRequest /
// toChartResult), ButtonBarChart, ChartOptions.
//
// altea divergences:
//  - The client column-type logic REUSES the isomorphic data/ChartUtils (numeric [Flags] ChartColumnType +
//    bitwise flag()), instead of Signum's parallel string-union client copy.
//  - Signum MList wrappers → altea plain arrays: `chart.columns.map(mle => mle.element)` becomes plain
//    `ChartColumnEmbedded[]`; `{ rowId, element }` rows and `ChartColumnEmbedded.New()` become
//    `new ChartColumnEmbedded()`.
//  - The wire ChartScript carries `symbol` as the symbol KEY string (see ChartServer.server); fetchScripts
//    resolves it back to the declared ChartScriptSymbol instance.

export namespace ChartClient {

  // Partial port of Signum's ChartClient.start. Registers the chart request page route + the (currently one)
  // renderer component. Deferred: the SearchControl chart button, Omnibox, UserChart/ColorPalette starts,
  // and the remaining renderer registrations (added as each D3Scripts/*.tsx is ported).
  export function start(cb: ClientBuilder): void {
    cb.routes.push({
      path: "/chart/:queryName",
      element: <ImportComponent onImport={() => import("./Templates/ChartRequestPage")} />,
    });

    registerChartScriptComponent(D3ChartScript.Columns, () => import("./D3Scripts/Columns"));
  }

  // ---- Client ChartScript DTO (the shape shipped from /api/chart/scripts; see ChartServer.server) --------

  export interface ChartScript {
    symbol: ChartScriptSymbol;
    icon: string | null;
    columns: ChartScriptColumn[];
    parameterGroups: ChartScriptParameterGroup[];
  }

  export interface ChartScriptColumn {
    name: string;
    displayName: string;
    isOptional: boolean;
    columnType: ChartColumnType;
  }

  export interface ChartScriptParameterGroup {
    name: string | null;
    parameters: ChartScriptParameter[];
  }

  export interface ChartScriptParameter {
    name: string;
    displayName: string;
    columnIndex: number | null;
    type: ChartParameterType;
    valueDefinition: NumberInterval | EnumValueList | StringValue | SpecialParameter | Scala | null;
  }

  export interface NumberInterval {
    defaultValue: number | null;
    minValue: number | null;
    maxValue: number | null;
  }

  export interface SpecialParameter {
    specialParameterType: SpecialParameterType;
  }

  export interface Scala {
    standardScalas: Record<string, ChartColumnType | null>;
    custom: boolean;
  }

  // altea divergence: Signum's client EnumValueList `extends Array<string>`; the wire sends `{ values }`.
  export interface EnumValueList {
    values: string[];
  }

  export interface StringValue {
    defaultValue: string;
  }

  // ---- Script catalog ------------------------------------------------------------------------------------

  let chartScripts: Promise<ChartScript[]>;
  export function getChartScripts(): Promise<ChartScript[]> {
    return chartScripts ??= API.fetchScripts();
  }

  export function getChartScript(symbol: ChartScriptSymbol): Promise<ChartScript> {
    if (symbol.key == null)
      throw new Error("User has not access to ChartScriptSymbol");

    return getChartScripts().then(cs => cs.single(a => a.symbol.key == symbol.key));
  }

  // The declared ChartScriptSymbol instances, by key — used to resolve the wire ChartScript.symbol string.
  let _symbolsByKey: Record<string, ChartScriptSymbol> | undefined;
  function symbolsByKey(): Record<string, ChartScriptSymbol> {
    return _symbolsByKey ??= [D3ChartScript, HtmlChartScript, SvgMapsChartScript, GoogleMapsChartScript]
      .flatMap(container => Object.values(container) as ChartScriptSymbol[])
      .toObject(s => s.key);
  }

  // ---- Renderer registry (symbol → lazy renderer module) -------------------------------------------------

  interface ChartScriptModule {
    default: ((p: ChartScriptProps) => React.ReactNode);
  }

  const registeredChartScriptComponents: { [key: string]: () => Promise<ChartScriptModule> } = {};

  export function registerChartScriptComponent(symbol: ChartScriptSymbol, module: () => Promise<ChartScriptModule>): void {
    registeredChartScriptComponents[symbol.key] = module;
  }

  export function getRegisteredChartScriptComponent(symbol: ChartScriptSymbol): () => Promise<ChartScriptModule> {
    var result = registeredChartScriptComponents[symbol.key];
    if (!result)
      throw new Error("No chartScriptComponent registered in ChartClient for " + symbol.key);

    return result;
  }

  // Signum's Reflection.symbolNiceName. altea has no such helper; derive the label from the symbol key's
  // member segment ("D3ChartScript.Columns" → "Columns" → "Columns"; "…MultiBars" → "Multi Bars").
  export function symbolNiceName(symbol: ChartScriptSymbol): string {
    return Localization.niceNameFromName(symbol.key.tryAfterLast(".") ?? symbol.key);
  }

  // Signum's ChartClient.getActiveDetector — the dashboard cross-filter row detector. altea: Dashboard isn't
  // ported, so without a DashboardFilter there is nothing to detect (the full detector lands with Dashboard).
  export function getActiveDetector(filter: DashboardFilter | undefined, _request: ChartRequestModel): ((row: ChartRow) => boolean) | undefined {
    if (filter == null || filter.rows.length == 0)
      return undefined;

    return undefined; // TODO(altea): match dashboard filter rows against chart columns (Dashboard port).
  }

  // ---- Column-type logic (reuses the isomorphic data/ChartUtils) -----------------------------------------

  export function isChartColumnType(token: QueryToken | null | undefined, ct: ChartColumnType): boolean {
    return DataChartUtils.isChartColumnType(token ?? null, ct);
  }

  export function getChartColumnType(token: QueryToken): ChartColumnType | null {
    return DataChartUtils.getChartColumnType(token);
  }

  export function isCompatibleWith(chartScript: ChartScript, chartBase: IChartBase): boolean {
    return zipOrDefault(
      chartScript.columns,
      chartBase.columns, (s, c) => {

        if (s == undefined)
          return c!.token == undefined;

        if (c == undefined || c.token == undefined)
          return s.isOptional;

        if (!isChartColumnType(c.token.token, s.columnType))
          return false;

        return true;
      }).every(b => b);
  }

  export function zipOrDefault<T, S, R>(arrayT: T[], arrayS: S[], selector: (t: T | undefined, s: S | undefined) => R): R[] {
    const max = Math.max(arrayT.length, arrayS.length);

    const result: R[] = [];
    for (let i = 0; i < max; i++) {
      result.push(selector(
        i < arrayT.length ? arrayT[i] : undefined,
        i < arrayS.length ? arrayS[i] : undefined));
    }

    return result;
  }

  // Signum's ChartClient.hasAggregates. altea: columns are plain arrays; UserChart isn't ported, so the
  // filter-side check reads the client filterOptions (via Finder.isAggregate).
  export function hasAggregates(chartBase: IChartBase): boolean {
    if (chartBase.columns.some(c => c.token?.token instanceof AggregateToken))
      return true;

    return (chartBase as ChartRequestModel).filterOptions?.some(fo => Finder.isAggregate(fo)) ?? false;
  }

  // ---- Column/parameter synchronization ------------------------------------------------------------------

  export function synchronizeColumns(chart: IChartBase, chartScript: ChartScript): void {

    if (chart.columns == null || chart.parameters == null)
      throw Error("no Columns");

    for (let i = 0; i < chartScript.columns.length; i++) {
      if (chart.columns.length <= i) {
        chart.columns.push(new ChartColumnEmbedded());
      }
    }

    if (chart.columns.length > chartScript.columns.length) {
      chart.columns.splice(chartScript.columns.length, chart.columns.length - chartScript.columns.length);
    }

    var allChartScriptParameters = chartScript.parameterGroups.flatMap(a => a.parameters);

    const byName = chart.parameters.toObject(a => a.name);
    chart.parameters.length = 0;

    allChartScriptParameters.forEach(sp => {
      let cp = byName[sp.name];

      const column = sp.columnIndex == null ? undefined : chart.columns[sp.columnIndex];

      if (cp == undefined) {
        cp = new ChartParameterEmbedded();
        cp.name = sp.name;
        cp.value = defaultParameterValue(sp, column?.token?.token);
      }
      else {
        if (!isValidParameterValue(cp.value, sp, column?.token?.token)) {
          cp.value = defaultParameterValue(sp, column?.token?.token);
        }
      }

      chart.parameters.push(cp);
    });
  }

  function isValidParameterValue(value: string | null | undefined, scriptParameter: ChartScriptParameter, relatedColumn: QueryToken | null | undefined): boolean {

    switch (scriptParameter.type) {
      case "Enum": return (scriptParameter.valueDefinition as EnumValueList).values.some(a => a == value);
      case "Number": return !isNaN(parseFloat(value!));
      case "String": return true;
      case "Special": {
        const specialParameterType = (scriptParameter.valueDefinition as SpecialParameter).specialParameterType;
        switch (specialParameterType) {
          case "ColorCategory": return value != null && colorSchemes[value] != null;
          case "ColorInterpolate": return value != null && getColorInterpolation(value) != null;
          default: throw new Error("Unexpected parameter type " + specialParameterType);
        }
      }
      case "Scala": {
        const standardScalas = (scriptParameter.valueDefinition as Scala).standardScalas;
        if (relatedColumn && value && standardScalas[value]) {
          var cct = standardScalas[value];
          if (cct && !isChartColumnType(relatedColumn, cct))
            return false;

          return true;
        }

        if (value?.includes("..."))
          return !isNaN(parseFloat(value.before("..."))) && !isNaN(parseFloat(value.after("...")));

        return false;
      }

      default:
        throw new Error("Unexpected parameter type");
    }
  }

  export function defaultParameterValue(scriptParameter: ChartScriptParameter, relatedColumn: QueryToken | null | undefined): string {
    switch (scriptParameter.type) {
      case "Enum": return (scriptParameter.valueDefinition as EnumValueList).values.first();
      case "Number": return (scriptParameter.valueDefinition as NumberInterval).defaultValue?.toString() ?? "";
      case "String": return (scriptParameter.valueDefinition as StringValue).defaultValue?.toString();
      case "Special": {
        const specialParameterType = (scriptParameter.valueDefinition as SpecialParameter).specialParameterType;
        switch (specialParameterType) {
          case "ColorCategory": return Dic.getKeys(colorSchemes)[0];
          case "ColorInterpolate": return Dic.getKeys(colorInterpolators)[0];
          default: throw new Error("Unexpected parameter type " + specialParameterType);
        }
      }
      case "Scala": {
        const scala = scriptParameter.valueDefinition as Scala;
        return Object.entries(scala.standardScalas).filter(([key, value]) => value == undefined || relatedColumn == undefined || isChartColumnType(relatedColumn, value)).first()[0];
      }
      default: throw new Error("Unexpected parameter type");
    }
  }

  export namespace API {

    // Signum's ChartClient.API.getRequest — a ChartRequestModel → the generic QueryRequest (chart execution
    // reuses the standard query API). altea: MList `.map(mle => mle.element)` → plain arrays; ColumnRequest
    // requires a displayName (falls back to the token's nice name).
    export function getRequest(request: ChartRequestModel): QueryRequest {
      var ts = request.chartTimeSeries;
      var systemTime: SystemTime | undefined = ts == null ? undefined :
        ({
          joinMode: 'AllCompatible',
          mode: 'TimeSeries',
          timeSeriesStep: ts.timeSeriesStep!,
          timeSeriesUnit: ts.timeSeriesUnit!,
          startDate: ts.startDate!,
          endDate: ts.endDate!,
          timeSeriesMaxRowsPerStep: ts.timeSeriesMaxRowsPerStep!,
          splitQueries: ts.splitQueries,
        } as SystemTime);

      return {
        queryKey: request.queryKey,
        groupResults: hasAggregates(request),
        systemTime: systemTime,
        filters: Finder.toFilterRequests(request.filterOptions ?? []),
        columns: request.columns.filter(cce => cce.token != null).map(cce => ({ token: cce.token!.token!.fullKey(), displayName: cce.displayName ?? cce.token!.token!.niceName() }) as ColumnRequest),
        orders: request.columns.filter(cce => cce.orderByType != null && cce.token != null).orderBy(cce => cce.orderByIndex).map(cce => ({ token: cce.token!.token!.fullKey(), orderType: cce.orderByType! }) as OrderRequest),
        pagination: request.maxRows == null ? { mode: "All" } : { mode: "Firsts", elementsPerPage: request.maxRows }
      };
    }

    export function getKey(token: QueryToken): ((val: unknown) => string) {
      if (token.type.lite)
        return v => String(v && (v as Lite<Entity>).key());

      return v => String(v);
    }

    // altea divergence: the ColorPalette subsystem is not ported yet, so getColor is palette-free — grey for
    // null, otherwise null (the renderer's colorCategory supplies the series colors).
    export function getColor(_token: QueryToken): ((val: unknown) => string | null) {
      return v => v == null ? "#555" : null;
    }

    export const nullString = (): string => ChartMessage.Blank.niceToString();

    // altea divergence vs Signum: enum values are their member-name strings already (localized enum labels
    // deferred), and DateTime/Time formatting is simplified (Temporal formatting lands with the date-heavy
    // renderers) — neither is on the Columns MVP path.
    export function getNiceName(token: QueryToken, chartColumn: ChartColumnEmbedded): ((val: unknown, width?: number) => string) {

      if (token.type.lite)
        return v => {
          var lite = v as Lite<Entity> | null;
          return lite == null ? nullString() : lite.toString();
        };

      if (token.filterType == "Enum")
        return v => (v as string | null) ?? nullString();

      if (token.filterType == "Decimal" || token.filterType == "Integer")
        return v => {
          var number = v as number | null;
          return number == null ? nullString() : toNumberFormat(chartColumn.format ?? undefined).format(number);
        };

      return v => v == null ? nullString() : String(v);
    }

    export interface ExecuteChartResult {
      resultTable: ResultTable;
      chartTable: ChartTable;
    }

    export function toChartResult(request: ChartRequestModel, rt: ResultTable, chartScript: ChartScript): ExecuteChartResult {

      var cols = request.columns.map((cce, i) => {
        const token = cce.token && cce.token.token;

        if (token == null)
          return null;

        const scriptCol = chartScript.columns[i];

        const value = function (r: ChartRow) { return (r as any)["c" + i]; };
        const key = getKey(token);
        const niceName = getNiceName(token, cce);
        const color = getColor(token);

        return ({
          name: "c" + i,
          displayName: scriptCol.displayName,
          title: (cce.displayName || token.niceName()) + (token.unit ? ` (${token.unit})` : ""),
          token: token,
          // numeric [Flags] ChartColumnType → its member-name string (the client result-column type)
          type: (() => { const t = getChartColumnType(token); return t == null ? null : ChartColumnType[t] as ChartColumnTypeString; })(),
          orderByIndex: cce.orderByIndex,
          orderByType: cce.orderByType,
          getKey: key,
          getNiceName: niceName,
          getColor: color,
          getValue: value,
          getValueKey: (row: ChartRow) => key(value(row)),
          getValueNiceName: (row: ChartRow) => niceName(value(row)),
          getValueColor: (row: ChartRow) => color(value(row)),
        } as ChartColumn<unknown>);
      });

      if (!hasAggregates(request)) {
        const value = (r: ChartRow) => r.entity;
        const color = (v: Lite<Entity> | undefined) => !v ? "#555" : null;
        const niceName = (v: Lite<Entity> | undefined) => v == null ? "" : v.toString();
        const key = (v: Lite<Entity> | undefined) => v ? v.key() : String(v);
        cols.unshift(({
          name: "entity",
          displayName: "Entity",
          title: "",
          token: undefined,
          type: "Entity",
          getKey: key,
          getNiceName: niceName,
          getColor: color,
          getValue: value,
          getValueKey: (row: ChartRow) => key(value(row)),
          getValueNiceName: (row: ChartRow) => niceName(value(row)),
          getValueColor: (row: ChartRow) => color(value(row)),
        } as ChartColumn<Lite<Entity> | undefined>) as ChartColumn<unknown>);
      }

      const columnIndexes = request.columns.map((cce, i) => {
        const fullKey = cce.token?.token?.fullKey();

        if (fullKey == null)
          return null;

        var resultIndex = rt.columns.indexOf(fullKey);

        if (resultIndex != -1)
          return { colName: "c" + i, resultIndex };

        if (fullKey == "Entity")
          return { colName: "c" + i, resultIndex: "Entity" as const };

        throw new Error(fullKey + " not found in results");
      }).notNull();

      var rows = rt.rows.map<ChartRow>(row => {
        var cr = columnIndexes.toObject(c => c.colName, c => c.resultIndex == "Entity" ? row.entity : row.columns[c.resultIndex]);
        cr.entity = row.entity;
        return cr;
      });

      var chartTable: ChartTable = {
        // Signum uses DateTime.local().toISO() (a cache marker); altea has no luxon here — a plain ISO string.
        date: new Date().toISOString(),
        columns: cols.filter(c => c != null).toObjectDistinct(c => c!.name) as any,
        rows: rows
      };

      return {
        resultTable: rt,
        chartTable: chartTable,
      };
    }

    export function executeChart(request: ChartRequestModel, chartScript: ChartScript, abortSignal?: AbortSignal): Promise<ExecuteChartResult> {
      const queryRequest = getRequest(request);
      return Finder.API.executeQuery(queryRequest, abortSignal).then(rt => toChartResult(request, rt, chartScript));
    }

    // Signum's ChartClient.API.getParameterWithDefault — the effective parameter map (each parameter's set
    // value, else its default). altea: MList `.element` → plain arrays; keyed by parameter name.
    export function getParameterWithDefault(request: ChartRequestModel, chartScript: ChartScript): Record<string, string> {

      var defaultValues = chartScript.parameterGroups.flatMap(g => g.parameters).toObject(a => a.name, a => {
        var col = a.columnIndex == null ? null : request.columns[a.columnIndex];
        return defaultParameterValue(a, col?.token?.token);
      });

      return request.parameters.toObject(a => a.name, a => a.value ?? defaultValues[a.name]);
    }

    export function fetchScripts(): Promise<ChartScript[]> {
      return ajaxGet<(Omit<ChartScript, "symbol"> & { symbol: string })[]>({
        url: "/api/chart/scripts"
      }).then(scripts => scripts.map(s => ({ ...s, symbol: symbolsByKey()[s.symbol] })));
    }
  }
}

// ---- Render data contracts (consumed by every D3 renderer) -----------------------------------------------

export interface ChartScriptProps {
  data?: ChartTable;
  parameters: Record<string, string>,
  loading: boolean;
  onDrillDown: (row: ChartRow, e: React.MouseEvent<any> | MouseEvent) => void;
  onReload: (() => void) | undefined;
  width: number;
  height: number;
  initialLoad: boolean;
  memo: MemoRepository;
  chartRequest: ChartRequestModel;
  dashboardFilter?: DashboardFilter;
}


export interface ChartTable {
  date: string;
  columns: {
    entity?: ChartColumn<Lite<Entity>>;
    c0?: ChartColumn<unknown>;
    c1?: ChartColumn<unknown>;
    c2?: ChartColumn<unknown>;
    c3?: ChartColumn<unknown>;
    c4?: ChartColumn<unknown>;
    c5?: ChartColumn<unknown>;
    c6?: ChartColumn<unknown>;
    c7?: ChartColumn<unknown>;
    c8?: ChartColumn<unknown>;
    c9?: ChartColumn<unknown>;
    c10?: ChartColumn<unknown>;
    c11?: ChartColumn<unknown>;
  },
  rows: ChartRow[]
}

export interface ChartRow {
  entity?: Lite<Entity>;
  c0?: unknown;
  c1?: unknown;
  c2?: unknown;
  c3?: unknown;
  c4?: unknown;
  c5?: unknown;
  c6?: unknown;
  c7?: unknown;
  c8?: unknown;
  c9?: unknown;
  c10?: unknown;
  c11?: unknown;
}


// The (single) result-column type NAME — Signum's client string-union ChartColumnType. Distinct from the
// data-layer numeric [Flags] ChartColumnType used for slot matching; renderers switch on these strings.
export type ChartColumnTypeString =
  "Number" | "DecimalNumber" | "RoundedNumber" | "Date" | "DateTime" | "Time" | "String" | "Entity" | "Enum";

export interface ChartColumn<V> {
  name: string;
  title: string;
  displayName: string;
  token?: QueryToken; //Null for QueryToken
  type: ChartColumnTypeString | null;
  orderByIndex?: number | null;
  orderByType?: OrderType | null;

  getKey: (v: V | null) => string;
  getNiceName: (v: V | null, width?: number) => string;
  getColor: (v: V | null) => string | null;

  getValue: (row: ChartRow) => V;
  getValueKey: (row: ChartRow) => string;
  getValueNiceName: (row: ChartRow, width?: number) => string;
  getValueColor: (row: ChartRow) => string | null;
}
