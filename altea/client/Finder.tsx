// PORT (Signum.React/Finder.tsx, copy-and-fix): ported deps are retargeted to altea paths; deps not
// yet ported are commented `// TODO(port): …` and the code using them is commented likewise, so the
// API + parse foundation compiles now and the UI is un-commented as SearchControl/Lines/Operations land.
import * as React from "react";
import { type RouteObject, Link } from 'react-router'
// TODO(port): luxon dropped in altea (uses Date / Temporal) — restore date/duration parse+format.
// import { DateTime, Duration } from 'luxon'
import * as AppContext from "./AppContext"
import { Navigator } from "./Navigator" // TODO(port): ViewPromise not exported by altea Navigator yet.
import { Dic, classes, isNumber, isPromise, softCast } from '../entities/globals'
import { ajaxGet, ajaxPost } from './Services';

import type {
  FindOptions,
  FindOptionsParsed, FilterOption, FilterOptionParsed, OrderOptionParsed,
  ColumnOption, ColumnOptionParsed,
  OrderOption, ModalFindOptions,
  FilterGroupOptionParsed, FilterConditionOptionParsed, FilterGroupOption,
  FilterConditionOption, PinnedFilter,
  ModalFindOptionsMany, FetchOptions, TypedResultsOptions, ResultObject,
} from './FindOptions';
import type {
  QueryValueRequest, QueryRequest, QueryEntitiesRequest, Pagination,
  ResultTable, ResultRow, FilterRequest, OrderRequest,
  FilterGroupRequest, FilterConditionRequest, SystemTime,
} from '../entities/dynamicQuery/queryRequest';
import {
  isList, isPair, type ColumnOptionsMode, toPinnedFilterParsed, isActive, canSplitValue,
  getFilterOperations, isFilterGroup, isFilterCondition, isGroupList, toColumnOption,
} from './FindOptions';
// TODO(port): QueryDescriptionDTO / QueryTokenWithoutParent dropped in altea (client builds the token tree locally).
import { completeToken, QueryToken, SubTokensOptions, type Writable } from './QueryToken';
import { getSubTokens as generateSubTokens, SubTokensOptionsAll } from '../entities/dynamicQuery/tokens/queryToken';
import { getKey } from '../entities/dynamicQuery/queryUtils';
import { RootToken } from '../entities/dynamicQuery/tokens/rootToken';
import { QueryTokenString, type Anonymous } from './QueryTokenString';

import { FilterOperationEnum, PinnedFilterActiveEnum } from '../entities/dynamicQueries'; // numeric companions, for wire-ordinal encode/decode
import type { FilterOperation, FilterGroupOperation, PinnedFilterActive, FilterType, PaginationMode, OrderType } from '../entities/dynamicQueries';

import { Entity, BaseEntity, EmbeddedEntity, ModelEntity, type Type } from '../entities/entity';
import { Lite } from '../entities/lite';
// TODO(port): Signum.Entities free helpers → altea idioms (methods): toLite→e.toLite(), liteKey→l.key(),
// parseLite→Lite.parse, is→.is(), isLite/isEntity/isModifiableEntity→instanceof; MListElement/isMListElement
// gone (no MList); getToString; SearchMessage/JavascriptMessage message containers not ported.
import { TypeEntity } from '../entities/typeEntity';
// TODO(port): QueryEntity (Signum.Basics) not ported.

import {
  QueryKey, getQueryKey, isQueryDefined, getTypeName, getTypeInfo, tryGetTypeInfo,
  type PseudoType,
} from './Reflection';
import { isNumberType, toNumberFormat } from './numberFormat';
import { Enum } from '../entities/enum';
import { Temporal } from '../entities/basics';
import { TypeInfo, TypeReference } from '../entities/reflection';
import { PropertyRoute } from '../entities/propertyRoute';
import type { FieldInfo } from '../entities/reflection';
// TODO(port): getEnumInfo, toLuxonFormat, toNumberFormat, onReloadTypesActions, toLuxonDurationFormat,
// toFormatWithFixes, numberLimits, isDecimalType — formatter/query-registry layer not ported.

// TODO(port): SearchControl not ported yet.
// import EntityLink from './SearchControl/EntityLink';
// import SearchControlLoaded, { SearchControlMobileOptions, ColumnParsed } from './SearchControl/SearchControlLoaded';
// import { clearContextualItems } from "./SearchControl/ContextualItems";
// import { clearManualSubTokens } from "./SearchControl/QueryTokenBuilder";
import { ImportComponent } from './ImportComponent';
// TODO(port): Lines not ported (TypeContext is separate).
// import { EntityBaseController, TypeContext, EntityLine, FormGroup } from "./Lines";
import { TypeContext, type ButtonBarElement } from "./TypeContext";
import { useAPI, type APIHookOptions } from "./Hooks";
import { QueryString } from "./QueryString";
// TODO(port): similarToken (Search), FontAwesomeIcon, Components/Typeahead+ProgressBar, FinderRules,
// Operations, Frames/Notify, Exceptions/Exception not ported.
import type { SearchControlLoaded } from "./Search";
// import { similarToken } from "./Search";
// import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { type BsSize } from "./Components";
import { CollectionMessage } from '../entities/dynamicQueries';
import { QueryTokenMessage } from '../entities/dynamicQueries';
// import { TextHighlighter } from "./Components/Typeahead";
// import * as FinderRules from "./FinderRules";
// import { Operations } from "./Operations";
// import ProgressBar from "./Components/ProgressBar";
// import Notify, { NotifyOptions } from "./Frames/Notify";
// import Exception from "./Exceptions/Exception";

// altea: Finder's per-user client state slice. Signum kept querySettings / queryDescriptionCache as
// module-level vars reset through AppContext.clearSettingsActions; altea stores them in
// AppContext.clientState (see IClientState) so a single newClientState() on login resets everything.
interface FinderClientState {
  querySettings: { [queryKey: string]: Finder.QuerySettings };
}
declare module "./AppContext" {
  interface IClientState {
    finder?: FinderClientState;
  }
}

// TODO(port): minimal aliases for types owned by not-yet-ported modules (Navigator / SearchControl /
// Lines). They keep Finder's QuerySettings / formatter surface compiling; swap for the real types
// when those modules land. ModifiableEntity is altea's BaseEntity.
type ModifiableEntity = BaseEntity;
type ViewPromise<T = any> = any;
type SearchControlMobileOptions = any;
type ColumnParsed = any;

export namespace Finder {

  // Lazily initialise + return Finder's slice of the per-user client state.
  function state(): FinderClientState {
    return AppContext.clientState.finder ??= { querySettings: {} };
  }

  /** Finder's query settings, keyed by query key (stored in AppContext.clientState). */
  export function querySettings(): { [queryKey: string]: QuerySettings } {
    return state().querySettings;
  }

  export function clearQuerySettings(): void {
    state().querySettings = {};
  }

  export function start(options: { routes: RouteObject[] }): void {
    options.routes.push({ path: "/find/:queryName", element: <ImportComponent onImport={() => Options.getSearchPage()} /> });
    // altea divergence: no clearSettingsActions — all module state resets via AppContext.newClientState()
    // (see IClientState). Signum registered clearContextualItems / clearQuerySettings /
    // clearQueryDescriptionCache / clearManualSubTokens / ButtonBarQuery.clearButtonBarElements /
    // resetFormatRules / cleanSearchPageTitleOptions here + onReloadTypesActions.push(clearQueryDescriptionCache).
  }

  export function addSettings(...settings: QuerySettings[]): void {
    settings.forEach(s => Dic.addOrThrow(state().querySettings, getQueryKey(s.queryName), s));
  }

  export function pinnedSearchFilter(): FilterGroupOption;
  export function pinnedSearchFilter<T extends Entity>(type: Type<T>, ...tokens: ((t: QueryTokenString<Anonymous<T>>) => (QueryTokenString<any> | FilterConditionOption))[]): FilterGroupOption;
  export function pinnedSearchFilter<T extends Entity>(type?: Type<T>, ...tokens: ((t: QueryTokenString<Anonymous<T>>) => (QueryTokenString<any> | FilterConditionOption))[]): FilterGroupOption {
    if (type == null) {
      return {
        groupOperation: "Or",
        pinned: { label: "Search" /* TODO(port): SearchMessage.Search.niceToString() */, splitValue: true, active: "WhenHasValue" },
        filters: [
          { token: "Entity.Id", operation: "EqualTo" },
          { token: "Entity.ToString", operation: "Contains" },
        ]
      };
    }

    return {
      groupOperation: "Or",
      pinned: { splitValue: true },
      filters: tokens.map(t => {
        var res = t(new QueryTokenString<Anonymous<T>>("")); // altea: Type<T> (bare ctor) carries no statics; token() ignores `this` and just news up a root QueryTokenString

        if (res instanceof QueryTokenString)
          return { token: res, operation: "Contains" } as FilterConditionOption;

        return res;
      })
    };
  }

  export function getSettings(queryName: PseudoType | QueryKey): QuerySettings | undefined {
    return state().querySettings[getQueryKey(queryName)];
  }

  export function getOrAddSettings(queryName: PseudoType | QueryKey): QuerySettings {
    const qs = state().querySettings;
    return qs[getQueryKey(queryName)] ?? (qs[getQueryKey(queryName)] = { queryName: queryName });
  }

  export const isFindableEvent: Array<(queryKey: string, fullScreen: boolean, context?: Lite<Entity>) => boolean> = [];

  export function isFindable(queryName: PseudoType | QueryKey, fullScreen: boolean, context?: Lite<Entity>): boolean {

    if (!isQueryDefined(queryName))
      return false;

    const queryKey = getQueryKey(queryName);

    return isFindableEvent.every(f => f(queryKey, fullScreen, context));
  }

  // ALTEA STUB: `find` opens the search modal, which needs the SearchControl / SearchModal layer
  // (not ported yet). The entity Lines (EntityBase find button) reference it, so it must exist and
  // typecheck; it throws at runtime until SearchControl lands. Restore the real body (commented
  // below) once Options.getSearchModal + SearchModal are ported.
  export function find<T extends Entity = Entity>(findOptions: FindOptions<T>, modalOptions?: ModalFindOptions): Promise<Lite<T> | undefined>;
  export function find<T extends Entity>(type: Type<T>, modalOptions?: ModalFindOptions): Promise<Lite<T> | undefined>;
  export function find(obj: FindOptions | Type<any>, modalOptions?: ModalFindOptions): Promise<Lite<Entity> | undefined> {
    const fo = (obj as FindOptions).queryName ? obj as FindOptions : { queryName: obj as Type<any> } as FindOptions;
    if (fo.groupResults)
      throw new Error("Use findRow instead");
    // TODO(port): the qs.onFind override + autoSelectIfOne / autoSkipIfZero fast-paths (need fetchLites shape).
    return Options.getSearchModal().then(m => m.default.open(fo, modalOptions)).then(a => a?.row.entity);
  }

  // ALTEA STUB (same rationale as `find`): the multi-select search modal is not ported yet. The entity
  // list Lines (EntityListBase find button) reference it, so it must typecheck; throws until SearchControl lands.
  export function findMany<T extends Entity = Entity>(findOptions: FindOptions<T>, modalOptions?: ModalFindOptionsMany): Promise<Lite<T>[] | undefined>;
  export function findMany<T extends Entity>(type: Type<T>, modalOptions?: ModalFindOptionsMany): Promise<Lite<T>[] | undefined>;
  export function findMany(findOptions: FindOptions | Type<any>, modalOptions?: ModalFindOptionsMany): Promise<Lite<Entity>[] | undefined> {
    const fo = (findOptions as FindOptions).queryName ? findOptions as FindOptions : { queryName: findOptions as Type<any> } as FindOptions;
    // TODO(port): the qs.onFindMany override.
    return Options.getSearchModal().then(m => m.default.openMany(fo, modalOptions)).then(a => a?.rows.map(r => r.entity!));
  }
  //
  //   export function find<T extends Entity = Entity>(findOptions: FindOptions<T>, modalOptions?: ModalFindOptions): Promise<Lite<T> | undefined>;
  //   export function find<T extends Entity>(type: Type<T>, modalOptions?: ModalFindOptions): Promise<Lite<T> | undefined>;
  //   export function find(obj: FindOptions | Type<any>, modalOptions?: ModalFindOptions): Promise<Lite<Entity> | undefined> {
  // 
  //     const fo = (obj as FindOptions).queryName ? obj as FindOptions :
  //       { queryName: obj as Type<any> } as FindOptions;
  // 
  //     if (fo.groupResults)
  //       throw new Error("Use findRow instead");
  // 
  //     var qs = getSettings(fo.queryName);
  //     if (qs?.onFind && !(modalOptions?.useDefaultBehaviour))
  //       return qs.onFind(fo, modalOptions);
  // 
  //     return defaultFind(fo, modalOptions);
  //   }
  // 
  //   export function defaultFind(fo: FindOptions, modalOptions?: ModalFindOptions): Promise<Lite<Entity> | undefined> {
  //     let getPromiseSearchModal: () => Promise<Lite<Entity> | undefined> = () => Options.getSearchModal()
  //       .then(a => a.default.open(fo, modalOptions))
  //       .then(a => a?.row.entity);
  // 
  //     if (modalOptions?.autoSelectIfOne || modalOptions?.autoSkipIfZero)
  //       return fetchLites({ queryName: fo.queryName, filterOptions: fo.filterOptions ?? [], orderOptions: fo.orderOptions ?? [], count: 2 })
  //         .then(data => {
  //           if (data.length == 1 && modalOptions?.autoSelectIfOne)
  //             return Promise.resolve(data[0]);
  // 
  //           if (data.length == 0 && modalOptions?.autoSkipIfZero)
  //             return Promise.resolve(undefined);
  // 
  //           return getPromiseSearchModal();
  //         });
  // 
  //     return getPromiseSearchModal();
  //   }

