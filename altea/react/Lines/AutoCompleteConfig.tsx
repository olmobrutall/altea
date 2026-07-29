// Ported from Signum.React/Lines/AutoCompleteConfig.tsx — copy-paste + fix. altea fixes:
//   - imports retargeted; ModifiableEntity→BaseEntity; AutocompleteConstructor from ../EntitySettings.
//   - idioms: is(a,b)→a.is(b), isLite/isEntity→instanceof, getToString(x)→x.toString(),
//     liteKey(x)→x.key(), x.Type/x.EntityType→getTypeName(x), TypeInfo.niceName→getNiceName().
//   - LocalizableMessage has no forGenderAndNumber/formatWith → SearchMessage.CreateNew0_G takes the
//     nice name as a niceToString arg (gender agreement dropped — TODO).
//   - parseLiteList (paste "Type;id" keys) not ported → stubbed to []; the paste-lites branch in
//     filtersWithSubStr is removed (normal substring search still works). TODO.
//   - filter/order values use altea's string-union enum members directly ("EqualTo"/"Ascending"/…).
import * as React from 'react'
import { Finder } from '../Finder'
import { AbortableRequest } from '../Services'
import type { FindOptions, FilterOption, QueryDescription } from '../FindOptions'
import type { ResultRow, ResultTable, QueryRequest } from '../../entities/dynamicQuery/queryRequest'
import { getTypeInfo, getTypeName } from '../Reflection'
import { QueryTokenString } from '../QueryTokenString'
import { Lite } from '../../entities/lite'
import { Entity, BaseEntity } from '../../entities/entity'
import { SearchMessage } from '../../entities/uiMessages'
import { TextHighlighter } from '../Components/Typeahead'
import type { TypeaheadController } from '../Components/Typeahead'
import { Navigator } from '../Navigator'
import type { AutocompleteConstructor } from '../EntitySettings'
import { Dic } from '../../entities/globals'

export interface AutocompleteConfig<T> {
  getItems: (subStr: string) => Promise<T[]>;
  getItemsDelay(): number | undefined;
  getMinLength(): number | undefined;
  renderItem(item: T, highlighter: TextHighlighter): React.ReactNode;
  itemTitle(item: T, highlighter: TextHighlighter): string | undefined;
  renderList?(typeahead: TypeaheadController): React.ReactNode;
  getEntityFromItem(item: T): Promise<Lite<Entity> | BaseEntity | undefined>;
  getDataKeyFromItem(item: T): string | undefined;
  getItemFromEntity(entity: Lite<Entity> | BaseEntity): Promise<T>;
  isCompatible(item: unknown, type: string): item is T;
  getSortByString(item: T): string
  abort(): void;
  getNotFoundMessage(): React.ReactNode;
}

export interface AutocompleteConfigOptions {
  itemsDelay?: number;
  minLength?: number;
  notFoundMessage?: React.ReactNode;
}

export interface LiteAutocomplateConfigOptions extends AutocompleteConfigOptions {
  requiresInitialLoad?: boolean,
  showType?: boolean
}

export function isAutocompleteConstructor<T extends BaseEntity>(a: any): a is AutocompleteConstructor<T> {
  return typeof a == "object" && (a as AutocompleteConstructor<T>).onClick != null;
}

export function isResultRow(a: any): a is ResultRow {
  return typeof a == "object" && (a as ResultRow).entity != null;
}

// TODO(port): parseLiteList (paste "Type;id" keys into autocomplete, Lite.parse per token) not ported;
// returns [] so the paste-lites shortcut is skipped. Normal substring search is unaffected.
function parseLiteList(subStr: string): Lite<Entity>[] { return []; }

export class LiteAutocompleteConfig<T extends Entity> implements AutocompleteConfig<Lite<T> | AutocompleteConstructor<T>>{
  requiresInitialLoad?: boolean;
  notFoundMessage?: React.ReactNode;
  showType?: boolean;

  constructor(
    public getItemsFunction: (signal: AbortSignal, subStr: string) => Promise<(Lite<T> | AutocompleteConstructor<T>)[]>,
    options?: LiteAutocomplateConfigOptions,
  ) {
    Dic.assign(this, options);
  }
  itemsDelay?: number | undefined;
  minLength?: number | undefined;

