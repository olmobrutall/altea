import * as React from 'react'
import { ajaxGet } from '@altea/altea/client/Services';
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder';
import { ImportComponent } from '@altea/altea/client/ImportComponent';
import { Dic } from '@altea/altea/data/globals/index';
import * as AppContext from '@altea/altea/client/AppContext';

// altea-chart's slice of the per-user client state — see the note on Navigator's entitySettings.
declare module '@altea/altea/client/AppContext' {
  interface IClientState {
    chartButtonBar?: ((ctx: any) => React.ReactElement | undefined)[];
  }
}
import { Lite } from '@altea/altea/data/lite';
import type { Entity } from '@altea/altea/data/entity';
import { Enum } from '@altea/altea/data/enum';
import { enumEntityMembers } from '@altea/altea/data/enumEntity';
import type { OrderType } from '@altea/altea/data/dynamicQueries';
import { TimeSeriesUnitEnum } from '@altea/altea/data/dynamicQueries';
import { type int, toInt } from '@altea/altea/data/basics';
import { SubTokensOptions } from '@altea/altea/data/dynamicQuery/tokens/queryToken';
import type { QueryToken } from '@altea/altea/data/dynamicQuery/tokens/queryToken';
import { AggregateToken } from '@altea/altea/data/dynamicQuery/tokens/aggregateToken';
import type { QueryRequest, ColumnRequest, OrderRequest, ResultTable, SystemTime } from '@altea/altea/data/dynamicQuery/queryRequest';
import type { FilterOptionParsed, FilterOption, OrderOption, FindOptions } from '@altea/altea/client/FindOptions';
import { isFilterCondition } from '@altea/altea/client/FindOptions';
import { Finder } from '@altea/altea/client/Finder';
import { QueryString } from '@altea/altea/client/QueryString';
import { toNumberFormat } from '@altea/altea/client/numberFormat';
import * as DataChartUtils from '../data/ChartUtils';
import { ChartColumnType } from '../data/ChartScriptColumn';
import type { ChartParameterType, SpecialParameterType } from '../data/ChartScriptParameter';
import { ChartColumnEmbedded } from '../data/ChartColumn';
import { ChartParameterEmbedded } from '../data/ChartParameter';
import type { IChartBase } from '../data/ChartRequest';
import { ChartRequestModel, ChartTimeSeriesEmbedded } from '../data/ChartRequest';
import { QueryTokenEmbedded } from '@altea/altea-user-assets/data/Queries';
import type { UserChartEntity } from '../data/UserChart';
import { ChartScriptSymbol, D3ChartScript, HtmlChartScript, SvgMapsChartScript, GoogleMapsChartScript } from '../data/ChartScript';
import { ChartMessage } from '../data/ChartMessage';
import { colorSchemes, colorInterpolators, getColorInterpolation } from './ColorPalette/ColorUtils';
import { ColorPaletteClient } from './ColorPalette/ColorPaletteClient';
import { cleanTypeName } from '@altea/altea/data/registration';
import type { MemoRepository } from './D3Scripts/Components/ReactChart';
import type { DashboardFilter } from './DashboardFilterStub';
import ChartButton from './ChartButton';
import type { ChartRequestViewHandle } from './Templates/ChartRequestView';
// altea Array/String prototype extensions (.toObject/.first/.contains/.before/.after) — see ColorUtils.
import '@altea/altea/data/globals/arrayExtensions';
import '@altea/altea/data/globals/stringExtensions';