  export const Options = {
    // TODO(port): SearchPage not ported yet. SearchModal IS ported (lazy dynamic import to avoid a
    // Finder↔SearchModal module-init cycle).
    getSearchPage(): Promise<typeof import('./SearchControl/SearchPage')> { return import('./SearchControl/SearchPage'); },
    getSearchModal(): Promise<typeof import('./SearchControl/SearchModal')> { return import('./SearchControl/SearchModal'); },

    /** Extension point to override the leading content of the search page title. Used by SearchPage. */
    // TODO(port): typed against SearchControlLoaded once SearchControl lands.
    onSearchPageRenderTitle: [] as ((scl: any, defaultTitle: React.ReactNode) => React.ReactNode | undefined)[],
    /** Extension point to render extra elements on the right of the search page title. */
    onSearchPageTitleElements: [] as ((scl: any) => React.ReactNode)[],

    entityColumnHeader: (() => "") as () => React.ReactElement | string | null | undefined,

    // ALTEA: qt.type is a TypeReference; isState reads the enum's name off it. TODO(port): the
    // DateOnly-vs-DateTime distinction — revisit with the format/route layer.
    tokenCanSetPropery: (qt: QueryToken): boolean =>
      qt.filterType == "Lite" && qt.key != "Entity" ||
      qt.filterType == "Enum" && !Options.isState(qt.type),

    isState: (t: TypeReference): boolean => t.getEnum() != null && (t.getTypeName() ?? "").endsWith("State"),

    defaultPagination: {
      mode: "Paginate",
      elementsPerPage: 20,
      currentPage: 1,
    } as Pagination,
  };

  // export function findRow(fo: FindOptions, modalOptions?: ModalFindOptions): Promise<{ row: ResultRow, searchControl: SearchControlLoaded } | undefined> {

  //   var qs = getSettings(fo.queryName);
  // 
  //     return Options.getSearchModal()
  //       .then(a => a.default.open(fo, modalOptions));
  //   }
  // 
  // 
  //   export function findMany<T extends Entity>(findOptions: FindOptions<T>, modalOptions?: ModalFindOptionsMany): Promise<Lite<T>[] | undefined>;
  //   export function findMany<T extends Entity>(type: Type<T>, modalOptions?: ModalFindOptionsMany): Promise<Lite<T>[] | undefined>;
  //   export function findMany(findOptions: FindOptions | Type<any>, modalOptions?: ModalFindOptionsMany): Promise<Lite<Entity>[] | undefined> {
  // 
  //     const fo = (findOptions as FindOptions).queryName ? findOptions as FindOptions :
  //       { queryName: findOptions as Type<any> } as FindOptions;
  // 
  // 
  //     var qs = getSettings(fo.queryName);
  //     if (qs?.onFindMany && !(modalOptions?.useDefaultBehaviour))
  //       return qs.onFindMany(fo, modalOptions);
  // 
  //     return defaultFindMany(fo, modalOptions);
  //   }
  // 
  //   export function defaultFindMany(fo: FindOptions, modalOptions?: ModalFindOptionsMany): Promise<Lite<Entity>[] | undefined> {
  //     let getPromiseSearchModal: () => Promise<Lite<Entity>[] | undefined> = () => Options.getSearchModal()
  //       .then(SearchModal => SearchModal.default.openMany(fo, modalOptions))
  //       .then(pair => {
  //         if (!pair)
  //           return undefined;
  // 
  //         const sc = pair.searchControl!;
  // 
  //         if (sc.props.findOptions.groupResults)
  //           return sc.getGroupedSelectedEntities();
  // 
  //         return pair.rows.map(a => a.entity!);
  //       });
  // 
  //     if (modalOptions?.autoSelectIfOne || modalOptions?.autoSkipIfZero)
  //       return fetchLites({ queryName: fo.queryName, filterOptions: fo.filterOptions || [], orderOptions: fo.orderOptions || [], count: 2 })
  //         .then(data => {
  //           if (data.length == 1 && modalOptions?.autoSelectIfOne)
  //             return Promise.resolve(data);
  // 
  //           if (data.length == 0 && modalOptions?.autoSkipIfZero)
  //             return Promise.resolve(data);
  // 
  //           return getPromiseSearchModal();
  //         });
  // 
  //     return getPromiseSearchModal();
  //   }
  // 
  //   export function findManyRows(fo: FindOptions, modalOptions?: ModalFindOptionsMany): Promise<{ rows: ResultRow[], searchControl: SearchControlLoaded } | undefined> {
  // 
  //     var qs = getSettings(fo.queryName);
  // 
  //     return Options.getSearchModal()
  //       .then(a => a.default.openMany(fo, modalOptions));
  //   }
  // 
  //   export function exploreWindowsOpen(findOptions: FindOptions, e: React.MouseEvent<any>): void {
  //     e.preventDefault();
  //     if (e.ctrlKey || e.button == 1)
  //       window.open(AppContext.toAbsoluteUrl(findOptionsPath(findOptions)));
  //     else
  //       explore(findOptions);
  //   }
  // 
  //   export function explore(findOptions: FindOptions, modalOptions?: ModalFindOptions): Promise<void> {
  // 
  //     var qs = getSettings(findOptions.queryName);
  //     if (qs?.onExplore && !(modalOptions?.useDefaultBehaviour))
  //       return qs.onExplore(findOptions, modalOptions);
  // 
  //     return Options.getSearchModal()
  //       .then(a => a.default.explore(findOptions, modalOptions));
  //   }
  // 
  export function findOptionsPath(fo: FindOptions, extra?: any): string {

    const query = findOptionsPathQuery(fo, extra);
    var strQuery = QueryString.stringify(query);

    return "/find/" + getQueryKey(fo.queryName) + (strQuery ? ("?" + strQuery) : "");
  }

  export function findOptionsPathQuery(fo: FindOptions, extra?: any): any {
    fo = autoRemoveTrivialColumns(fo);

    const query = {
      groupResults: fo.groupResults || undefined,
      idf: fo.includeDefaultFilters,
      columnMode: (!fo.columnOptionsMode || fo.columnOptionsMode == "Add" as ColumnOptionsMode) ? undefined : fo.columnOptionsMode,
      paginationMode: fo.pagination && fo.pagination.mode,
      elementsPerPage: fo.pagination && fo.pagination.elementsPerPage,
      currentPage: fo.pagination && fo.pagination.currentPage,
      systemTimeMode: fo.systemTime?.mode,
      systemTimeJoinMode: fo.systemTime?.joinMode,
      systemTimeStartDate: fo.systemTime?.startDate,
      systemTimeEndDate: fo.systemTime?.endDate,
      timeSeriesStep: fo.systemTime?.timeSeriesStep,
      timeSeriesUnit: fo.systemTime?.timeSeriesUnit,
      timeSeriesMaxRowsPerStep: fo.systemTime?.timeSeriesMaxRowsPerStep,
      splitQueries: fo.systemTime?.splitQueries,
      ...extra
    };

    Encoder.encodeFilters(query, fo.filterOptions?.notNull());
    Encoder.encodeOrders(query, fo.orderOptions?.notNull());
    Encoder.encodeColumns(query, fo.columnOptions?.notNull().map(toColumnOption));

    return query;
  }

  export function getTypeNiceName(rt: TypeReference): string {

    const tis = rt.typeInfos();
    const niceName = tis.length > 0
      ? tis.map(ti => ti.getNiceName()).joinComma(CollectionMessage.Or.niceToString())
      : getSimpleTypeNiceName(rt.getTypeName() ?? ""); // value/enum column (no TypeInfo)

    return rt.array ? QueryTokenMessage.ListOf0.niceToString(niceName) : niceName;
  }

  export function getSimpleTypeNiceName(name: string): string {

    // TODO(port): altea has no isDecimalType (no separate decimal type-name); Number covers it.
    if (isNumberType(name))
      return QueryTokenMessage.Number.niceToString();

    switch (name) {
      case "string":
      case "Guid":
        return QueryTokenMessage.Text.niceToString();
      case "Date": return QueryTokenMessage.Date.niceToString();
      case "DateTime": return QueryTokenMessage.DateTime.niceToString();
      case "DateTimeOffset": return QueryTokenMessage.DateTimeOffset.niceToString();
      case "boolean": return QueryTokenMessage.Check.niceToString();
    }

    return name;
  }


  export function parseFindOptionsPath(queryName: PseudoType | QueryKey, query: any): FindOptions {

    const result: FindOptions = {
      queryName: queryName,
      groupResults: parseBoolean(query.groupResults),
      includeDefaultFilters: parseBoolean(query.idf),
      filterOptions: Decoder.decodeFilters(query),
      orderOptions: Decoder.decodeOrders(query),
      columnOptions: Decoder.decodeColumns(query),
      columnOptionsMode: query.columnMode == undefined ? "Add" : query.columnMode,
      pagination: query.paginationMode && {
        mode: query.paginationMode,
        elementsPerPage: query.elementsPerPage,
        currentPage: query.currentPage,
      } as Pagination,
      systemTime: query.systemTimeMode && {
        mode: query.systemTimeMode,
        joinMode: query.systemTimeJoinMode,
        startDate: query.systemTimeStartDate,
        endDate: query.systemTimeEndDate,
        timeSeriesUnit: query.timeSeriesUnit,
        timeSeriesStep: query.timeSeriesStep && parseInt(query.timeSeriesStep),
        timeSeriesMaxRowsPerStep: query.timeSeriesMaxRowsPerStep && parseInt(query.timeSeriesMaxRowsPerStep),
        splitQueries: Boolean(query.splitQueries),
      }
    };

    return Dic.simplify(result)!;
  }

  export function getDefaultColumns(queryToken: QueryToken): QueryToken[] {
    const qs = getSettings(getKey(queryToken.queryName));
    if (qs?.defaultColumns != null && qs.defaultColumns.length > 0)
      return qs.defaultColumns
        .map(c => resolveColumnToken(queryToken, typeof c === "string" ? c : c.toString()))
        .filter((t): t is QueryToken => t != null);

    // Default: the first 5 non-collection columns (Signum showed every column; altea keeps the grid
    // tidy and lets Type.querySettings override).
    return queryToken.subTokens(SubTokensOptionsAll)
      .filter(a => !a.hasAggregate() && !a.hasTimeSeries() && a.type?.array !== true)
      .slice(0, 5);
  }

  // Resolve a (possibly dotted) column key to a sub-token, matching keys CASE-INSENSITIVELY: altea's
  // entity-field tokens are camelCase (`orderDate`) while Type.token produces PascalCase strings
  // (`token(a => a.orderDate)` → "OrderDate") and system tokens are PascalCase (`ToString`) — a
  // case-insensitive match resolves all three. Returns undefined if any segment is unknown.
  function resolveColumnToken(root: QueryToken, key: string): QueryToken | undefined {
    let cur: QueryToken | undefined = root;
    for (const part of key.split(".")) {
      cur = cur!.subTokens(SubTokensOptionsAll).find(t => t.key.toLowerCase() === part.toLowerCase());
      if (cur == null) return undefined;
    }
    return cur;
  }

  export function mergeColumns(queryToken: QueryToken, mode: ColumnOptionsMode, columnOptions: ColumnOption[]): ColumnOption[] {

    var columns = getDefaultColumns(queryToken);

    switch (mode) {
      case "Add":
        return columns.map(cd => softCast<ColumnOption>({ token: cd.fullKey() }))
          .concat(columnOptions);

      case "InsertStart":
        return columnOptions
          .concat(columns.map(cd => softCast<ColumnOption>({ token: cd.fullKey() })));

      case "Remove":
        return columns.filter(cd => !columnOptions.some(a => a.token == cd.fullKey()))
          .map(cd => softCast<ColumnOption>({ token: cd.fullKey() }));

      case "ReplaceAll":
        return columnOptions;

      case "ReplaceOrAdd": {
        var original = columns.map(cd => softCast<ColumnOption>({ token: cd.fullKey() }));
        columnOptions.forEach(toReplaceOrAdd => {
          var index = original.findIndex(co => co.token.toString() == toReplaceOrAdd.token.toString());
          if (index != -1)
            original[index] = toReplaceOrAdd;
          else
            original.push(toReplaceOrAdd);
        });
        return original;
      }
      default: throw new Error("Unexpected column mode");
    }
  }