  abortableRequest: AbortableRequest<string, (Lite<T> | AutocompleteConstructor<T>)[]> = new AbortableRequest((signal, subStr: string) => this.getItemsFunction(signal, subStr));

  getNotFoundMessage(): React.ReactNode | undefined {
    return this.notFoundMessage;
  }

  getItemsDelay(): number | undefined {
    return this.itemsDelay;
  }

  getMinLength(): number | undefined {
    return this.minLength;
  }

  abort(): void {
    this.abortableRequest.abort();
  }

  getItems(subStr: string): Promise<(Lite<T> | AutocompleteConstructor<T>)[]> {
    return this.abortableRequest.getData(subStr);
  }

  itemTitle(item: Lite<T> | AutocompleteConstructor<T>, hl: TextHighlighter): string | undefined {
    if (isAutocompleteConstructor<T>(item)) {
      var ti = getTypeInfo(item.type);
      return `${SearchMessage.CreateNew0_G.niceToString(ti.getNiceName())} "${hl.query}"`;
    }

    return item.toString();
  }

  renderItem(item: Lite<T> | AutocompleteConstructor<T>, hl: TextHighlighter): React.ReactNode {

    if (isAutocompleteConstructor<T>(item)) {
      if (item.customElement)
        return item.customElement;

      var ti = getTypeInfo(item.type);
      return <em>{SearchMessage.CreateNew0_G.niceToString(ti.getNiceName())} "{hl.query}"</em>;
    }

    var html = Navigator.renderLite(item, hl);
    if (this.showType)
      return <span>{html}<TypeBadge entity={item} /></span>;
    else
      return html;
  }

  getEntityFromItem(item: Lite<T> | AutocompleteConstructor<T>): Promise<Lite<Entity> | BaseEntity | undefined> {

    if (isAutocompleteConstructor(item))
      return item.onClick() as Promise<Lite<Entity> | BaseEntity | undefined>;

    return Promise.resolve(item);
  }

  getDataKeyFromItem(item: Lite<T> | AutocompleteConstructor<T>): string | undefined {

    if (isAutocompleteConstructor(item))
      return "create-" + getTypeName(item.type);

    return item.key();
  }

  getItemFromEntity(entity: Lite<Entity> | BaseEntity): Promise<Lite<T>> {
    var lite = this.convertToLite(entity);

    if (!this.requiresInitialLoad)
      return Promise.resolve(lite);

    if (lite.id == undefined)
      return Promise.resolve(lite);

    return this.abortableRequest.getData(lite.id!.toString()).then(lites => {

      const result = lites.filter(a => a instanceof Lite && a.is(lite)).firstOrNull() as Lite<T> | null;

      if (!result)
        throw new Error("Impossible to getInitialItem with the current implementation of getItems");

      return result;
    });
  }

  convertToLite(entity: Lite<Entity> | BaseEntity): Lite<T> {

    if (entity instanceof Lite)
      return entity as Lite<T>;

    if (entity instanceof Entity)
      return entity.toLite(entity.isNew) as Lite<T>;

    throw new Error("Impossible to convert to Lite {0}".formatWith(getTypeName(entity)));
  }

  isCompatible(item: unknown, typeName: string): item is Lite<T> | AutocompleteConstructor<T> {
    return item instanceof Lite ? getTypeName(item) == typeName :
      isAutocompleteConstructor(item) ? getTypeName(item.type) == typeName :
        false;
  }

  getSortByString(item: Lite<T> | AutocompleteConstructor<T>): string {
    return item instanceof Lite ? item.toString() :
      isAutocompleteConstructor(item) ? getTypeName(item.type) :
        "";
  }
}

//Usefull to make a MultiFindOptions autocomplete using
export async function getLitesWithSubStr(fo: FindOptions, subStr: string, signal: AbortSignal): Promise<Lite<Entity>[]> {

  const foClean = Finder.defaultNoColumnsAllRows(fo, 5);

  const qd = await Finder.getQueryDescription(fo.queryName);
  const qs = Finder.getSettings(fo.queryName);

  const fop = await Finder.parseFindOptions({
    ...fo,
    orderOptions: qs?.defaultOrdersAutocomplete ?? [
      { token: "Entity.ToString.Length", orderType: "Ascending" },
      { token: "Entity.ToString", orderType: "Ascending" },
    ],
    filterOptions: FindOptionsAutocompleteConfig.filtersWithSubStr(fo, qd, qs, subStr),
    includeDefaultFilters: false,
  }, qd, true);

  var qr = Finder.getQueryRequest(fop);

  const rt = await Finder.API.executeQuery(qr, signal);

  return rt.rows.map(a => a.entity).notNull();
}