// Signum's SearchControlLoaded augmentation: the toolbar's "show chart button" opt-in flag.
declare module '@altea/altea/client/SearchControl/SearchControlLoaded' {
  interface ShowBarExtensionOption {
    showChartButton?: boolean;
  }
}

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

    // Signum's ChartClient.start ButtonBarQuery hook: a "Chart" button on the SearchControl toolbar that
    // opens the current query (+ filters) as a chart. Gated by showBarExtension + the showChartButton opt-in
    // (falls back to largeToolbarButtons). altea has no client ViewCharting permission — charting is
    // server-gated — so the permission check Signum does is dropped.
    Finder.ButtonBarQuery.onButtonBarElements().push(ctx => {
      const sc = ctx.searchControl;
      if (!sc.props.showBarExtension ||
        !(sc.props.showBarExtensionOption?.showChartButton ?? sc.props.largeToolbarButtons))
        return undefined;
      return { button: <ChartButton searchControl={sc} /> };
    });

    registerChartScriptComponent(D3ChartScript.Bars, () => import("./D3Scripts/Bars"));
    registerChartScriptComponent(D3ChartScript.Columns, () => import("./D3Scripts/Columns"));
    registerChartScriptComponent(D3ChartScript.Line, () => import("./D3Scripts/Line"));
    registerChartScriptComponent(D3ChartScript.MultiBars, () => import("./D3Scripts/MultiBars"));
    registerChartScriptComponent(D3ChartScript.MultiColumns, () => import("./D3Scripts/MultiColumns"));
    registerChartScriptComponent(D3ChartScript.MultiLines, () => import("./D3Scripts/MultiLines"));
    registerChartScriptComponent(D3ChartScript.StackedBars, () => import("./D3Scripts/StackedBars"));
    registerChartScriptComponent(D3ChartScript.StackedColumns, () => import("./D3Scripts/StackedColumns"));
    registerChartScriptComponent(D3ChartScript.StackedLines, () => import("./D3Scripts/StackedLines"));
    registerChartScriptComponent(D3ChartScript.Pie, () => import("./D3Scripts/Pie"));
    registerChartScriptComponent(D3ChartScript.Scatterplot, () => import("./D3Scripts/Scatterplot"));
    registerChartScriptComponent(D3ChartScript.Bubbleplot, () => import("./D3Scripts/Bubbleplot"));
    registerChartScriptComponent(D3ChartScript.BubblePack, () => import("./D3Scripts/BubblePack"));
    registerChartScriptComponent(D3ChartScript.Treemap, () => import("./D3Scripts/TreeMap"));
    registerChartScriptComponent(D3ChartScript.Punchcard, () => import("./D3Scripts/Punchcard"));
    registerChartScriptComponent(D3ChartScript.ParallelCoordinates, () => import("./D3Scripts/ParallelCoordinates"));
    registerChartScriptComponent(D3ChartScript.CalendarStream, () => import("./D3Scripts/CalendarStream"));
    registerChartScriptComponent(HtmlChartScript.PivotTable, () => import("./HtmlScripts/PivotTable"));
    registerChartScriptComponent(SvgMapsChartScript.SvgMap, () => import("./SvgMap/SvgMap"));
  }

  // Signum's ChartClient.ButtonBarChart — the registry the chart page's toolbar renders. UserChartClient.start
  // pushes the UserChartMenu onto it (mirrors Finder.ButtonBarQuery for the SearchControl). The handle type is
  // a type-only import so this stays free of a runtime cycle with ChartRequestView.
  export interface ButtonBarChartContext {
    chartRequestView: ChartRequestViewHandle;
  }

  export namespace ButtonBarChart {
    // In `AppContext.clientState`, not a module-level array — see the note on Navigator's entitySettings.
    // altea-chart's own UserChartClient pushes here from its `start()`, so a second registration run would
    // put the user-chart menu on the chart toolbar twice.
    export function onButtonBarElements(): ((ctx: ButtonBarChartContext) => React.ReactElement | undefined)[] {
      return AppContext.clientState.chartButtonBar ??= [];
    }

    export function getButtonBarElements(chartRequestView: ChartRequestViewHandle): React.ReactElement[] {
      return onButtonBarElements().map(f => f({ chartRequestView })).filter((a): a is React.ReactElement => a != undefined);
    }
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

  // Signum's Reflection.symbolNiceName — in altea a Symbol resolves its own label (Symbol.niceToString:
  // the container-member translation, else the humanised member name of its key).
  export function symbolNiceName(symbol: ChartScriptSymbol): string {
    return symbol.niceToString();
  }

  // Signum's client ChartColumnType is a string enum with `.niceToString()`; altea's is a numeric [Flags]
  // enum, so this goes through the Enum helper (translation for the current culture, else humanised).
  export function chartColumnTypeNiceName(ct: ChartColumnType): string {
    return Enum.niceName(ChartColumnType, ct);
  }

  // Signum's ChartClient.getActiveDetector — the dashboard cross-filter row detector: which rows of THIS
  // chart are part of the current dashboard selection (they render at full opacity, the rest dimmed).
  // altea divergences: `token.fullKey()` is a METHOD, and lite comparison uses Lite's instance `is`.
  export function getActiveDetector(filter: DashboardFilter | undefined, request: ChartRequestModel): ((row: ChartRow) => boolean) | undefined {
    if (filter == null || filter.rows.length == 0)
      return undefined;

    const tokenToColumn = request.columns
      .map((cce, i) => ({ colName: "c" + i, tokenString: cce.token?.tokenString }))
      .filter(a => a.tokenString != null)
      .groupBy(a => a.tokenString!)
      .toObject(gr => gr.key, gr => gr.elements.first().colName);

    return row => filter.rows.some(r =>
      r.filters.every(f => {
        const colName = tokenToColumn[f.token.fullKey()];
        if (colName == null)
          return false;
        const rowVal = (row as unknown as Record<string, unknown>)[colName];
        return f.value == rowVal || (f.value instanceof Lite && f.value.is(rowVal as Lite<Entity>));
      }));
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

  // Signum's ChartClient.handleOrderColumn — cycle a column's sort (Asc↔Desc); shift-click keeps the other
  // columns' orders (multi-sort), a plain click clears them. altea: plain arrays; no `.modified` (dirty is
  // snapshot-tracked); `int` order index via toInt.
  export function handleOrderColumn(cr: IChartBase, col: ChartColumnEmbedded, isShift: boolean): void {
    const newOrder: OrderType = col.orderByType == "Ascending" ? "Descending" : "Ascending";

    if (!isShift) {
      cr.columns.forEach(a => {
        a.orderByType = null;
        a.orderByIndex = null;
      });
      col.orderByType = newOrder;
      col.orderByIndex = toInt(1);
    } else {
      col.orderByType = newOrder;
      if (col.orderByIndex == null) {
        const maxIndex: int = Math.max(0, ...cr.columns.map(a => Number(a.orderByIndex ?? 0))) as int;
        col.orderByIndex = toInt(Number(maxIndex) + 1);
      }
    }
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

    // Bind each column to its slot (Signum's SynchronizeColumns does this; the isomorphic
    // ChartUtils.synchronizeColumns too). Without it ChartColumnEmbedded's DECLARED validation is dead
    // code — both branches short-circuit on `scriptColumn != null` — so a token incompatible with the slot
    // (a collection picked as the group key) silently drew nothing. The client's ChartScript is the /api
    // DTO, which carries `displayName` as a string where the data-layer class exposes `getDisplayName()`;
    // adapt it so the shape the validator reads is complete.
    chart.columns.forEach((c, i) => {
      const sc = chartScript.columns[i];
      c.parentChart = chart;
      c.scriptColumn = { ...sc, getDisplayName: () => sc.displayName };
    });

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

  // Signum's ChartClient.extractFindOptions — turn a clicked chart row into a FindOptions that explores the
  // underlying query filtered by the row's key columns (the drilldown target). altea divergences: plain
  // column arrays (`a.token`, no `.element`); `token instanceof AggregateToken` for the aggregate check;
  // `.fullKey()` is a method; the time-series AsOf branch is dropped (altea has no time-series token kind).
  export function extractFindOptions(cr: ChartRequestModel, r: ChartRow): FindOptions {

    // The chart's own condition filters (drop aggregate HAVING filters — invalid in a non-grouped search).
    const filters: FilterOptionParsed[] = (cr.filterOptions ?? [])
      .filter(f => isFilterCondition(f) && !(f.token instanceof AggregateToken)) as FilterOptionParsed[];

    cr.columns.forEach((a, i) => {
      const token = a.token?.token;
      if (token == null)
        return;

      // A non-aggregate key column that the clicked row carries a value for → an EqualTo filter.
      if (!(token instanceof AggregateToken) && Object.prototype.hasOwnProperty.call(r, "c" + i))
        filters.push({ token, operation: "EqualTo", value: (r as any)["c" + i], frozen: false } as unknown as FilterOptionParsed);
    });

    return {
      queryName: cr.queryKey,
      filterOptions: Finder.toFilterOptions(filters),
      includeDefaultFilters: false,
    };
  }

  // ---- URL round-trip (Signum's ChartClient Encoder / Decoder) ------------------------------------------
  //
  // Serialize a ChartRequestModel to/from a `/chart/<queryKey>?…` URL query string, so charts are
  // bookmarkable/shareable and drilldown navigation can carry a full chart. altea divergences vs Signum:
  //  - MList row wrappers are gone — `cr.columns` / `cr.parameters` are plain arrays of ChartColumnEmbedded /
  //    ChartParameterEmbedded (no `.element`); decode* return plain arrays too.
  //  - Signum's `Finder.getQueryDescription(qn).then(qd => new TokenCompleter(qd))` → altea resolves the
  //    query ROOT token (`Finder.getQueryRoot`) and constructs the TokenCompleter from it (no QueryDescription
  //    DTO). The completer's public API (requestFilter/request/finished/get/toFilterOptionParsed) is identical.
  //  - `ChartRequestModel.New({…})` / `X.New({…})` → `new X()` + field assignment; `getQueryKey(qn)` → the
  //    query key IS the string name; `liteKey(uc)` → `uc.key()`.

  export interface ChartOptions {
    queryName: string;
    chartScript?: string;
    maxRows?: number | null;
    timeSeries?: ChartTimeSeriesEmbedded | null | undefined;
    filterOptions?: (FilterOption | null | undefined)[];
    orderOptions?: (OrderOption | null | undefined)[];
    columnOptions?: (ChartColumnOption | null | undefined)[];
    parameters?: (ChartParameterOption | null | undefined)[];
  }

  export interface ChartColumnOption {
    token?: string;
    displayName?: string | null;
    format?: string | null;
    orderByIndex?: number | null;
    orderByType?: OrderType | null;
  }

  export interface ChartParameterOption {
    name: string;
    value: string | null;
  }

  export function cloneChartTimeSeries(ts: ChartTimeSeriesEmbedded | null | undefined): ChartTimeSeriesEmbedded | null {
    if (!ts)
      return null;
    const clone = new ChartTimeSeriesEmbedded();
    clone.timeSeriesStep = ts.timeSeriesStep;
    clone.timeSeriesUnit = ts.timeSeriesUnit;
    clone.startDate = ts.startDate;
    clone.endDate = ts.endDate;
    clone.timeSeriesMaxRowsPerStep = ts.timeSeriesMaxRowsPerStep;
    clone.splitQueries = ts.splitQueries;
    return clone;
  }

  export namespace Encoder {

    export function toChartOptions(cr: ChartRequestModel, cs: ChartScript | null): ChartOptions {

      var params = cs?.parameterGroups.flatMap(a => a.parameters).toObject(a => a.name);

      return {
        queryName: cr.queryKey,
        chartScript: cr.chartScript?.key.tryAfter(".") ?? undefined,
        maxRows: cr.maxRows,
        timeSeries: cloneChartTimeSeries(cr.chartTimeSeries),
        filterOptions: Finder.toFilterOptions(cr.filterOptions ?? []),
        columnOptions: cr.columns.map(co => ({
          token: co.token && co.token.tokenString,
          displayName: co.displayName,
          format: co.format,
          orderByIndex: co.orderByIndex == null ? null : Number(co.orderByIndex),
          orderByType: co.orderByType,
        }) as ChartColumnOption),
        parameters: cr.parameters
          .filter(p => {
            if (params == null)
              return true;

            var scriptParam = params![p.name!];
            if (scriptParam == null)
              return true;

            var c = scriptParam.columnIndex != null ? cr.columns[scriptParam.columnIndex] : null;

            return p.value != defaultParameterValue(scriptParam, c?.token?.token);
          })
          .map(p => ({ name: p.name, value: p.value }) as ChartParameterOption),
      };
    }

    export function chartPathPromise(cr: ChartRequestModel, userChart?: Lite<UserChartEntity>): Promise<string> {
      var csPromise: Promise<null | ChartScript> = cr.chartScript == null ? Promise.resolve(null) : getChartScript(cr.chartScript);

      return csPromise.then(cs => chartPath(toChartOptions(cr, cs), userChart));
    }

    export function chartPath(co: ChartOptions, userChart?: Lite<UserChartEntity>): string {
      const query: any = {
        script: co.chartScript,
        maxRows:
          co.maxRows === null ? "null" :
            co.maxRows === undefined || co.maxRows == Decoder.DefaultMaxRows ? undefined : co.maxRows,
        userChart: userChart && userChart.key(),
      };

      encodeTimeSeries(query, co.timeSeries);
      Finder.Encoder.encodeFilters(query, co.filterOptions?.notNull());
      Finder.Encoder.encodeOrders(query, co.orderOptions?.notNull());
      encodeParameters(query, co.parameters?.notNull());
      encodeColumn(query, co.columnOptions?.notNull());

      return `/chart/${co.queryName}?` + QueryString.stringify(query);
    }

    const scapeTilde = Finder.Encoder.scapeTilde;

    export function encodeColumn(query: any, columns: ChartColumnOption[] | undefined): void {
      if (columns)
        columns.forEach((co, i) => query["column" + i] =
          (co.orderByIndex != null ? (co.orderByIndex! + (co.orderByType == "Ascending" ? "A" : "D") + "~") : "") +
          (co.token ?? "") +
          (co.displayName || co.format ? ("~" + (co.displayName == null ? "" : scapeTilde(co.displayName))) : "") +
          (co.format ? "~" + scapeTilde(co.format) : ""));
    }

    export function encodeParameters(query: any, parameters: ChartParameterOption[] | undefined): void {
      if (parameters)
        parameters.map((p, i) => query["param" + i] = scapeTilde(p.name!) + "~" + scapeTilde(p.value ?? ""));
    }

    export function encodeTimeSeries(query: any, ts: ChartTimeSeriesEmbedded | null | undefined): void {
      if (ts) {
        query['systemTimeStartDate'] = ts.startDate;
        query['systemTimeEndDate'] = ts.endDate;
        query['timeSeriesStep'] = ts.timeSeriesStep;
        query['timeSeriesUnit'] = ts.timeSeriesUnit;
        query['timeSeriesMaxRowsPerStep'] = ts.timeSeriesMaxRowsPerStep;
        if (ts.splitQueries)
          query['splitQueries'] = ts.splitQueries;
      }
    }
  }

  export namespace Decoder {

    export const DefaultMaxRows = 1000;

    export function parseChartRequest(queryName: string, query: any): Promise<ChartRequestModel> {

      return getChartScripts().then(scripts => {
        return Finder.getQueryRoot(queryName).then(root => {

          const completer = new Finder.TokenCompleter(root);

          const ts = decodeTimeSeries(query);
          const tsOpt = ts ? SubTokensOptions.CanTimeSeries : 0;

          const fos = Finder.Decoder.decodeFilters(query);
          fos.forEach(fo => completer.requestFilter(fo));

          const cols = decodeColumns(query);
          cols.map(a => a.token).filter(te => te != undefined).forEach(te => completer.request(te!.tokenString!));

          return completer.finished().then(() => {

            cols.filter(a => a.token != null).forEach(a => a.token!.token = completer.get(a.token!.tokenString!, SubTokensOptions.CanAggregate | SubTokensOptions.CanElement | tsOpt));

            var cs = query.script == undefined ? scripts.first() :
              scripts.filter(cs => cs.symbol.key.tryAfter(".") == query.script).single();

            const chartRequest = new ChartRequestModel();
            chartRequest.chartScript = cs.symbol;
            chartRequest.maxRows = query.maxRows == "null" ? null : toInt(query.maxRows ? Number(query.maxRows) : DefaultMaxRows);
            chartRequest.queryKey = queryName;
            chartRequest.filterOptions = fos.map(fo => completer.toFilterOptionParsed(fo, SubTokensOptions.CanElement | SubTokensOptions.CanAnyAll | SubTokensOptions.CanAggregate | tsOpt));
            chartRequest.columns = cols;
            chartRequest.parameters = decodeParameters(query);
            chartRequest.chartTimeSeries = ts;

            synchronizeColumns(chartRequest, cs);

            return Finder.parseFilterValues(chartRequest.filterOptions)
              .then(() => chartRequest);
          });
        });
      });
    }

    const unscapeTildes = Finder.Decoder.unscapeTildes;
    const valuesInOrder = Finder.Decoder.valuesInOrder;

    export function decodeColumns(query: any): ChartColumnEmbedded[] {
      return valuesInOrder(query, "column").map(p => {

        var parts = p.value.split("~");

        let order: string | undefined;
        let token: string;
        let displayName: string | undefined;
        let format: string | undefined;

        if (parts.length >= 2 && /\d+[AD]/.test(parts[0]))
          [order, token, displayName, format] = parts;
        else
          [token, displayName, format] = parts;

        const col = new ChartColumnEmbedded();
        if (token) {
          const qte = new QueryTokenEmbedded();
          qte.tokenString = token;
          col.token = qte;
        }
        col.orderByType = order == null ? null : (order.charAt(order.length - 1) == "A" ? "Ascending" : "Descending");
        col.orderByIndex = order == null ? null : toInt(parseInt(order.slice(0, -1)));
        col.format = unscapeTildes(format) ?? null;
        col.displayName = unscapeTildes(displayName) ?? null;
        return col;
      });
    }

    export function decodeParameters(query: any): ChartParameterEmbedded[] {
      return valuesInOrder(query, "param").map(p => {
        const cp = new ChartParameterEmbedded();
        cp.name = unscapeTildes(p.value.before("~")) ?? "";
        cp.value = unscapeTildes(p.value.after("~")) ?? null;
        return cp;
      });
    }

    export function decodeTimeSeries(query: any): ChartTimeSeriesEmbedded | null {
      if (!query.timeSeriesUnit)
        return null;
      const ts = new ChartTimeSeriesEmbedded();
      ts.startDate = query.systemTimeStartDate;
      ts.endDate = query.systemTimeEndDate;
      ts.timeSeriesUnit = query.timeSeriesUnit;
      ts.timeSeriesStep = query.timeSeriesStep ? toInt(parseInt(query.timeSeriesStep)) : null;
      ts.timeSeriesMaxRowsPerStep = query.timeSeriesMaxRowsPerStep ? toInt(parseInt(query.timeSeriesMaxRowsPerStep)) : null;
      ts.splitQueries = query.splitQueries != null && query.splitQueries != false;
      return ts;
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
          timeSeriesUnit: Enum.toName(TimeSeriesUnitEnum, ts.timeSeriesUnit!),
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

    // Signum's ChartClient.API.getColor(token, palettes): pick a per-value color from the palette registered
    // for the column's type. An ENUM column keys the palette by the enum member NAME (the value IS the member
    // string); an ENTITY column keys by the lite's clean type name → the lite id string. A null value is grey
    // ("#555"); an unmapped value (no palette, or palette returns null) falls through to null so the renderer's
    // own colorCategory scale supplies the color (uncolored charts stay unchanged).
    //
    // altea divergences vs Signum: enum detection uses `token.filterType == "Enum"` + `token.type.getTypeName()`
    // (altea's TypeInfo.kind is always "Entity", so Signum's `tis[0].kind == "Enum"` can't be used); the entity
    // key is `cleanTypeName(lite.entityType)` (Signum's `lite.EntityType` clean-name string).
    export function getColor(token: QueryToken, palettes: { [type: string]: ColorPaletteClient.ColorPalette | null }): ((val: unknown) => string | null) {

      if (token.filterType == "Enum") {
        const typeName = token.type.getTypeName();
        const en = token.type.getEnum();
        // altea serializes an enum result column as its ORDINAL id (not the member name string Signum used);
        // the palette (ColorPaletteServer's enum branch) is keyed by the enum MEMBER NAME, so translate the
        // ordinal → member name before the lookup (same enumEntityMembers mapping the server keyed with).
        const nameByOrdinal = en ? new Map(enumEntityMembers(en).map(m => [Number(m.id), m.name])) : null;
        return v => {
          if (v == null)
            return "#555";

          const cp = typeName ? palettes[typeName] : null;
          if (cp == null)
            return null;
          const memberName = nameByOrdinal?.get(Number(v)) ?? String(v);
          return cp.getColor(memberName) || null;
        };
      }

      if (token.type.typeInfos().some(a => a && a.kind == "Entity")) {
        return v => {
          if (v == null)
            return "#555";

          const lite = v as Lite<Entity>;
          const cp = palettes[cleanTypeName(lite.entityType)];
          return (cp && cp.getColor(String(lite.id))) || null;
        };
      }

      return v => v == null ? "#555" : null;
    }

    // Signum's ChartClient.API.getPalletes(request): preload the palette for every column type up front (the
    // palettes are consumed SYNCHRONOUSLY inside toChartResult's getColor, so they must be resolved first).
    // altea: columns are plain arrays (no `.element`); collect each column token's palette type name — the
    // entity TypeInfos' clean names AND (Signum's single tis[0].kind switch is split in altea) each ENUM
    // column's own type name, since altea's TypeReference.typeInfos() returns [] for enums. Both key the same
    // way getColor looks them up: entity → cleanTypeName(lite.entityType); enum → token.type.getTypeName().
    export function getPalletes(request: ChartRequestModel): Promise<{ [type: string]: ColorPaletteClient.ColorPalette | null }> {
      const tokens = request.columns.map(c => c.token?.token).notNull();

      const entityTypeNames = tokens
        .flatMap(t => t!.type.typeInfos())
        .notNull()
        .map(ti => cleanTypeName(ti.ctor!));

      const enumTypeNames = tokens
        .filter(t => t!.filterType == "Enum")
        .map(t => t!.type.getTypeName())
        .notNull();

      const allNames = [...entityTypeNames, ...enumTypeNames].distinctBy(n => n);

      // Per-type tolerance: a single palette lookup that rejects must NOT reject the whole chart (Promise.all
      // is all-or-nothing) — a chart with no/failed palettes still renders via the renderer's category scale.
      return Promise.all(allNames.map(name => ColorPaletteClient.getColorPalette(name)
        .catch(() => null)
        .then(cp => ({ type: name, palette: cp }))))
        .then(list => list.toObject(a => a.type, a => a.palette));
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

      if (token.filterType == "Enum") {
        const en = token.type.getEnum();
        return v => {
          if (v == null)
            return nullString();
          if (en == null)
            return String(v);
          // altea's enum result value is the ORDINAL id — Enum.niceName maps ordinal → localized member name
          // (mirrors the SearchControl's Enum cell formatter); a value out of range falls back to its string.
          try { return Enum.niceName(en as Record<string, string | number>, v as never); }
          catch { return String(v); }
        };
      }

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

    export function toChartResult(request: ChartRequestModel, rt: ResultTable, chartScript: ChartScript, palettes: { [type: string]: ColorPaletteClient.ColorPalette | null }): ExecuteChartResult {

      var cols = request.columns.map((cce, i) => {
        const token = cce.token && cce.token.token;

        if (token == null)
          return null;

        const scriptCol = chartScript.columns[i];

        const value = function (r: ChartRow) { return (r as any)["c" + i]; };
        const key = getKey(token);
        const niceName = getNiceName(token, cce);
        const color = getColor(token, palettes);

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
      // Preload palettes alongside the query — getColor (inside toChartResult) reads them synchronously, so
      // both must be resolved before toChartResult runs (Signum's executeChart threads them the same way).
      const palettesPromise = getPalletes(request);
      const queryRequest = getRequest(request);
      return Finder.API.executeQuery(queryRequest, abortSignal)
        .then(rt => palettesPromise.then(palettes => toChartResult(request, rt, chartScript, palettes)));
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
      return ajaxGet<(Omit<ChartScript, "symbol"> & { symbol: string, symbolId: number })[]>({
        url: "/api/chart/scripts"
      }).then(scripts => scripts.map(s => {
        const symbol = symbolsByKey()[s.symbol];
        // Stamp the DB id onto the declared instance (what SymbolLogic does server-side): a UserChart
        // REFERENCES this symbol, and without an id the save path treats it as a new row and tries to
        // INSERT it again — "duplicate key value violates unique constraint uix_chart_script_symbol_key".
        if (symbol != null && symbol.id == null)
          (symbol as { id?: number }).id = s.symbolId;
        return ({ ...s, symbol });
      }));
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