  export function smartColumns(current: ColumnOptionParsed[], queryToken: QueryToken): { mode: ColumnOptionsMode; columns: ColumnOption[] } {

    const similar = (c: ColumnOptionParsed, d: QueryToken) =>
      c.token!.fullKey() == d.fullKey() && (c.displayName == d.niceName()) && c.summaryToken == null && c.combineRows == null && !c.hiddenColumn;

    const toColumnOption = (c: ColumnOptionParsed) => ({
      token: c.token!.fullKey(),
      displayName: c.token!.niceName() == c.displayName ? undefined : c.displayName,
      summaryToken: c.summaryToken?.fullKey(),
      combineRows: c.combineRows,
      hiddenColumn: c.hiddenColumn,
    }) as ColumnOption;

    var ideal = Finder.getDefaultColumns(queryToken);

    current = current.filter(a => a.token != null);

    if (ideal.every((idl, i) => i < current.length && similar(current[i], idl))) {
      return {
        mode: "Add",
        columns: current.slice(ideal.length).map(c => toColumnOption(c))
      };
    }

    if (ideal.every((idl, i) => i < current.length && current[i].token!.fullKey() == idl.fullKey())) {

      var replacements = current.filter((curr, i) => i < ideal.length && !similar(curr, ideal[i])).map(c => toColumnOption(c));
      var additions = current.slice(ideal.length).map(c => toColumnOption(c));

      return {
        mode: "ReplaceOrAdd",
        columns: [...replacements, ...additions]
      };
    }

    if (current.length < ideal.length) {
      const toRemove: ColumnOption[] = [];

      let j = 0;
      for (let i = 0; i < ideal.length; i++) {
        if (j < current.length && similar(current[j], ideal[i]))
          j++;
        else
          toRemove.push({ token: ideal[i].fullKey(), });
      }

      if (toRemove.length + current.length == ideal.length && toRemove.length < current.length) {
        return {
          mode: "Remove",
          columns: toRemove
        };
      }
    }

    return {
      mode: "ReplaceAll",
      columns: current.map(c => toColumnOption(c)),
    };
  }

  function parseBoolean(value: any): boolean | undefined {
    if (value === "true" || value === true)
      return true;

    if (value === "false" || value === false)
      return false;

    return undefined;
  }

  export function parseFilterOptions(fos: (FilterOption | null | undefined)[], groupResults: boolean, queryToken: QueryToken): Promise<FilterOptionParsed[]> {

    const completer = new TokenCompleter(queryToken);
    var sto = SubTokensOptions.CanElement | SubTokensOptions.CanAnyAll | (groupResults ? SubTokensOptions.CanAggregate : 0);

    fos.notNull().forEach(fo => completer.requestFilter(fo));

    return completer.finished()
      .then(() => fos.notNull().map(fo => completer.toFilterOptionParsed(fo, sto)))
      .then(filters => parseFilterValues(filters).then(() => filters));
  }



  export function parseOrderOptions(orderOptions: (OrderOption | null | undefined)[], groupResults: boolean, queryToken: QueryToken): Promise<OrderOptionParsed[]> {

    const completer = new TokenCompleter(queryToken);
    var sto = SubTokensOptions.CanElement | SubTokensOptions.CanSnippet | (groupResults ? SubTokensOptions.CanAggregate : 0);
    orderOptions.notNull().forEach(a => completer.request(a.token.toString()));

    return completer.finished()
      .then(() => orderOptions.notNull().map(oo => ({
        token: completer.get(oo.token.toString(), sto),
        orderType: oo.orderType ?? "Ascending",
      }) as OrderOptionParsed));
  }

  export function parseColumnOptions(columnOptions: ColumnOption[], groupResults: boolean, queryToken: QueryToken): Promise<ColumnOptionParsed[]> {

    const completer = new TokenCompleter(queryToken);
    var sto = SubTokensOptions.CanElement | SubTokensOptions.CanToArray | SubTokensOptions.CanSnippet | (groupResults ? SubTokensOptions.CanAggregate : SubTokensOptions.CanOperation | SubTokensOptions.CanManual);
    columnOptions.forEach(a => completer.request(a.token.toString()));
    columnOptions.filter(a => a.summaryToken != null).forEach(a => completer.request(a.summaryToken!.toString()));

    return completer.finished()
      .then(() => columnOptions.map(co => {

        const token = completer.get(co.token.toString(), sto);

        return ({
          token: token,
          displayName: (typeof co.displayName == "function" ? co.displayName() : co.displayName) ?? token.niceName,
          summaryToken: co.summaryToken && completer.get(co.summaryToken.toString(), SubTokensOptions.CanAggregate),
          combineEquals: co.combineRows,
          hiddenColumn: co.hiddenColumn,
        }) as ColumnOptionParsed
      }));
  }



  export async function getPropsFromFilters(type: PseudoType, filterOptionsParsed: FilterOptionParsed[], options?: { avoidCustom?: boolean }): Promise<any> {

    if (!(options?.avoidCustom) && querySettings()[getTypeName(type)]?.customGetPropsFromFilter) {
      return querySettings()[getTypeName(type)].customGetPropsFromFilter!([...filterOptionsParsed]);
    }

    var result = getPropsFromFiltersSync(type, filterOptionsParsed, true);

    var promiseMembers = Object.entries(result).filter(([key, value]) => isPromise(value));

    await Promise.all(promiseMembers.map(async ([key, value]) => result[key] = await value));

    return result;
  }

  export function getPropsFromFiltersSync(type: PseudoType, filterOptionsParsed: FilterOptionParsed[], retrieveEntityInPromise: boolean = false): any {

    const ti = getTypeInfo(type);

    function getMemberForToken(ti: TypeInfo, fullKey: string) {
      var token = fullKey.tryAfter("Entity.") ?? fullKey;

      if (token.contains("."))
        return null;

      return ti.members[token];
    }

    const result: any = {};

    filterOptionsParsed.forEach(fo => {

      if (isFilterGroup(fo) ||
        fo.token == null ||
        !Options.tokenCanSetPropery(fo.token) ||
        fo.operation != "EqualTo" ||
        !isActive(fo))
        return;

      const mi = getMemberForToken(ti, fo.token!.fullKey());

      if (!mi)
        return;

      const valueOrPromise = tryConvert(fo.value, mi, retrieveEntityInPromise);

      result[mi.name.firstLower()] = valueOrPromise;
    });

    return result;
  }

  // ALTEA: the member's type is a FieldInfo (Signum's TypeReference is gone). Field flags read off
  // fieldInfo (lite / typeName), with altea's typeName vocab (String / Boolean / PlainDate / …).
  export function tryConvert(value: any, type: FieldInfo, retrieveEntityInPromise: boolean): any | undefined {

    if (value == null)
      return null;

    if (type.lite) {

      if (value instanceof Lite)
        return value;

      if (value instanceof Entity)
        return value.toLite();

      return undefined;
    }

    const ti = tryGetTypeInfo(type.typeName);

    if (ti?.kind == "Entity") {

      if (value instanceof Lite)
        return retrieveEntityInPromise ? Navigator.API.fetch(value) : value;

      if (value instanceof Entity)
        return value;

      return undefined;
    }

    if (type.typeName == "String" || type.typeName == "Guid" || type.typeName == "PlainDate" || ti?.kind == "Enum") {
      if (typeof value === "string")
        return value;

      return undefined;
    }

    if (type.typeName == "Boolean") {
      if (typeof value === "boolean")
        return value;
    }

    if (isNumberType(type.typeName) || type.typeName == "Decimal") {
      if (typeof value === "number")
        return value;
    }

    return undefined;
  }


  export function getPropsFromFindOptions(type: PseudoType, fo: FindOptions | undefined): Promise<any> {
    if (fo == null)
      return Promise.resolve(undefined);

    return getQueryRoot(fo.queryName)
      .then(qt => parseFindOptions(fo, qt, true))
      .then(fop => getPropsFromFilters(type, fop.filterOptions));
  }

  export function toFindOptions(fo: FindOptionsParsed, queryToken: QueryToken, defaultIncludeDefaultFilters: boolean): FindOptions {

    const pair = smartColumns(fo.columnOptions, queryToken);

    const qs = getSettings(fo.queryKey);

    const defPagination = qs?.pagination ?? Options.defaultPagination;

    function equalsPagination(p1: Pagination, p2: Pagination) {
      return p1.mode == p2.mode && p1.elementsPerPage == p2.elementsPerPage && p1.currentPage == p2.currentPage;
    }

    var findOptions = {
      queryName: fo.queryKey,
      groupResults: fo.groupResults ? true : undefined,
      filterOptions: toFilterOptions(fo.filterOptions),
      orderOptions: fo.orderOptions.filter(a => !!a.token).map(o => ({ token: o.token.fullKey(), orderType: o.orderType }) as OrderOption),
      columnOptions: pair.columns,
      columnOptionsMode: pair.mode,
      pagination: fo.pagination && !equalsPagination(fo.pagination, defPagination) ? fo.pagination : undefined,
      systemTime: fo.systemTime,
    } as FindOptions;

    if (!findOptions.groupResults && findOptions.orderOptions) {
      var defaultOrder = getDefaultOrder(queryToken, qs);

      if (equalOrders(defaultOrder, findOptions.orderOptions.notNull()))
        findOptions.orderOptions = undefined;
    }

    if (findOptions.filterOptions) {
      var defaultFilters = getDefaultFilter(queryToken, qs);
      var filterOptions = findOptions.filterOptions.notNull();
      if (defaultFilters && defaultFilters.length <= filterOptions.length) {
        if (equalFilters(defaultFilters, filterOptions.slice(0, defaultFilters.length))) {
          findOptions.filterOptions = filterOptions.slice(defaultFilters.length);
          findOptions.includeDefaultFilters = true;
        }
      }
    }
    if (!findOptions.includeDefaultFilters)
      findOptions.includeDefaultFilters = false;

    if (findOptions.includeDefaultFilters == defaultIncludeDefaultFilters)
      delete findOptions.includeDefaultFilters;

    return findOptions;
  }

  function equalOrders(as: OrderOption[] | undefined, bs: OrderOption[] | undefined): boolean {
    if (as == undefined && bs == undefined)
      return true;

    if (as == undefined || bs == undefined)
      return false;

    return as.length == bs.length && as.every((a, i) => {
      var b = bs![i];

      return (a.token && a.token.toString()) == (b.token && b.token.toString()) &&
        a.orderType == b.orderType;
    });
  }

  function equalFilters(as: FilterOption[] | undefined, bs: FilterOption[] | undefined): boolean {

    if (as == undefined && bs == undefined)
      return true;

    if (as == undefined || bs == undefined)
      return false;

    return as.length == bs.length && as.every((a, i) => {
      var b = bs![i];

      return (a.token && a.token.toString()) == (b.token && b.token.toString()) &&
        (a as FilterGroupOption).groupOperation == (b as FilterGroupOption).groupOperation &&
        ((a as FilterConditionOption).operation ?? "EqualTo") == ((b as FilterConditionOption).operation ?? "EqualTo") &&
        (a.value == b.value || ((a.value instanceof Lite || a.value instanceof Entity) && a.value.is(b.value))) && // altea: .is() is an instance method (Signum's free is())
        Dic.equals(a.pinned, b.pinned, true) &&
        equalFilters((a as FilterGroupOption).filters?.notNull(), (b as FilterGroupOption).filters?.notNull());
    });
  }

  export const defaultOrderColumn: string = "Id";

  export function getDefaultOrder(queryToken: QueryToken, qs: QuerySettings | undefined): OrderOption[] | undefined {
    if (qs?.defaultOrders)
      return qs.defaultOrders;

    // ALTEA: the query's entity type comes from its queryKey (Signum read it off the "Entity" column's
    // TypeReference; altea columns carry a RuntimeType, and the root isn't a column entry).
    const ti = tryGetTypeInfo(getKey(queryToken.queryName));

    if (!queryToken.subTokens(SubTokensOptionsAll).find(t => t.fullKey() == defaultOrderColumn))
      return undefined;

    return [{
      token: defaultOrderColumn,
      orderType: (ti == null || ti.entityData == "Transactional") ? "Descending" : "Ascending"
    }];
  }

  export function getDefaultFilter(queryToken: QueryToken | undefined, qs: QuerySettings | undefined): FilterOption[] | undefined {
    if (qs?.defaultFilters)
      return qs.defaultFilters;

    if (qs?.simpleFilterBuilder)
      return undefined;

    if (queryToken == null || queryToken) {
      return [
        {
          groupOperation: "Or",
          pinned: { label: "Search" /* TODO(port): SearchMessage.Search.niceToString() */, splitValue: true, active: "WhenHasValue" },
          filters: [
            { token: "Entity.ToString", operation: "Contains" },
            { token: "Entity.Id", operation: "EqualTo" },
          ]
        }
      ];
    }
    else {
      return undefined;
    }
  }

  export function isAggregate(fop: FilterOptionParsed): boolean {
    if (isFilterGroup(fop))
      return fop.filters.some(f => isAggregate(f));

    return fop.token != null && fop.token.hasAggregate();
  }