interface FindOptionsAutocompleteConfigOptions extends AutocompleteConfigOptions {
  getAutocompleteConstructor?: (str: string, foundRows: ResultRow[]) => AutocompleteConstructor<Entity>[];
  count?: number;
  requiresInitialLoad?: boolean;
  showType?: boolean;
  customRenderItem?: (row: ResultRow, table: ResultTable, hl: TextHighlighter) => React.ReactNode;
}

export class FindOptionsAutocompleteConfig implements AutocompleteConfig<ResultRow | AutocompleteConstructor<Entity>>{
  findOptions: FindOptions | ((subStr: string) => FindOptions);
  getAutocompleteConstructor?: (str: string, foundRows: ResultRow[]) => AutocompleteConstructor<Entity>[];
  requiresInitialLoad?: boolean;
  showType?: boolean;
  count?: number;
  customRenderItem?: (row: ResultRow, table: ResultTable, hl: TextHighlighter) => React.ReactNode;
  itemsDelay?: number;
  minLength?: number;
  notFoundMessage?: React.ReactNode;

  constructor(
    findOptions: FindOptions | ((subStr: string) => FindOptions),
    options?: FindOptionsAutocompleteConfigOptions,
  ) {
    this.findOptions = findOptions;

    Dic.assign(this, options);
  }

  getNotFoundMessage(): React.ReactNode {
    return this.notFoundMessage;
  }

  getItemsDelay(): number | undefined {
    return this.itemsDelay;
  }

  getMinLength(): number | undefined {
    return this.minLength;
  }

  abort(): void {
    this.abortableRequest.abort();
  }

  abortableRequest: AbortableRequest<QueryRequest, ResultTable> = new AbortableRequest((abortController, request: QueryRequest) => Finder.API.executeQuery(request, abortController));

  static filtersWithSubStr(fo: FindOptions, qd: QueryDescription, qs: Finder.QuerySettings | undefined, subStr: string): FilterOption[] {

    var filters = [...fo.filterOptions?.notNull() ?? []];

    /*When overriden in Finder very often uses not seen columns (like Telephone) that are not seen in autocomplete, better to use false by default and you can opt-in by adding includeDefaultFilters if needed */
    if (fo.includeDefaultFilters ?? false) {
      var defaultFilters = Finder.getDefaultFilter(qd, qs);
      if (defaultFilters)
        filters = [...defaultFilters, ...filters];
    }

    // TODO(port): paste-lites shortcut (parseLiteList → Entity IsIn filter) omitted — parseLiteList not ported.

    if (/^id[: ]/.test(subStr)) {

      var id = subStr.slice(3)?.trim();

      filters.insertAt(0, {
        token: "Entity.Id",
        operation: "EqualTo",
        value: id
      });
      return filters;
    }

    var searchBox = filters.firstOrNull(a => a.pinned != null && a.pinned.splitValue == true);

    if (searchBox == null) {
      filters.insertAt(0, {
        groupOperation: "Or",
        pinned: { label: SearchMessage.Search.niceToString(), splitValue: true, active: "WhenHasValue" },
        filters: [
          { token: "Entity.ToString", operation: "Contains" },
          { token: "Entity.Id", operation: "EqualTo" },
        ],
        value: subStr
      });
    } else {
      filters[filters.indexOf(searchBox)] = { ...searchBox, value: subStr }
    }


    return filters;
  }

  resultTable: ResultTable | undefined;

  async getItems(subStr: string): Promise<(ResultRow | AutocompleteConstructor<Entity>)[]> {

    var fo = Finder.defaultNoColumnsAllRows(typeof this.findOptions == "object" ? this.findOptions : this.findOptions(subStr), this.count ?? 5);
    const qs = Finder.getSettings(fo.queryName);

    return Finder.getQueryDescription(fo.queryName)
      .then(qd => Finder.parseFindOptions({
        orderOptions: qs?.defaultOrdersAutocomplete ?? [
          { token: "Entity.ToString.Length", orderType: "Ascending" },
          { token: "Entity.ToString", orderType: "Ascending" },
        ],
        ...fo,
        filterOptions: FindOptionsAutocompleteConfig.filtersWithSubStr(fo, qd, qs, subStr),
      }, qd, true))
      .then(fop => this.abortableRequest.getData(Finder.getQueryRequest(fop)))
      .then(rt => {
        this.resultTable = rt;
        return [
          ...rt.rows,
          ...(this.getAutocompleteConstructor && this.getAutocompleteConstructor(subStr, rt.rows)) ?? []
        ]
      });
  }