  export function toFilterOptions(filterOptionsParsed: FilterOptionParsed[]): FilterOption[] {

    function toFilterOption(fop: FilterOptionParsed): FilterOption | null {

      var pinned = fop.pinned && Dic.simplify({ ...fop.pinned }) as PinnedFilter;
      if (isFilterGroup(fop))
        return ({
          token: fop.token && fop.token.fullKey(),
          groupOperation: fop.groupOperation,
          value: fop.value === "" ? undefined : fop.value,
          pinned: pinned,
          dashboardBehaviour: fop.dashboardBehaviour,
          filters: fop.filters.map(fp => toFilterOption(fp)).filter(fo => !!fo),
        }) as FilterGroupOption;
      else {
        if (fop.token == null)
          return null;

        return ({
          token: fop.token && fop.token.fullKey(),
          operation: fop.operation,
          value: fop.value === "" ? undefined : fop.value,
          frozen: fop.frozen ? true : undefined,
          pinned: pinned,
          dashboardBehaviour: fop.dashboardBehaviour,
        }) as FilterConditionOption;
      }
    }

    return filterOptionsParsed.map(fop => toFilterOption(fop)).filter(fo => fo != null) as FilterOption[];
  }

  export function parseFindOptions(findOptions: FindOptions, queryToken: QueryToken, defaultIncludeDefaultFilters: boolean): Promise<FindOptionsParsed> {
    const fo = autoRemoveTrivialColumns(findOptions);

    fo.columnOptions = mergeColumns(queryToken, fo.columnOptionsMode ?? "Add", fo.columnOptions?.notNull().map(toColumnOption) ?? []);

    var qs: QuerySettings | undefined = querySettings()[getKey(queryToken.queryName)];

    if (!fo.groupResults && (!fo.orderOptions || fo.orderOptions.length == 0)) {
      var defaultOrder = getDefaultOrder(queryToken, qs);

      if (defaultOrder)
        fo.orderOptions = defaultOrder;
    }

    if (fo.includeDefaultFilters == null ? defaultIncludeDefaultFilters : fo.includeDefaultFilters) {
      var defaultFilters = getDefaultFilter(queryToken, qs);
      if (defaultFilters)
        fo.filterOptions = [...defaultFilters, ...fo.filterOptions ?? []];
    }

    if (fo.filterOptions)
      fo.filterOptions = simplifyPinnedFilters(fo.filterOptions.notNull());

    const canAggregate = (findOptions.groupResults ? SubTokensOptions.CanAggregate : 0);
    const canAggregateXorOperation = (canAggregate != 0 ? canAggregate : SubTokensOptions.CanOperation | SubTokensOptions.CanManual);
    const canTimeSeries = (fo.systemTime?.mode == QueryTokenString.timeSeries.token ? SubTokensOptions.CanTimeSeries : 0);

    const completer = new TokenCompleter(queryToken);


    if (fo.filterOptions)
      fo.filterOptions.notNull().forEach(fo => completer.requestFilter(fo));

    if (fo.orderOptions)
      fo.orderOptions.notNull().forEach(oo => completer.request(oo.token.toString()));

    if (fo.columnOptions) {
      fo.columnOptions.notNull().map(toColumnOption).forEach(co => completer.request(co.token.toString()));
      fo.columnOptions.notNull().map(toColumnOption).filter(a => a.summaryToken).forEach(co => completer.request(co.summaryToken!.toString()));
    }

    return completer.finished().then(() => {

      var result: FindOptionsParsed = {
        queryKey: getKey(queryToken.queryName),
        groupResults: fo.groupResults == true,
        pagination: fixPagination(fo.pagination != null ? fo.pagination : qs?.pagination ?? Options.defaultPagination),
        systemTime: fo.systemTime && fixSystemTime(fo.systemTime),

        columnOptions: (fo.columnOptions?.notNull().map(toColumnOption) ?? []).map(co => {

          const token = completer.get(co.token.toString(), SubTokensOptions.CanElement | SubTokensOptions.CanToArray | SubTokensOptions.CanSnippet | canAggregateXorOperation | canTimeSeries);

          return softCast<ColumnOptionParsed>({
            token: token,
            displayName: (typeof co.displayName == "function" ? co.displayName() : co.displayName) ?? token.niceName(),
            summaryToken: co.summaryToken ? completer.get(co.summaryToken.toString(), SubTokensOptions.CanElement | SubTokensOptions.CanAggregate) : undefined,
            hiddenColumn: co.hiddenColumn,
            combineRows: co.combineRows,
          });
        }),

        orderOptions: (fo.orderOptions?.notNull() ?? []).map(oo => ({
          token: completer.get(oo.token.toString(), SubTokensOptions.CanElement | SubTokensOptions.CanSnippet | canAggregate | canTimeSeries),
          orderType: oo.orderType,
        }) as OrderOptionParsed),

        filterOptions: (fo.filterOptions?.notNull() ?? []).map(fo => completer.toFilterOptionParsed(fo, SubTokensOptions.CanElement | SubTokensOptions.CanAnyAll | canAggregate | canTimeSeries)),
      };

      return parseFilterValues(result.filterOptions)
        .then(() => result)
    });
  }

  function fixPagination(p: Pagination): Pagination {
    return {
      mode: p.mode,
      elementsPerPage: p.mode == "All" ? undefined : p.elementsPerPage == null || p.elementsPerPage < 0 ? 20 : p.elementsPerPage,
      currentPage: p.mode != "Paginate" ? undefined : p.currentPage == null || p.currentPage < 0 ? 1 : p.currentPage,
    };
  }

  function fixSystemTime(p: SystemTime): SystemTime {
    return {
      ...p
    };
  }

  function simplifyPinnedFilters(fos: FilterOption[]): FilterOption[] {

    const toRemove: FilterOption[] = [];
    const result = fos.map(fo => {
      if (fo.pinned != null &&
        (fo.pinned?.active == "Always" || fo.pinned?.active == "WhenHasValue") &&
        !isFilterGroup(fo)) {

        var fo2 = fos.firstOrNull(fo2 =>
          fo2.pinned == null &&
          !isFilterGroup(fo2) &&
          // TODO(port): similarToken (Search) — token-string equality until it's ported.
          fo.token?.toString() == fo2.token?.toString() &&
          (fo.operation ?? "EqualTo") == (fo2.operation ?? "EqualTo") &&
          (fo.pinned?.active == "Always" || fo2.value != null));

        if (fo2 != null) {
          toRemove.push(fo2);
          return { ...fo, value: fo2.value } as FilterConditionOption;
        }
      }
      return fo;

    });

    return result.filter(fo => fo && !toRemove.contains(fo));
  }

  export function getQueryRequest(fo: FindOptionsParsed, qs?: QuerySettings, avoidHiddenColumns?: boolean): QueryRequest {

    return {
      queryKey: fo.queryKey,
      groupResults: fo.groupResults,
      filters: toFilterRequests(fo.filterOptions),
      columns: fo.columnOptions.filter(a => a.token != undefined).map(co => ({ token: co.token!.fullKey(), displayName: co.displayName! }))
        .concat((!fo.groupResults && !avoidHiddenColumns && qs?.hiddenColumns || []).map(co => ({ token: co.token.toString(), displayName: "" }))),
      orders: fo.orderOptions.filter(a => a.token != undefined).map(oo => ({ token: oo.token.fullKey(), orderType: oo.orderType })),
      pagination: fo.pagination,
      systemTime: fo.systemTime,
    };
  }

  export function getSummaryQueryRequest(fo: FindOptionsParsed): QueryRequest | null {

    var summaryTokens = fo.columnOptions.filter(a => a.summaryToken != undefined).map(a => a.summaryToken!)
      .filter(a => a.hasAggregate());

    if (summaryTokens.length == 0)
      return null;

    return {
      queryKey: fo.queryKey,
      groupResults: true,
      filters: toFilterRequests(fo.filterOptions),
      columns: summaryTokens.map(sqt => ({ token: sqt.fullKey(), displayName: sqt.niceName() })),
      orders: [],
      pagination: { mode: "All" }, //Should be 1 result anyway
      systemTime: fo.systemTime,
    };
  }

  export function validateNewEntities(fo: FindOptions): string | undefined {

    function getValues(fo: FilterOption): any[] {
      if (isFilterGroup(fo))
        return fo.filters.notNull().flatMap(f => getValues(f));

      return [fo.value];
    }

    var allValues = (fo.filterOptions?.notNull() ?? []).flatMap(fo => getValues(fo));

    var allNewTypes = allValues.flatMap(a => getTypeIfNew(a));

    if (allNewTypes.length == 0)
      return undefined;

    return `Filtering by new ${allNewTypes.joinComma(" and ")}. Consider hiding the control for new entities.`;
  }

  function getTypeIfNew(val: any): string[] {
    if (!val)
      return [];

    if (val instanceof Entity && val.isNew)
      return [getTypeName(val)];

    if (val instanceof Lite && val.id == null)
      return [getTypeName(val)];

    if (Array.isArray(val))
      return val.flatMap(v => getTypeIfNew(v));

    return [];
  }



  // TODO(port): exploreOrView needs Navigator.view (not yet on the ported Navigator) and Finder.explore
  // (part of the commented-out find/explore UI family). Restore once those land.
  export function exploreOrView(findOptions: FindOptions): Promise<void> {
    throw new Error("TODO(port): exploreOrView — Navigator.view + Finder.explore not ported yet");
    // return fetchLites({ queryName: findOptions.queryName, filterOptions: findOptions.filterOptions ?? [], orderOptions: [], count: 2 }).then(list => {
    //   if (list.length == 1)
    //     return Navigator.view(list[0], { buttons: "close" }).then(() => undefined);
    //   else
    //     return explore(findOptions);
    // });
  }

  export function useQueryValue<T = number>(queryName: PseudoType | QueryKey | null, filterOptions: (FilterOption | null | undefined)[], valueToken?: QueryTokenString<T> | string, multipleValues?: boolean, extraDeps?: React.DependencyList): T | null | undefined {

    var query = {};
    Encoder.encodeFilters(filterOptions);

    return useAPI(() => !queryName ? null : getQueryValue(queryName, filterOptions, valueToken, multipleValues),
      [
        queryName && getQueryKey(queryName),
        QueryString.stringify(query),
        valueToken?.toString(),
        multipleValues,
        ...(extraDeps ?? [])
      ]);
  }

  export function getQueryValue<T = number>(queryName: PseudoType | QueryKey, filterOptions: (FilterOption | null | undefined)[], valueToken?: QueryTokenString<T> | string, multipleValues?: boolean): Promise<T> {
    return getQueryRoot(queryName).then(qt => {
      return parseFilterOptions(filterOptions ?? [], false, qt).then(fops => {

        let filters = toFilterRequests(fops);

        return API.queryValue({ queryKey: getKey(qt.queryName), filters, valueToken: valueToken?.toString(), multipleValues });
      });
    });
  }

  export function toFilterRequests(fops: FilterOptionParsed[], overridenValue?: OverridenValue): FilterRequest[] {
    return fops.map(fop => toFilterRequest(fop, overridenValue)).filter(a => a != null) as FilterRequest[];
  }

  interface OverridenValue {
    value: any;
    convertListToScalar?: boolean;
  }


  export function toFilterRequest(fop: FilterOptionParsed, overridenValue?: OverridenValue): FilterRequest | undefined {

    if (fop.pinned && (fop.pinned.active == "Checkbox_Unchecked" || fop.pinned.active == "NotCheckbox_Checked"))
      return undefined;

    if (fop.dashboardBehaviour == "UseAsInitialSelection")
      return undefined;

    const operation = (fop as FilterConditionOptionParsed).operation;

    if (fop.pinned && overridenValue == null) {
      if (fop.pinned.splitValue) {

        if (!fop.value || Array.isArray(fop.value) && fop.value.length == 0)
          return undefined;

        if (!canSplitValue(fop))
          throw new Error("Split text only works with string");


        if (typeof fop.value == "string") {
          const parts = fop.value.split(/\s+/);

          return ({
            groupOperation: "And",
            token: fop.token?.fullKey(),
            filters: parts.filter(a => a.length > 0).map(part => toFilterRequest(fop, { value: part })),
          }) as FilterGroupRequest;
        }
        if (operation && isList(operation)) {

          const parts = (fop.value as unknown[]);

          var newOperation: FilterOperation = operation == "IsIn" ? "EqualTo" : "DistinctTo";

          return ({
            groupOperation: "And",
            //token: fop.token?.fullKey(),
            filters: parts.map(part => toFilterRequest({ ...fop, operation: newOperation }, { value: part })),
          }) as FilterGroupRequest;
        }

        if (isFilterGroup(fop) && Array.isArray(fop.value)) {
          const parts = fop.value as any[];
          return ({
            groupOperation: "And",
            filters: parts.map(part => toFilterRequest(fop, { value: part, convertListToScalar: true })).filter(a => a != null)
          }) as FilterGroupRequest;
        }
      }
      else if (isFilterGroup(fop)) {

        if (fop.pinned.active == "WhenHasValue" && (fop.value == null || fop.value == "" || Array.isArray(fop.value) && fop.value.length == 0)) {
          return undefined;
        }

        if (fop.pinned.active == "Checkbox_Checked") {

        } else {
          return toFilterRequest(fop, { value: fop.value });
        }

      }
    }

    if (isFilterGroup(fop))
      return ({
        groupOperation: fop.groupOperation,
        token: fop.token && fop.token.fullKey(),
        filters: toFilterRequests(fop.filters, overridenValue)
      } as FilterGroupRequest);
    else {
      if (fop.token == null || fop.token.filterType == null || fop.operation == null)
        return undefined;

      if (overridenValue == null && fop.pinned && fop.pinned.active == "WhenHasValue" && (fop.value == null || fop.value === ""))
        return undefined;

      const effectiveOp: FilterOperation = overridenValue?.convertListToScalar && isList(fop.operation)
        ? (fop.operation == "IsIn" ? "EqualTo" : "DistinctTo")
        : fop.operation;

      const value = overridenValue ? overridenValue.value : fop.value;

      if (fop.token && typeof value == "string") {
        // ALTEA: a token's value type is a FilterType (Signum tested type.name against C# type names).
        if (fop.token.filterType == "Integer" || fop.token.filterType == "Decimal") {

          const numVal = parseInt(value);

          // TODO(port): numberLimits (per-C#-type min/max overflow guard) — altea has a single numeric
          // type, so the range check is dropped; a NaN still removes the value.
          if (isNaN(numVal)) {
            if (overridenValue)
              return undefined;

            return ({
              token: fop.token.fullKey(),
              operation: effectiveOp,
              value: undefined,
            } as FilterConditionRequest);
          }

          return ({
            token: fop.token.fullKey(),
            operation: effectiveOp,
            value: numVal,
          } as FilterConditionRequest);
        }

        if (fop.token.filterType == "Guid") {
          if (!isValidGuid(value)) {
            if (overridenValue)
              return undefined;

            return ({
              token: fop.token.fullKey(),
              operation: effectiveOp,
              value: undefined,
            } as FilterConditionRequest);
          }

          return ({
            token: fop.token.fullKey(),
            operation: effectiveOp,
            value: value,
          } as FilterConditionRequest);
        }
      }

      if (Array.isArray(value)) {
        return ({
          token: fop.token.fullKey(),
          operation: effectiveOp,
          value: isList(fop.operation) ? value.notNull() : value,
        } as FilterConditionRequest);
      }

      return ({
        token: fop.token.fullKey(),
        operation: effectiveOp,
        value: value,
      } as FilterConditionRequest);
    }
  }


  function isValidGuid(str: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
  }

  export async function fetchLites<T extends Entity>(fo: FetchOptions<T>): Promise<Lite<T>[]> {

    var qt = await getQueryRoot(fo.queryName!);
    var filters = await parseFilterOptions(fo.filterOptions ?? [], false, qt);
    var orders = await parseOrderOptions(fo.orderOptions ?? [], false, qt);

    var result = await API.fetchLites({

      queryKey: getKey(qt.queryName),

      filters: toFilterRequests(filters),

      orders: orders.map(oo => ({
        token: oo.token!.fullKey(),
        orderType: oo.orderType
      }) as OrderRequest),

      count: fo.count ?? null
    });

    return result as Lite<T>[];
  }

  export async function fetchEntities<T extends Entity>(fo: FetchOptions<T>): Promise<T[]> {
    const qt = await getQueryRoot(fo.queryName!);
    const filters = await parseFilterOptions(fo.filterOptions ?? [], false, qt);
    const orders = await parseOrderOptions(fo.orderOptions ?? [], false, qt);

    const entities = await API.fetchEntities({

      queryKey: getKey(qt.queryName),

      filters: toFilterRequests(filters),

      orders: orders.map(oo => ({
        token: oo.token!.fullKey(),
        orderType: oo.orderType
      }) as OrderRequest),

      count: fo.count ?? null,
    });

    return entities as T[];
  }

  export function defaultNoColumnsAllRows(fo: FindOptions, count: number | undefined): FindOptions {

    const newFO = { ...fo };

    if (newFO.columnOptions == undefined && newFO.columnOptionsMode == undefined) {

      newFO.columnOptions = [];
      newFO.columnOptionsMode = "ReplaceAll";
    }

    if (newFO.pagination == undefined) {
      newFO.pagination = count == undefined ? { mode: "All" } : { mode: "Firsts", elementsPerPage: count };
    }


    return newFO;
  }

  export function autoRemoveTrivialColumns(fo: FindOptions): FindOptions {

    var newFO = { ...fo };

    if (newFO.columnOptions == undefined && newFO.columnOptionsMode == undefined && newFO.filterOptions) {
      var trivialColumns = getTrivialColumns(newFO.filterOptions.notNull());

      if (trivialColumns.length) {
        newFO.columnOptions = trivialColumns;
        newFO.columnOptionsMode = "Remove";
      }
    }

    return newFO;
  }

  export function getTrivialColumns(fos: FilterOption[]): ColumnOption[] {
    return fos
      .filter(fo => !isFilterGroup(fo) && (fo.operation == null || fo.operation == "EqualTo") && !fo.token.toString().contains(".") && fo.pinned == null && fo.value != null)
      .map(fo => ({ token: fo.token }) as ColumnOption);
  }
  export async function parseSingleToken(queryName: PseudoType | QueryKey, token: string | QueryTokenString<any>, subTokenOptions: SubTokensOptions): Promise<QueryToken> {

    var qt = await getQueryRoot(getQueryKey(queryName));
    const completer = new TokenCompleter(qt);
    const result = completer.request(token.toString());
    await completer.finished();
    return completer.get(token.toString(), subTokenOptions);
  }

  export async function parseTokens(queryName: PseudoType | QueryKey, tokens: (string | QueryTokenString<any>)[], subTokenOptions: SubTokensOptions): Promise<QueryToken[]> {
    var qt = await getQueryRoot(getQueryKey(queryName));
    const completer = new TokenCompleter(qt);
    tokens.forEach(token => completer.request(token.toString()));
    await completer.finished();
    return tokens.map(token => completer.get(token.toString(), subTokenOptions));
  }

  // ALTEA REWRITE of Signum's TokenCompleter. Signum resolved token STRINGS to QueryToken instances by
  // fetching them from the server (/api/query/parseTokens + subTokens) and rebuilding a flat-DTO tree.
  // altea generates tokens CLIENT-SIDE: it walks each fullKey hop-by-hop from the entity root using the
  // shared `generateSubTokens` (entities getSubTokens: local metadata ∪ server-only tokens fetched via
  // QueryClient), caching by fullKey. The public surface (requestFilter/request/finished/get/
  // getSubTokens/toFilterOptionParsed) is unchanged so the parse functions are untouched.
  export class TokenCompleter {

    private cache = new Map<string, QueryToken>();
    private requested = new Set<string>();
    private readonly root: QueryToken;

    constructor(public queryToken: QueryToken) {
      this.root = queryToken;
      queryToken.subTokens(SubTokensOptionsAll).forEach(t => this.cache.set(t.fullKey().toLowerCase(), t));
    }

    requestFilter(fo: FilterOption): void {
      if (isFilterGroup(fo)) {
        fo.token && this.request(fo.token.toString());
        fo.filters.notNull().forEach(f => this.requestFilter(f));
      } else {
        this.request(fo.token.toString());
      }
    }

    request(fullKey: string): void {
      // Token keys are matched case-insensitively: Type.token produces PascalCase strings
      // (token(a => a.orderDate) → "OrderDate") while altea's field-token keys are camelCase
      // ("orderDate"); the cache is keyed by lowercased fullKey so both resolve.
      if (fullKey != "" && !this.cache.has(fullKey.toLowerCase()))
        this.requested.add(fullKey);
    }

    finished(): Promise<void> {
      return this.resolveAll(Array.from(this.requested)).then(() => { this.requested.clear(); });
    }

    private async resolveAll(fullKeys: string[]): Promise<void> {
      for (const fullKey of fullKeys)
        await this.resolveToken(fullKey);
    }

    // Walk a fullKey hop-by-hop from the entity root, generating each level's sub-tokens client-side
    // and caching them; returns the resolved token (or undefined if the path is invalid).
    private async resolveToken(fullKey: string): Promise<QueryToken | undefined> {
      if (fullKey == "")
        return this.root;
      const existing = this.cache.get(fullKey.toLowerCase());
      if (existing != null)
        return existing;

      const parentKey = getParentTokenKey(fullKey);
      const parent = parentKey == null ? this.root : await this.resolveToken(parentKey);
      if (parent == null)
        return undefined;

      const subs = await generateSubTokens(parent, SubTokensOptionsAll);
      subs.forEach(t => this.cache.set(t.fullKey().toLowerCase(), t));
      return this.cache.get(fullKey.toLowerCase());
    }

    get(fullKey: string, options: SubTokensOptions): QueryToken {
      const token = this.cache.get(fullKey.toLowerCase());
      if (!token)
        throw new Error(`Token with key '${fullKey}' not found on query '${getKey(this.queryToken.queryName)}'`);

      const invalid = tokenNotAllowedReason(token, options);
      if (invalid != null)
        throw new Error(`Token with key '${fullKey}' on query '${getKey(this.queryToken.queryName)}' not valid (${invalid} not allowed)`);
      return token;
    }

    async getSubTokens(parentToken: QueryToken | undefined, options: SubTokensOptions, _autoExpand: boolean): Promise<QueryToken[]> {
      const candidates = parentToken == null ? this.queryToken.subTokens(SubTokensOptionsAll) : await generateSubTokens(parentToken, options);
      candidates.forEach(t => this.cache.set(t.fullKey().toLowerCase(), t));
      // TODO(port): autoExpand / hideInAutoExpand — altea QueryToken has no auto-expand flag yet.
      return candidates.filter(t => tokenNotAllowedReason(t, options) == null);
    }

    toFilterOptionParsed(fo: FilterOption, options: SubTokensOptions): FilterOptionParsed {
      if (isFilterGroup(fo)) {
        const token = fo.token ? this.get(fo.token.toString(), options) : undefined;
        return ({
          token,
          groupOperation: fo.groupOperation,
          value: fo.value,
          pinned: fo.pinned && toPinnedFilterParsed(fo.pinned),
          dashboardBehaviour: fo.dashboardBehaviour,
          filters: fo.filters.notNull().map(f => this.toFilterOptionParsed(f, options)),
          frozen: fo.frozen || false,
        } as FilterGroupOptionParsed);
      } else {
        const token = this.get(fo.token.toString(), options);
        return ({
          token,
          operation: fo.operation ?? getFilterOperations(token).orderBy(a => a == "EqualTo" ? 0 : 1).firstOrNull() ?? "EqualTo",
          value: fo.value,
          frozen: fo.frozen || false,
          removeElementWarning: fo.removeElementWarning,
          pinned: fo.pinned && toPinnedFilterParsed(fo.pinned),
          dashboardBehaviour: fo.dashboardBehaviour,
        } as FilterConditionOptionParsed);
      }
    }
  }

  // The entity-root token of a query (altea builds it locally from the query's entity type).
  function clientRootToken(queryKey: string): QueryToken {
    const ti = getTypeInfo(queryKey);
    return new RootToken(ti.ctor!);
  }

  // The parent fullKey of a token key (Signum's getParent): strip the trailing indexer or "."-segment.
  function getParentTokenKey(fullKey: string): string | null {
    if (fullKey.endsWith("]"))
      return fullKey.beforeLast("[").beforeLast(".");
    return fullKey.tryBeforeLast(".") ?? null;
  }

  // Which sub-token family (if any) is disallowed by `options` — the reason, or null when allowed.
  function tokenNotAllowedReason(t: QueryToken, options: SubTokensOptions): string | null {
    if ((options & SubTokensOptions.CanAggregate) == 0 && t.hasAggregate()) return "aggregates";
    if ((options & SubTokensOptions.CanAnyAll) == 0 && t.hasAnyOrAll()) return "Any/All";
    if ((options & SubTokensOptions.CanElement) == 0 && t.hasElement()) return "Element";
    if ((options & SubTokensOptions.CanOperation) == 0 && t.hasOperation()) return "Operation";
    if ((options & SubTokensOptions.CanToArray) == 0 && t.hasToArray()) return "ToArray";
    if ((options & SubTokensOptions.CanSnippet) == 0 && t.hasSnippet()) return "Snippet";
    if ((options & SubTokensOptions.CanManual) == 0 && t.hasManual()) return "Manual";
    if ((options & SubTokensOptions.CanNested) == 0 && t.hasNested()) return "Nested";
    if ((options & SubTokensOptions.CanTimeSeries) == 0 && t.hasTimeSeries()) return "TimeSeries";
    return null;
  }

  // TODO(port): filter-value coercion (luxon date normalization, Lite-model fill via
  // Navigator.API.fillLiteModelsArray, convertToLite) is deferred — luxon is dropped in altea and
  // those Navigator APIs aren't ported. Values pass through as-is for now; wire to altea Date/Temporal
  // parsing + lite-model fetching later. (Signum's parseValue / nanToNull / convertToLite removed here.)
  export function parseFilterValues(filterOptions: FilterOptionParsed[]): Promise<void> {
    return Promise.resolve();
  }
  // ALTEA REWRITE: Signum fetched the QueryDescription (its column token tree) from the server DTO.
  // altea builds the query's ROOT token CLIENT-SIDE: the entity-root token carries the query
  // name/type and its direct sub-tokens ARE the query's columns (generated locally by the shared
  // token model; server-only tokens fetched via QueryClient). Kept async so awaiting callers are
  // unchanged even though clientRootToken is cheap and synchronous.
  export function getQueryRoot(queryName: PseudoType | QueryKey): Promise<QueryToken> {
    return Promise.resolve(clientRootToken(getQueryKey(queryName)));
  }