  itemTitle(item: ResultRow | AutocompleteConstructor<Entity>, hl: TextHighlighter): string {
    if (isAutocompleteConstructor<Entity>(item)) {
      var ti = getTypeInfo(item.type);
      return `${SearchMessage.CreateNew0_G.niceToString(ti.getNiceName())} "${hl.query}"`;
    }

    return item.entity!.toString();
  }

  renderItem(item: ResultRow | AutocompleteConstructor<Entity>, hl: TextHighlighter): React.ReactNode {
    if (isAutocompleteConstructor<Entity>(item)) {

      if (item.customElement)
        return item.customElement;

      var ti = getTypeInfo(item.type);
      return <em>{SearchMessage.CreateNew0_G.niceToString(ti.getNiceName())} "{hl.query}"</em>;
    }

    if (this.customRenderItem)
      return this.customRenderItem(item, this.resultTable!, hl);

    var toStr = item.entity!.toString();
    var html = Navigator.renderLite(item.entity!, hl);
    if (this.showType)
      return <span title={toStr}>{html}<TypeBadge entity={item.entity!} /></span>;
    else
      return html;
  }

  getEntityFromItem(item: ResultRow | AutocompleteConstructor<Entity>): Promise<Lite<Entity> | BaseEntity | undefined> {
    if (isAutocompleteConstructor(item))
      return item.onClick() as Promise<Lite<Entity> | BaseEntity | undefined>;

    return Promise.resolve(item.entity!);
  }

  getDataKeyFromItem(item: ResultRow | AutocompleteConstructor<Entity>): string | undefined {
    if (isAutocompleteConstructor(item))
      return "create-" + getTypeName(item.type);

    return item.entity!.key();
  }

  getItemFromEntity(entity: Lite<Entity> | BaseEntity): Promise<ResultRow> {

    var lite = this.convertToLite(entity);

    if (!(this.requiresInitialLoad))
      return Promise.resolve({ entity: lite } as ResultRow);

    if (lite.id == undefined)
      return Promise.resolve({ entity: lite } as ResultRow);

    var fo = Finder.defaultNoColumnsAllRows(typeof this.findOptions == "object" ? this.findOptions : this.findOptions(""), 1);

    fo = {
      ...fo,
      filterOptions: [{ token: QueryTokenString.entity<Entity>().append(e => e.id), operation: "EqualTo", value: lite.id }],
      includeDefaultFilters: false,
    };

    return Finder.getQueryDescription(fo.queryName)
      .then(qd => Finder.parseFindOptions(fo, qd, false)
        .then(fop => Finder.API.executeQuery(Finder.getQueryRequest(fop)))
        .then(rt => {
          const result = rt.rows.filter(row => row.entity != null && row.entity.is(lite)).firstOrNull();

          if (!result)
            throw new Error("Impossible to getInitialItem with the current implementation of getItems");

          return result;
        })
      );
  }

  convertToLite(entity: Lite<Entity> | BaseEntity): Lite<Entity> {

    if (entity instanceof Lite)
      return entity;

    if (entity instanceof Entity)
      return entity.toLite(entity.isNew);

    throw new Error("Impossible to convert to Lite");
  }

  isCompatible(item: unknown, typeName: string): item is ResultRow | AutocompleteConstructor<Entity> {
    return isResultRow(item) ? (item.entity != null && getTypeName(item.entity) == typeName) :
      isAutocompleteConstructor(item) ? getTypeName(item.type) == typeName :
        false;
  }

  getSortByString(item: ResultRow | AutocompleteConstructor<Entity>): string {
    return isResultRow(item) ? (item.entity ? item.entity.toString() : "") :
      isAutocompleteConstructor(item) ? getTypeName(item.type) :
        "";
  }
}