  export function inDB<R>(entity: Entity | Lite<Entity>, token: QueryTokenString<R> | string): Promise<AddToLite<R> | null> {

    var fo: FindOptions = {
      queryName: getTypeName(entity),
      filterOptions: [{ token: "Entity", value: entity }],
      pagination: { mode: "Firsts", elementsPerPage: 1 },
      columnOptions: [{ token: token }],
      columnOptionsMode: "ReplaceAll",
    };

    return getQueryRoot(fo.queryName)
      .then(qt => parseFindOptions(fo!, qt, false))
      .then(fop => API.executeQuery(getQueryRequest(fop)))
      .then(rt => {
        if (rt.rows.length != 1)
          throw new Error(`inDB: expected exactly 1 row for ${(entity instanceof Lite ? entity : entity.toLite()).key()} but got ${rt.rows.length}`);
        return rt.rows[0].columns[0];
      });
  }

  export function inDBMany<TO extends { [name: string]: QueryTokenString<any> | string }>(entity: Entity | Lite<Entity>, tokensObject: TO): Promise<ExtractTokensObject<TO>> {

    var fo: FindOptions = {
      queryName: getTypeName(entity),
      filterOptions: [{ token: "Entity", value: entity }],
      pagination: { mode: "Firsts", elementsPerPage: 1 },
      columnOptions: Dic.getValues(tokensObject).map(a => ({ token: a })),
      columnOptionsMode: "ReplaceAll",
    };

    return getQueryRoot(fo.queryName)
      .then(qt => parseFindOptions(fo!, qt, false))
      .then(fop => API.executeQuery(getQueryRequest(fop)))
      .then(rt => {
        if (rt.rows.length != 1)
          throw new Error(`inDBMany: expected exactly 1 row for ${(entity instanceof Lite ? entity : entity.toLite()).key()} but got ${rt.rows.length}`);
        return Dic.mapObject(tokensObject, (key, value, index) => rt.rows[0].columns[index]) as ExtractTokensObject<TO>;
      });
  }

  export function inDBList<R>(entity: Entity | Lite<Entity>, token: QueryTokenString<R> | string): Promise<AddToLite<R>[]> {

    var fo: FindOptions = {
      queryName: getTypeName(entity),
      filterOptions: [{ token: "Entity", value: entity }],
      pagination: { mode: "All" },
      columnOptions: [{ token: token }],
      columnOptionsMode: "ReplaceAll",
    };

    return getQueryRoot(fo.queryName)
      .then(qt => parseFindOptions(fo!, qt, false))
      .then(fop => API.executeQuery(getQueryRequest(fop)))
      .then(rt => rt.rows.map(r => r.columns[0]).notNull());
  }

  export type AddToLite<T> = T extends Entity ? Lite<T> : T;
  export type ExtractQueryToken<T> =
    T extends QueryTokenString<infer S> ? AddToLite<S> :
    T extends TokenObject ? ExtractTokensObject<T>[] :
    T extends undefined ? undefined :
    any;

  export type ExtractTokensObject<T> = {
    [P in keyof T]: ExtractQueryToken<T[P]>;
  };

  export function useQuery(fo: FindOptions, additionalDeps?: any[], options?: APIHookOptions): ResultTable | undefined;
  export function useQuery(fo: FindOptions | null, additionalDeps?: any[], options?: APIHookOptions): ResultTable | undefined | null;
  export function useQuery(fo: FindOptions | null, additionalDeps?: any[], options?: APIHookOptions): ResultTable | undefined | null {
    return useAPI(
      signal => fo == null ? null : getResultTable(fo, signal),
      [fo && findOptionsPath(fo), ...(additionalDeps || [])],
      options);

  }

  export function useFetchLites<T extends Entity>(fo: FetchOptions<T>, additionalDeps?: React.DependencyList, options?: APIHookOptions): Lite<T>[] | undefined;
  export function useFetchLites<T extends Entity>(fo: FetchOptions<T> | null, additionalDeps?: React.DependencyList, options?: APIHookOptions): Lite<T>[] | null | undefined;
  export function useFetchLites<T extends Entity>(fo: FetchOptions<T> | null, additionalDeps?: React.DependencyList, options?: APIHookOptions): Lite<T>[] | null | undefined {
    return useAPI(() => fo && fetchLites(fo),
      [
        fo && findOptionsPath({
          queryName: fo.queryName!,
          filterOptions: fo.filterOptions,
          orderOptions: fo.orderOptions,
          pagination: fo.count == null ? { mode: "All" } : { mode: "Firsts", elementsPerPage: fo.count }
        }),
        ...additionalDeps ?? []
      ],
      options,
    );
  }

  export function useFetchEntities<T extends Entity>(fo: FetchOptions<T>, additionalDeps?: React.DependencyList, options?: APIHookOptions): T[] | undefined;
  export function useFetchEntities<T extends Entity>(fo: FetchOptions<T> | null, additionalDeps?: React.DependencyList, options?: APIHookOptions): T[] | null | undefined;
  export function useFetchEntities<T extends Entity>(fo: FetchOptions<T> | null, additionalDeps?: React.DependencyList, options?: APIHookOptions): T[] | null | undefined {
    return useAPI(() => fo && fetchEntities(fo),
      [
        fo && findOptionsPath({
          queryName: fo.queryName!,
          filterOptions: fo.filterOptions,
          orderOptions: fo.orderOptions,
          pagination: fo.count == null ? { mode: "All" } : { mode: "Firsts", elementsPerPage: fo.count }
        }),
        ...additionalDeps ?? []
      ],
      options,
    );
  }


  function typedResultsFindOptions(options: TypedResultsOptions<any>): FindOptions {
    const { resultObject, ...fo } = options;
    return {
      pagination: { mode: "All" },
      ...(fo as FindOptions),
      columnOptions: getAllColumns(resultObject),
      columnOptionsMode: "ReplaceAll",
    };
  }

  export function useTypedResults<RO extends ResultObject>(options: TypedResultsOptions<RO>, additionalDeps?: React.DependencyList, apiOptions?: APIHookOptions): ExtractTokensObject<RO>[] | undefined;
  export function useTypedResults<RO extends ResultObject>(options: TypedResultsOptions<RO> | null, additionalDeps?: React.DependencyList, apiOptions?: APIHookOptions): ExtractTokensObject<RO>[] | null | undefined;
  export function useTypedResults<RO extends ResultObject>(options: TypedResultsOptions<RO> | null, additionalDeps?: React.DependencyList, apiOptions?: APIHookOptions): ExtractTokensObject<RO>[] | null | undefined {
    return useAPI(async signal => {
      if (!options)
        return null;

      var rt = await getResultTable(typedResultsFindOptions(options), signal);

      return rt.rows.map(row => toTypedRow(options.resultObject, rt.columns, row));
    }, [options && findOptionsPath(typedResultsFindOptions(options)), ...(additionalDeps || [])], apiOptions);
  }

  function getAllColumns(tokensObject: TokenObject): ColumnOption[] {
    return Dic.getValues(tokensObject).flatMap(a => {
      if (a == undefined)
        return [];

      if (typeof a == "string" || a instanceof QueryTokenString)
        return [{ token: a }];

      return getAllColumns(a);
    });
  }

  export interface TokenObject {
    [name: string]: QueryTokenString<any> | string | TokenObject | undefined;
  }

  export function toTypedRow<TO extends TokenObject>(tokensObject: TO, columns: string[], row: ResultRow): ExtractTokensObject<TO> {
    return Dic.mapObject(tokensObject, (key, value) => {

      if (value == undefined)
        return undefined;

      var token = value.toString();

      if (token == "Entity" && row.entity)
        return row.entity;

      const index = columns.indexOf(token);

      return row.columns[index];
    }) as ExtractTokensObject<TO>;
  }

  export async function getTypedResults<RO extends ResultObject>(options: TypedResultsOptions<RO>, signal?: AbortSignal): Promise<ExtractTokensObject<RO>[]> {
    const rt = await getResultTable(typedResultsFindOptions(options), signal);

    return rt.rows.map(row => toTypedRow(options.resultObject, rt.columns, row));
  }

  export async function getTypedResultsWithPagination<RO extends ResultObject>(options: TypedResultsOptions<RO>, signal?: AbortSignal): Promise<{ totalElements?: number, rows: ExtractTokensObject<RO>[] }> {

    const rt = await getResultTable(typedResultsFindOptions(options));

    return ({
      totalElements: rt.totalElements,
      rows: rt.rows.map(row => toTypedRow(options.resultObject, rt.columns, row))
    });
  }

  export function getResultTable(fo: FindOptions, signal?: AbortSignal, defaultIncludeDefaultFilters: boolean = true): Promise<ResultTable> {

    fo = defaultNoColumnsAllRows(fo, undefined);

    return getQueryRoot(fo.queryName)
      .then(qt => parseFindOptions(fo!, qt, defaultIncludeDefaultFilters))
      .then(fop => API.executeQuery(getQueryRequest(fop), signal));
  }

  export function useInDB<R>(entity: Entity | Lite<Entity> | null, token: QueryTokenString<R> | string, additionalDeps?: any[], options?: APIHookOptions): AddToLite<R> | null | undefined {
    var resultTable = useQuery(entity == null || entity instanceof Entity && entity.isNew ? null : {
      queryName: getTypeName(entity),
      filterOptions: [{ token: "Entity", value: entity }],
      pagination: { mode: "Firsts", elementsPerPage: 1 },
      columnOptions: [{ token: token }],
      columnOptionsMode: "ReplaceAll",
    }, additionalDeps, options);

    if (entity == null)
      return null;

    if (resultTable == null)
      return undefined;

    return resultTable.rows[0]?.columns[0] ?? null;
  }



  export function useInDBMany<TO extends { [name: string]: QueryTokenString<any> | string }>(entity: Entity | Lite<Entity>, tokensObject: TO, additionalDeps?: any[], options?: APIHookOptions): ExtractTokensObject<TO> | undefined;
  export function useInDBMany<TO extends { [name: string]: QueryTokenString<any> | string }>(entity: Entity | Lite<Entity> | null, tokensObject: TO, additionalDeps?: any[], options?: APIHookOptions): ExtractTokensObject<TO> | null | undefined;
  export function useInDBMany<TO extends { [name: string]: QueryTokenString<any> | string }>(entity: Entity | Lite<Entity> | null, tokensObject: TO, additionalDeps?: any[], options?: APIHookOptions): ExtractTokensObject<TO> | null | undefined {
    var resultTable = useQuery(entity == null || entity instanceof Entity && entity.isNew ? null : {
      queryName: getTypeName(entity),
      filterOptions: [{ token: "Entity", value: entity }],
      pagination: { mode: "Firsts", elementsPerPage: 1 },
      columnOptions: Dic.getValues(tokensObject).map(a => ({ token: a })),
      columnOptionsMode: "ReplaceAll",
    }, additionalDeps, options);

    return React.useMemo(() => {

      if (entity == null)
        return null;

      if (resultTable == null)
        return undefined;

      var firstRow = resultTable.rows[0];

      return firstRow && Dic.mapObject(tokensObject, (key, value, index) => firstRow.columns[index]) as ExtractTokensObject<TO>;
    }, [entity, resultTable]);
  }


  export function useInDBList<R>(entity: Entity | Lite<Entity> | null, token: QueryTokenString<R> | string, additionalDeps?: any[], options?: APIHookOptions): AddToLite<R>[] | null | undefined {
    var resultTable = useQuery(entity == null || entity instanceof Entity && entity.isNew ? null : {
      queryName: getTypeName(entity),
      filterOptions: [{ token: "Entity", value: entity }],
      pagination: { mode: "All" },
      columnOptions: [{ token: token }],
      columnOptionsMode: "ReplaceAll",
    }, additionalDeps, options);

    return React.useMemo(() => {

      if (entity == null)
        return null;

      if (resultTable == null)
        return undefined;

      return resultTable.rows.map(r => r.columns[0]).notNull();

    }, [entity, resultTable]);
  }

  export function useFetchAllLite<T extends Entity>(type: Type<T>, deps?: any[]): Lite<T>[] | undefined {
    return useAPI(() => API.fetchAllLites({ types: getTypeName(type) }), deps ?? []) as Lite<T>[] | undefined;
  }

  export function decompress(rt: ResultTable): ResultTable {
    var rows = rt.rows;
    var columns = rt.columns;

    for (var i = 0; i < columns.length; i++) {
      var uniqueValues = rt.uniqueValues[columns[i]];

      if (uniqueValues != null) {
        for (var j = 0; j < rows.length; j++) {
          var row = rows[j];
          var index = row.columns[i] as number | null;
          if (index != null)
            row.columns[i] = uniqueValues[index];
        }
      }
    }
    return rt;
  }

  export namespace API {

    // TODO(port): altea builds the query root token CLIENT-SIDE (see getQueryRoot), so this
    // server DTO fetch is likely obsolete; typed as unknown for now.
    export function fetchQueryDescription(queryKey: string): Promise<unknown> {
      return ajaxGet({ url: "/api/query/description/" + queryKey });
    }

    // TODO(port): QueryEntity (the query-registration entity) is not ported yet.
    // export function fetchQueryEntity(queryKey: string): Promise<QueryEntity> {
    //   return ajaxGet({ url: "/api/query/queryEntity/" + queryKey });
    // }


    // TODO(port): the time-series split executor needs luxon DateTime (dropped in altea — use
    // Temporal), Notify/NotifyOptions/JavascriptMessage (notification UI not ported) and
    // "AsOf" slicing. Restore from the Signum source once those land.
    export async function executeQuerySplitTimeSeries(request: QueryRequest, signal?: AbortSignal): Promise<ResultTable> {
      throw new Error("TODO(port): executeQuerySplitTimeSeries — luxon DateTime + Notify not ported");
    }


    export function executeQuery(request: QueryRequest, signal?: AbortSignal): Promise<ResultTable> {
      if (request.systemTime?.mode == "TimeSeries" && request.systemTime.splitQueries) {
        return executeQuerySplitTimeSeries(request, signal);
      }

      return ajaxPost<ResultTable>({ url: "/api/query/executeQuery/" + request.queryKey, signal }, request)
        .then(rt => decompress(rt));
    }

    export function queryValue(request: QueryValueRequest, avoidNotifyPendingRequest: boolean | undefined = undefined, signal?: AbortSignal): Promise<any> {
      return ajaxPost({ url: "/api/query/queryValue/" + request.queryKey, avoidNotifyPendingRequests: avoidNotifyPendingRequest, signal }, request);
    }

    export function fetchLites(request: QueryEntitiesRequest): Promise<Lite<Entity>[]> {
      return ajaxPost({ url: "/api/query/lites/" + request.queryKey }, request);
    }

    export function fetchEntities(request: QueryEntitiesRequest): Promise<Entity[]> {
      return ajaxPost({ url: "/api/query/entities/" + request.queryKey }, request);
    }

    export function fetchAllLites(request: { types: string }): Promise<Lite<Entity>[]> {
      return ajaxGet({
        url: "/api/query/allLites?" + QueryString.stringify(request)
      });
    }

    export function findTypeLike(request: { subString: string, count: number }): Promise<Lite<TypeEntity>[]> {
      return ajaxGet({
        url: "/api/query/findTypeLike?" + QueryString.stringify(request)
      });
    }

    export function findLiteLike(request: AutocompleteRequest, signal?: AbortSignal): Promise<Lite<Entity>[]> {
      return ajaxGet({ url: "/api/query/findLiteLike?" + QueryString.stringify({ ...request }), signal });
    }


    export interface AutocompleteRequest {
      types: string;
      subString: string;
      count: number;
    }
  }



  function shouldIgnoreValues(pinned?: PinnedFilter | null) {
    return pinned != null && (pinned.active == "Always" || pinned.active == "WhenHasValue");
  }

  export namespace Encoder {



    export function encodeFilters(query: any, filterOptions?: FilterOption[], prefix?: string): void {

      var i: number = 0;

      function encodeFilter(fo: FilterOption, identation: number, ignoreValues: boolean) {
        var identSuffix = identation == 0 ? "" : ("_" + identation);

        var index = i++;

        if (fo.pinned) {
          var p = fo.pinned;
          query[(prefix ?? "") + "filterPinned" + index + identSuffix] = scapeTilde(typeof p.label == "function" ? p.label() : p.label ?? "") +
            "~" + (p.column == null ? "" : p.column) + (p.colSpan == null ? "" : ("." + p.colSpan)) +
            "~" + (p.row == null ? "" : p.row) +
            "~" + PinnedFilterActiveEnum[p.active ?? "Always"] + // altea: numeric enum gives the ordinal (Signum's .values().indexOf)
            "~" + (p.splitValue ? 1 : 0);
        }


        if (isFilterGroup(fo)) {
          query[(prefix ?? "") + "filter" + index + identSuffix] = (fo.token ?? "") + "~" + (fo.groupOperation) + "~" + (ignoreValues ? "" : stringValue(fo.value));

          fo.filters.notNull().forEach(f => encodeFilter(f, identation + 1, ignoreValues || shouldIgnoreValues(fo.pinned)));
        } else {
          query[(prefix ?? "") + "filter" + index + identSuffix] = fo.token + "~" + (fo.operation ?? "EqualTo") + "~" + (ignoreValues ? "" : stringValue(fo.value));
        }

      }

      if (filterOptions)
        filterOptions.forEach(fo => encodeFilter(fo, 0, false));
    }

    export function encodeOrders(query: any, orderOptions?: OrderOption[], prefix?: string): void {
      if (orderOptions)
        orderOptions.forEach((oo, i) => query[(prefix ?? "") + "order" + i] = (oo.orderType == "Descending" ? "-" : "") + oo.token);
    }

    export function encodeColumns(query: any, columnOptions?: ColumnOption[], prefix?: string): void {
      if (columnOptions) {
        columnOptions.forEach((co, i) => {

          var displayName = co.hiddenColumn ? HIDDEN :
            co.displayName ? scapeTilde(typeof co.displayName == "function" ? co.displayName() : co.displayName) :
              undefined;

          query[(prefix ?? "") + "column" + i] = co.token + (displayName ? ("~" + displayName) : "");
          if (co.summaryToken)
            query[(prefix ?? "") + "summary" + i] = co.summaryToken.toString();
          if (co.combineRows)
            query[(prefix ?? "") + "combine" + i] = co.combineRows == "EqualValue" ? "V" : "E";
        });
      }
    }

    export const encodeModel: { [typeName: string]: (model: any) => string } = {};

    export function stringValue(value: any): string {

      if (value == undefined)
        return "";

      if (Array.isArray(value))
        return value.notNull().map(a => stringValue(a)).join("~");

      if (value instanceof Entity)
        value = value.toLite(value.isNew);

      if (value instanceof Lite)
        return value.key();

      if (value instanceof ModelEntity) {
        return encodeModel[getTypeName(value)](value);
      }

      return scapeTilde(value.toString());
    }

    export function scapeTilde(str: string): string {
      if (str == undefined)
        return "";

      return str.replace("~", "#|#");
    }
  }




  const HIDDEN = "__";

  export namespace Decoder {

    export const decodeModel: { [typeName: string]: (string: any) => ModelEntity | null } = {};


    interface FilterPart {
      order: number;
      identation: number;
      value: string;
    };

    export function filterInOrder(query: any, prefix: string): FilterPart[] {
      const regex = new RegExp("^" + prefix + "(\\d*)(_(\\d*))?$");

      return Dic.getKeys(query)
        .map(s => regex.exec(s))
        .filter(r => !!r)
        .map(m => ({ order: parseInt(m![1]), identation: parseInt(m![3] ?? "0"), value: query[m![0]] }))
        .orderBy(a => a.order);
    }

    export function decodeFilters(query: any, prefix?: string): FilterOption[] {

      function parsePinnedFilter(str: string): PinnedFilter {
        var parts = str.split("~");
        var col = parts[1];
        return ({
          label: unscapeTildes(parts[0]),
          column: col.length ? (col.contains(".") ? parseInt(col.before(".")) : parseInt(col)) : undefined,
          colSpan: col.length && col.contains(".") ? parseInt(col.after(".")) : undefined,
          row: parts[2].length ? parseInt(parts[2]) : undefined,
          active: parseInt(parts[3]) == 0 ? undefined : PinnedFilterActiveEnum[parseInt(parts[3])] as PinnedFilterActive,
          splitValue: parseInt(parts[4]) == 0 ? undefined : Boolean(parseInt(parts[4])),
        });
      }


      function toFilterList(filters: FilterPart[], identation: number, ignoreValues: boolean): FilterOption[] {

        return filters.groupWhen(a => a.identation == identation).map(gr => {

          var identSuffix = identation == 0 ? "" : ("_" + identation);

          var pinnedText = query[(prefix ?? "") + "filterPinned" + gr.key.order + identSuffix] as string;

          var pinned = pinnedText == undefined ? null : parsePinnedFilter(pinnedText);

          const parts = gr.key.value.split("~");

          if (parts[1] in FilterOperationEnum) {
            var operation = parts[1] as FilterOperation;
            return ({
              token: parts[0],
              operation: operation,
              value: ignoreValues ? null :
                isPair(operation) ? parts.slice(2).map(a => unscapeTildes(a) ?? null) :
                  isList(operation) ? parts.slice(2).map(a => unscapeTildes(a)).notNull() :
                    unscapeTildes(parts[2]),
              pinned: pinned,
            }) as FilterConditionOption
          } else {
            const filters = toFilterList(gr.elements, identation + 1, ignoreValues || shouldIgnoreValues(pinned));
            return ({
              token: parts[0] == null || parts[0].length == 0 ? null : parts[0],
              groupOperation: parts[1] as FilterGroupOperation,
              value: ignoreValues ? null :
                isGroupList({ filters }) ? parts.slice(2).map(a => unscapeTildes(a)).notNull() :
                  unscapeTildes(parts[2]),
              pinned: pinned,
              filters,
            }) as FilterGroupOption;
          }
        });
      }

      return toFilterList(filterInOrder(query, (prefix ?? "") + "filter"), 0, false)
    }

    export function unscapeTildes(str: string | undefined): string | undefined {
      if (!str)
        return undefined;

      return str.replace("#|#", "~");
    }

    export function valuesInOrder(query: any, prefix: string): { index: number, value: string }[] {
      const regex = new RegExp("^" + prefix + "(\\d*)$");

      return Dic.getKeys(query).map(s => regex.exec(s))
        .filter(r => !!r)
        .map(r => ({ index: parseInt(r![1]), value: query[r![0]] }))
        .orderBy(a => a.index);
    }

    export function decodeOrders(query: any, prefix?: string): OrderOption[] {
      return valuesInOrder(query, (prefix ?? "") + "order").map(p => ({
        orderType: p.value[0] == "-" ? "Descending" : "Ascending",
        token: p.value[0] == "-" ? p.value.tryAfter("-") : p.value
      } as OrderOption));
    }


    export function decodeColumns(query: any, prefix?: string): ColumnOption[] {
      var summary = valuesInOrder(query, (prefix ?? "") + "summary");
      var combine = valuesInOrder(query, (prefix ?? "") + "combine");

      return valuesInOrder(query, (prefix ?? "") + "column").map(p => {

        var displayName = unscapeTildes(p.value.tryAfter("~"));

        var token = p.value.tryBefore("~") ?? p.value;
        var comb = combine.firstOrNull(a => a.index == p.index)?.value;
        return softCast<ColumnOption>({
          token: token,
          displayName: displayName == HIDDEN ? undefined : displayName,
          hiddenColumn: displayName == HIDDEN ? true : undefined,
          summaryToken: summary.firstOrNull(a => a.index == p.index)?.value,
          combineRows: comb == "V" ? "EqualValue" : comb == "E" ? "EqualEntity" : undefined,
        });
      });
    }
  }


  export namespace ButtonBarQuery {

    interface ButtonBarQueryContext {
      searchControl: SearchControlLoaded;
      findOptions: FindOptionsParsed;
    }

    export const onButtonBarElements: ((ctx: ButtonBarQueryContext) => ButtonBarElement | undefined)[] = [];

    export function getButtonBarElements(ctx: ButtonBarQueryContext): ButtonBarElement[] {
      return onButtonBarElements.map(f => f(ctx)).filter(a => a != undefined).map(a => a as ButtonBarElement);
    }

    export function clearButtonBarElements(): void {
      ButtonBarQuery.onButtonBarElements.clear();
    }

  }



  export interface QuerySettings {
    queryName: PseudoType | QueryKey;
    // The columns shown by default (Signum's [query columns]); build with Type.querySettings(token =>
    // ({ defaultColumns: [token(a => a.name), ...] })). When unset, the first 5 non-collection columns
    // are used. Entries are token keys / QueryTokenStrings, resolved case-insensitively.
    defaultColumns?: (string | QueryTokenString<any>)[];
    pagination?: Pagination;
    allowSystemTime?: boolean;
    defaultOrders?: OrderOption[];
    defaultOrdersAutocomplete?: OrderOption[];
    defaultFilters?: FilterOption[];
    defaultAggregates?: ColumnOption[];
    hiddenColumns?: ColumnOption[];
    formatters?: { [token: string]: CellFormatter };
    rowAttributes?: (row: ResultRow, searchControl: SearchControlLoaded) => React.HTMLAttributes<HTMLTableRowElement> | undefined;
    entityFormatter?: EntityFormatter;
    inPlaceNavigation?: boolean;
    modalSize?: BsSize;
    showContextMenu?: (fop: FindOptionsParsed) => boolean | "Basic";
    allowCreate?: boolean;
    allowSelection?: boolean;
    getViewPromise?: (e: ModifiableEntity | null) => (undefined | string | ViewPromise<ModifiableEntity>);
    onDoubleClick?: (e: React.MouseEvent<any>, row: ResultRow, columns: string[], sc?: SearchControlLoaded) => void;
    simpleFilterBuilder?: (sfbc: SimpleFilterBuilderContext) => React.ReactElement | undefined;
    onFind?: (fo: FindOptions, mo?: ModalFindOptions) => Promise<Lite<Entity> | undefined>;
    onFindMany?: (fo: FindOptions, mo?: ModalFindOptions) => Promise<Lite<Entity>[] | undefined>;
    onExplore?: (fo: FindOptions, mo?: ModalFindOptions) => Promise<void>;
    extraButtons?: (searchControl: SearchControlLoaded) => (ButtonBarElement | null | undefined | false)[];
    noResultMessage?: (searchControl: SearchControlLoaded) => React.ReactElement | string | undefined;
    customGetPropsFromFilter?: (filters: FilterOptionParsed[]) => Promise<any>;
    mobileOptions?: (fop: FindOptionsParsed) => SearchControlMobileOptions;
    markRowsColumn?: string;
  }