export function TypeBadge(p: { entity: Lite<Entity> | BaseEntity }): React.ReactElement {

  var typeName = p.entity instanceof Entity ? getTypeName(p.entity) :
    p.entity instanceof Lite ? getTypeName(p.entity) :
      null;

  if (typeName == null)
    return <span className="text-danger">Embedded?</span>;

  const ti = getTypeInfo(typeName);

  return <span className="sf-type-badge ms-1">{ti.getNiceName()}</span>;
}

export class MultiAutoCompleteConfig implements AutocompleteConfig<unknown>{

  implementations: { [typeName: string]: AutocompleteConfig<unknown> };
  limit: number;
  constructor(implementations: { [typeName: string]: AutocompleteConfig<unknown> }, limit: number = 5) {
    this.implementations = implementations;
    this.limit = limit;
  }


  async getItems(subStr: string): Promise<unknown[]> {
    var items = await Promise.all(Object.values(this.implementations).map(a => a.getItems(subStr)));
    var acc = items.flatMap(r => r).orderBy(item => {
      for (var type in this.implementations) {
        var acc = this.implementations[type];
        if (acc.isCompatible(item, type))
          return acc.getSortByString(item);
      }
      return "";
    });

    return [
      ...acc.filter(item => !isAutocompleteConstructor(item)).slice(0, this.limit),
      ...acc.filter(item => isAutocompleteConstructor(item))
    ];
  }

  getNotFoundMessage(): React.ReactNode {
    return undefined;
  }

  getItemsDelay(): number | undefined {
    return Object.values(this.implementations).map(a => a.getItemsDelay()).notNull().max() ?? undefined;
  }

  getMinLength(): number | undefined {
    return Object.values(this.implementations).map(a => a.getMinLength()).notNull().max() ?? undefined;
  }

  itemTitle(item: unknown, hl: TextHighlighter): string | undefined {
    for (var type in this.implementations) {
      var acc = this.implementations[type];
      if (acc.isCompatible(item, type))
        return acc.itemTitle(item, hl);
    }

    if (item instanceof Lite)
      return item.toString();

    throw new Error("Unexpected " + JSON.stringify(item));
  }

  renderItem(item: unknown, hl: TextHighlighter): React.ReactNode {
    for (var type in this.implementations) {
      var acc = this.implementations[type];
      if (acc.isCompatible(item, type))
        return acc.renderItem(item, hl);
    }

    if (item instanceof Lite)
      return Navigator.renderLite(item, hl);

    throw new Error("Unexpected " + JSON.stringify(item));
  }
  getEntityFromItem(item: unknown): Promise<BaseEntity | Lite<Entity> | undefined> {
    for (var type in this.implementations) {
      var acc = this.implementations[type];
      if (acc.isCompatible(item, type))
        return acc.getEntityFromItem(item);
    }

    if (item instanceof Lite)
      return Promise.resolve(item);

    throw new Error("Unexpected " + JSON.stringify(item));
  }
  getDataKeyFromItem(item: unknown): string | undefined {
    for (var type in this.implementations) {
      var acc = this.implementations[type];
      if (acc.isCompatible(item, type))
        return acc.getDataKeyFromItem(item);
    }

    if (item instanceof Lite)
      return item.key();

    throw new Error("Unexpected " + JSON.stringify(item));
  }
  getItemFromEntity(entity: BaseEntity | Lite<Entity>): Promise<unknown> {

    var type = entity instanceof Lite ? getTypeName(entity) : getTypeName(entity);

    var acc = this.implementations[type];
    if (acc != null)
      return acc.getItemFromEntity(entity);

    if (entity instanceof Lite)
      return Promise.resolve(entity);

    if (entity instanceof Entity)
      return Promise.resolve(entity.toLite(entity.isNew));

    throw new Error("Unexpected " + type);
  }

  abort(): void {
    Dic.foreach(this.implementations, (key, acc) => acc.abort());
  }

  isCompatible(item: unknown, type: string): item is unknown {
    return Object.values(this.implementations).some(a => a.isCompatible(item, type));
  }

  getSortByString(item: unknown): string {
    for (var type in this.implementations) {
      var acc = this.implementations[type];
      if (acc.isCompatible(item, type))
        return acc.getSortByString(item);
    }

    throw new Error("Unexpected " + JSON.stringify(item));
  }
}