  export interface SimpleFilterBuilderContext {
    queryToken: QueryToken;
    initialFilterOptions: FilterOptionParsed[];
    search: () => void;
    searchControl?: SearchControlLoaded
  }



  // Default result-cell / entity formatters (copy-and-fixed from Signum's FinderRules). Detection uses
  // altea's typed query-token API: `column.filterType` (Integer/Decimal/Enum/Boolean/DateTime/Time/Lite/…)
  // plus `column.type` (`.array`, `.typeName`, `.getEnum()`). getCellFormatter/getEntityFormatter take the
  // LAST applicable rule, so rules run general → specific: the "Default" catch-all is first, and the
  // "Collection" rule is last so an array column beats the by-element Number/Enum/Lite rules.
  //
  // Wire value shapes (the client JSON.parses the ResultTable — no typed decode, see Services.ajaxPost):
  //   numbers  → JS number      booleans → boolean      strings → string
  //   enums    → the ORDINAL integer (e.g. OrderState "Shipped" → 3)
  //   DateOnly/DateTime/Time → ISO string (PlainDate/PlainDateTime/PlainTime/Duration serialized as text)
  //   Lite/entity ref → { $lite: cleanTypeName, id, toStr }   collections → array of the above
  const FinderRules = {
    initFormatRules: (): FormatRule[] => [
      // Catch-all: any value as text (objects with a `toStr`, e.g. a lite, via that). Loses to every
      // more specific rule below because it is first and the last applicable rule wins.
      {
        name: "Default",
        isApplicable: () => true,
        formatter: () => new CellFormatter(cell => cellToStr(cell), false),
      },
      // Number (Integer/Decimal): right-aligned, `column.format`/`column.unit` applied via Intl. Falls
      // back to String(cell) if the format throws.
      {
        name: "Number",
        isApplicable: qt => qt.filterType == "Integer" || qt.filterType == "Decimal",
        formatter: (qt, sc, opts) => {
          const numberFormat = toNumberFormat(opts?.format ?? qt.format);
          const unit = opts?.unit !== undefined && opts.unit !== null ? opts.unit : qt.unit;
          return new CellFormatter((cell: any) => {
            if (cell == null)
              return "";
            let str: string;
            try { str = numberFormat.format(cell); }
            catch { str = String(cell); }
            if (unit)
              str = str + " " + unit;
            return <span className="try-no-wrap">{str}</span>;
          }, false, "numeric-cell");
        },
      },
      // Enum: the cell is the ORDINAL integer — Enum.niceName maps ordinal → member name → localized nice
      // name (falling back to a humanized member name). Fixes the "state shows 3" bug.
      {
        name: "Enum",
        isApplicable: qt => qt.filterType == "Enum",
        formatter: qt => {
          const en = qt.type.getEnum();
          return new CellFormatter((cell: any) => {
            if (cell == null)
              return "";
            if (en == null)
              return String(cell);
            try { return <span className="try-no-wrap">{Enum.niceName(en as Record<string, string | number>, cell)}</span>; }
            catch { return String(cell); }
          }, false);
        },
      },
      // Boolean: a centered, disabled checkbox reflecting the value.
      {
        name: "Boolean",
        isApplicable: qt => qt.filterType == "Boolean",
        formatter: () => new CellFormatter((cell: any) => cell == null ? "" : <input type="checkbox" className="form-check-input" disabled={true} readOnly checked={Boolean(cell)} />, false, "centered-cell"),
      },
      // DateOnly / DateTime / Time: parse the ISO string with the matching Temporal type (keyed by
      // `column.type.typeName`) and render its localized form; on a parse error fall back to the raw string.
      {
        name: "DateTime",
        isApplicable: qt => qt.filterType == "DateTime" || qt.filterType == "Time",
        formatter: qt => {
          const tn = qt.type.typeName;
          return new CellFormatter((cell: any) => {
            if (cell == null || cell === "")
              return "";
            const s = String(cell);
            try {
              if (tn == "PlainDate")
                return <bdi className="date try-no-wrap">{Temporal.PlainDate.from(s).toLocaleString()}</bdi>;
              if (tn == "PlainDateTime")
                return <bdi className="date try-no-wrap">{Temporal.PlainDateTime.from(s).toLocaleString()}</bdi>;
              if (tn == "PlainTime")
                return <bdi className="date try-no-wrap">{Temporal.PlainTime.from(s).toLocaleString()}</bdi>;
              if (tn == "Duration")
                return <bdi className="date try-no-wrap">{Temporal.Duration.from(s).toString()}</bdi>;
            }
            catch { return s; }
            return s;
          }, false, "date-cell");
        },
      },
      // Lite / entity reference: a react-router Link to the entity view route, built directly from the
      // lite (no Navigator import → no Finder↔Navigator cycle). Link text is the lite's toStr; null → "".
      {
        name: "Lite",
        isApplicable: qt => qt.filterType == "Lite",
        formatter: () => new CellFormatter((cell: any) => {
          if (cell == null)
            return "";
          const path = liteViewPath(cell);
          const text = cellToStr(cell);
          return path == null ? <span className="try-no-wrap">{text}</span> : <Link to={path} className="try-no-wrap">{text}</Link>;
        }, true),
      },
      // Collection/array: join the elements' toStr (never "[object Object]"). Last rule, so an array of
      // numbers/enums/lites lands here rather than in the by-element rules above.
      {
        name: "Collection",
        isApplicable: qt => qt.type.array === true,
        formatter: () => new CellFormatter((cell: any) => {
          if (cell == null)
            return "";
          if (!Array.isArray(cell))
            return cellToStr(cell);
          return cell.map(x => cellToStr(x)).join(", ");
        }, false),
      },
    ],
    initEntityFormatRules: (): EntityFormatRule[] => [
      // Default row-entity rendering: a view Link (same as the Lite cell rule) for `ctx.row.entity`.
      {
        name: "View",
        isApplicable: () => true,
        formatter: new EntityFormatter(ctx => {
          const lite = ctx.row.entity as any;
          if (lite == null)
            return "";
          const path = liteViewPath(lite);
          const text = cellToStr(lite);
          return path == null ? <span className="try-no-wrap">{text}</span> : <Link to={path} className="try-no-wrap">{text}</Link>;
        }, "centered-cell"),
      },
    ],
    initQuickFilterRules: (): QuickFilterRule[] => [],
    initFilterValueFormatRules: (): FilterValueFormatter[] => [],
  };

  // Render any result-cell value as text: a Lite/entity/Temporal/Decimal shows its toString() (a wire
  // lite via its `toStr`), a plain value via String().
  function cellToStr(cell: any): string {
    if (cell == null) return "";
    if (typeof cell === "object") return (cell.toStr as string | undefined) ?? (typeof cell.toString === "function" ? cell.toString() : "");
    return String(cell);
  }

  // The entity view-route path for a wire lite — "/view/<cleanType.firstLower>/<id>", matching
  // Navigator.navigateRouteDefault, but built inline so Finder doesn't import Navigator (avoids the
  // Finder↔Navigator cycle). Reads the clean type name from `$lite` (already stripped of "Entity" by the
  // wire serializer); also tolerates an EntityType/entityType field (raw string or a Type object) and
  // strips a trailing "Entity". Returns undefined when the type name or id is missing.
  function liteViewPath(lite: any): string | undefined {
    if (lite == null) return undefined;
    const raw = lite.$lite ?? lite.EntityType ?? lite.entityType;
    const typeName: string | undefined = typeof raw === "string" ? raw : raw?.name;
    if (typeName == null || lite.id == null) return undefined;
    const clean = typeName.endsWith("Entity") ? typeName.substring(0, typeName.length - "Entity".length) : typeName;
    const lower = clean.charAt(0).toLowerCase() + clean.slice(1);
    return "/view/" + lower + "/" + lite.id;
  }

  export function isSystemVersioned(rt?: TypeReference): boolean {
    return rt != null && rt.typeInfos().some(ti => ti.systemVersioned != null)
  }

  interface GetFormatterOptions {
    unit?: string | null;
    format?: string;
  }

  export function getCellFormatter(qs: QuerySettings | undefined, qt: QueryToken, sc: SearchControlLoaded | undefined, options?: GetFormatterOptions): CellFormatter {

    const result = qs?.formatters && qs.formatters[qt.fullKey()];

    if (result)
      return result;

    const prRoute = registeredPropertyFormatters[qt.getPropertyRoute()?.toString() ?? ""];
    if (prRoute)
      return prRoute;

    const rule = formatRules.filter(a => a.isApplicable(qt, sc, options)).last("FormatRules");

    return rule.formatter(qt, sc, options);
  }

  export function resetFormatRules(): void {
    Dic.clear(registeredPropertyFormatters);

    formatRules.clear();
    formatRules.push(...FinderRules.initFormatRules());

    entityFormatRules.clear();
    entityFormatRules.push(...FinderRules.initEntityFormatRules());

    quickFilterRules.clear();
    quickFilterRules.push(...FinderRules.initQuickFilterRules());

    filterValueFormatRules.clear();
    filterValueFormatRules.push(...FinderRules.initFilterValueFormatRules());
  }

  export interface FormatRule {
    name: string;
    formatter: (column: QueryToken, sc: SearchControlLoaded | undefined, opts: GetFormatterOptions | undefined) => CellFormatter;
    isApplicable: (column: QueryToken, sc: SearchControlLoaded | undefined, opts: GetFormatterOptions | undefined) => boolean;
  }

  export class CellFormatter {
    constructor(
      public formatter: (cell: any, ctx: CellFormatterContext, column: ColumnParsed) => React.ReactElement | string | null | undefined,
      public fillWidth: boolean,
      public cellClass?: string) {
    }
  }

  export interface CellFormatterContext {
    refresh?: () => void;
    systemTime?: SystemTime;
    columns: string[];
    row: ResultRow;
    rowIndex: number;
    searchControl?: SearchControlLoaded
  }

  export const registeredPropertyFormatters: { [typeAndProperty: string]: CellFormatter } = {};

  export function registerPropertyFormatter(pr: PropertyRoute | string/*For expressions*/ | undefined, formater: CellFormatter): void {
    if (pr == null)
      return;
    registeredPropertyFormatters[pr.toString()] = formater;
  }

  export const formatRules: FormatRule[] = FinderRules.initFormatRules();

  export interface EntityFormatRule {
    name: string;
    formatter: EntityFormatter;
    isApplicable: (sc: SearchControlLoaded | undefined) => boolean;
  }

  export class EntityFormatter {
    constructor(
      public formatter: (ctx: CellFormatterContext) => React.ReactElement | string | null | undefined,
      public cellClass?: string) {
    }
  }

  export const entityFormatRules: EntityFormatRule[] = FinderRules.initEntityFormatRules();

  export interface QuickFilterRule {
    name: string
    applicable: (qt: QueryToken, cellValue: unknown, sc: SearchControlLoaded) => boolean;
    execute: (qt: QueryToken, cellValue: unknown, sc: SearchControlLoaded) => Promise<boolean>;
  }

  export const quickFilterRules: QuickFilterRule[] = FinderRules.initQuickFilterRules();

  export interface FilterFormatterContext {
    ctx: TypeContext<any>;
    label?: string;
    mandatory?: boolean;
    forceNullable?: boolean;
    queryToken: QueryToken;
    filterOptions: FilterOptionParsed[];
    handleValueChange: (f: FilterOptionParsed, avoidSearch?: boolean) => void;
  }


  export interface FilterValueFormatter {
    name: string
    applicable: (f: FilterOptionParsed, ffc: FilterFormatterContext) => boolean;
    renderValue: (f: FilterOptionParsed, ffc: FilterFormatterContext) => React.ReactElement;
  }

  export const filterValueFormatRules: FilterValueFormatter[] = FinderRules.initFilterValueFormatRules();

  export function renderFilterValue(f: FilterOptionParsed, ffc: FilterFormatterContext): React.ReactElement<any, string | React.JSXElementConstructor<any>> {
    var rule = filterValueFormatRules.last(r => r.applicable(f, ffc));
    return rule.renderValue(f, ffc);
  }

  export interface DomainRegistryEntry {
    type: Type<any>;
    getDomainField: (e: any) => any;
  }

  export const domainRegistry: Map<string, DomainRegistryEntry> = new Map<string, DomainRegistryEntry>();

  export function registerDomainForTokens<T extends Entity, D extends Entity>(type: Type<T>, getDomainField: (a: T) => Lite<D>): void {
    domainRegistry.set(getTypeName(type), { type, getDomainField });
  }
}
