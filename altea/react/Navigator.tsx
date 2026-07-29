// Ported from Signum.React/Navigator.tsx (copied verbatim + staged, then fixed for altea).
// MOST of this file is commented out below: it depends on the reflection types blob
// (TypeInfo.niceName/kind/entityKind/operations/gender/members) and on modules not yet ported
// (Finder, Operations, Constructor, Frames/*, Lines/*, Components/*, Modals/*, Hooks,
// SearchControl, EntitySettings/ViewPromise/ViewReplacer). Only the API namespace (the entity HTTP
// client) is ported and ACTIVE. Uncomment each region as its dependencies land.

// --- Active altea imports (what the ported / activated code needs) ---
import * as React from "react";
import { ajaxGet, ajaxGetRaw, wrapRequest } from './Services';
import { toAbsoluteUrl } from './AppContext';
import { getTypeName, tryGetTypeInfo, isTypeModel } from './Reflection';
import type { PseudoType, Type } from './Reflection';
import { Dic } from '../entities/globals';
import { Entity, BaseEntity } from '../entities/entity';
import { Lite } from '../entities/lite';
import type { EntityPack } from '../entities/entityPack';
import type { EntityFrame } from './TypeContext';
import { useAPI, useAPIWithReload, useForceUpdate } from './Hooks';
import type { APIHookOptions } from './Hooks';
import { Serializer } from '../entities/serializer';
// Staged Navigator activation (entity-nav): the FULL EntitySettings/ViewPromise live in ./EntitySettings
// (view-override machinery stubbed). Navigator's earlier MINIMAL inline EntitySettings is replaced by this.
import { EntitySettings } from './EntitySettings';
import type { EntityWhen, ViewPromise, AutocompleteConstructor, AutocompleteConstructorContext } from './EntitySettings';
import { Finder } from './Finder';
import { Constructor } from './Constructor';
import { TextHighlighter } from './Components/Typeahead';
import { IsByAll, isRuntimeEmbedded, runtimeTypeName, tryGetTypeInfos, getTypeInfos, TypeInfo } from './Reflection';
import type { PropertyRoute } from './Reflection';
import { cleanTypeName } from '../entities/registration';
import { softCast } from '../entities/globals';
import type { RuntimeType } from '../entities/runtimeTypes';
import type { FindOptions } from './FindOptions';
import type { BsSize } from './Components';
import type { TypeContext } from './TypeContext';
import { FindOptionsAutocompleteConfig, MultiAutoCompleteConfig } from './Lines/AutoCompleteConfig';
import type { AutocompleteConfig } from './Lines/AutoCompleteConfig';

/* ===== Original Signum imports — rewire to altea modules as they are ported =====
import * as React from "react"
import { RouteObject } from 'react-router'
import { Dic, classes, softCast, } from './Globals';                          // -> ../entities/globals
import { ajaxGet, ajaxPost, clearContextHeaders } from './Services';
import { Lite, Entity, ModifiableEntity, EntityPack, isEntity, isLite, isEntityPack, toLite, liteKey, FrameMessage, ModelEntity, getToString, isModifiableEntity, EnumEntity, SearchMessage } from './Signum.Entities'; // -> ../entities/*, .is()/.toString()/.key()
import { TypeEntity, ExceptionEntity } from './Signum.Basics';
import { PropertyRoute, PseudoType, Type, getTypeInfo, tryGetTypeInfos, getTypeName, isTypeModel, OperationType, runtimeTypeName, isRuntimeEmbedded, IsByAll, isTypeEntity, tryGetTypeInfo, getTypeInfos, newLite, TypeInfo, EnumType } from './Reflection';
import type { RuntimeType } from '../entities/runtimeTypes';
import { ButtonBarElement, ButtonsContext, EntityFrame, TypeContext } from './TypeContext';
import * as AppContext from './AppContext';
import { Finder } from './Finder';
import * as Operations from './Operations';
import { Constructor } from './Constructor';
import { ViewReplacer } from './Frames/ReactVisitor'
import { AutocompleteConfig, FindOptionsAutocompleteConfig, getLitesWithSubStr, LiteAutocompleteConfig, MultiAutoCompleteConfig } from './Lines/AutoCompleteConfig'
import { FindOptions, FindOptionsParsed } from './FindOptions'
import { ImportComponent } from './ImportComponent'
import { BsSize } from "./Components/Basic";
import { ButtonBarManager } from "./Frames/ButtonBar";
import { clearWidgets } from "./Frames/Widgets";
import { toAbsoluteUrl, currentUser } from "./AppContext";
import { useForceUpdate, useAPI, useAPIWithReload, APIHookOptions } from "./Hooks";
import { ErrorModalOptions, RenderServiceMessageDefault, RenderValidationMessageDefault, RenderMessageDefault } from "./Modals/ErrorModal";
import CopyLiteButton from "./Components/CopyLiteButton";
import { Typeahead } from "./Components";
import { TextHighlighter, TypeaheadOptions } from "./Components/Typeahead";
import CopyLinkButton from "./Components/CopyLinkButton";
import { object } from "prop-types";
import { clearSpecialActions } from "./OmniboxSpecialAction";
import { ContextualItemsContext, MenuItemBlock } from "./SearchControl/ContextualItems";

// ALTEA: currentUser lives in AppContext (not yet ported) — the anonymous-user guard is deferred.
if (!window.__allowNavigatorWithoutUser && (currentUser == null || getToString(currentUser) == "Anonymous"))
  throw new Error("To improve intial performance, no dependency to any module that depends on Navigator should be taken for anonymous user. Review your dependencies or write var __allowNavigatorWithoutUser = true in Index.cshtml to disable this check.");
===== */

export namespace Navigator {

  /* ============================ TODO PORT — commented out for altea ============================
     Everything from here to the API namespace depends on the reflection types blob and/or unported
     modules (Finder, Operations, Constructor, Frames, Lines, Components, Modals, Hooks,
     SearchControl, EntitySettings/ViewPromise). Uncomment + sweep conventions as those land.

  export function start(options: { routes: RouteObject[] }): void {
    options.routes.push({ path: "/view/:type/:id", element: <ImportComponent onImport={() => getFramePage()} /> });
    options.routes.push({ path: "/create/:type", element: <ImportComponent onImport={() => getFramePage()} /> });

    AppContext.clearSettingsActions.push(clearEntitySettings);
    AppContext.clearSettingsActions.push(clearWidgets)
    AppContext.clearSettingsActions.push(ButtonBarManager.clearButtonBarRenderer);
    AppContext.clearSettingsActions.push(Constructor.clearCustomConstructors);
    AppContext.clearSettingsActions.push(clearEntityChanged);
    AppContext.clearSettingsActions.push(clearSpecialActions);
    AppContext.clearSettingsActions.push(clearEvents);

    ErrorModalOptions.getExceptionUrl = exceptionId => navigateRoute(newLite(ExceptionEntity, exceptionId));
    ErrorModalOptions.isExceptionViewable = () => isViewable(ExceptionEntity);
  }

  ============================ end TODO PORT (start) ============================ */

  // ===== ACTIVE: entity-changed event registry (blob-independent). =====
  export const entityChanged: { [typeName: string]: Array<(cleanName: string, entity: Entity | undefined, isRedirect: boolean) => void> } = {};

  export function registerEntityChanged<T extends Entity>(type: Type<T>, callback: (cleanName: string, entity: T | undefined, isRedirect: boolean) => void): void {
    var cleanName = getTypeName(type);
    (entityChanged[cleanName] ??= []).push(callback as any);
  }




  export function useEntityChanged<T extends Entity>(type: Type<T>, callback: (cleanName: string, entity: T | undefined, isRedirect: boolean) => void, deps: any[]): void;
  export function useEntityChanged(types: string[], callback: (cleanName: string, entity: Entity | undefined, isRedirect: boolean) => void, deps: any[]): void;
  export function useEntityChanged<T extends Entity>(typeOrTypes: Type<any> | string | string[], callback: (cleanName: string, entity: Entity | undefined, isRedirect: boolean) => void, deps: any[]): void {

    var types = Array.isArray(typeOrTypes) ? typeOrTypes : [typeof typeOrTypes === "string" ? typeOrTypes : getTypeName(typeOrTypes)];

    React.useEffect(() => {

      types.forEach(cleanName => {
        (entityChanged[cleanName] ??= []).push(callback);
      });

      return () => {
        types.forEach(cleanName => {
          entityChanged[cleanName]?.remove(callback);

          if (entityChanged[cleanName]?.length == 0)
            delete entityChanged[cleanName];
        });
      }
    }, [types.join(","), ...deps]);
  }

  function clearEntityChanged() {
    Dic.clear(entityChanged);
  }

  export function raiseEntityChanged(typeOrEntity: Type<any> | string | Entity, isRedirect = false): void {
    var cleanName = typeOrEntity instanceof Entity ? getTypeName(typeOrEntity) : typeOrEntity.toString();
    var entity = typeOrEntity instanceof Entity ? typeOrEntity : undefined;

    entityChanged[cleanName]?.forEach(func => func(cleanName, entity, isRedirect));
  }

  /* ============================ TODO PORT — commented (blob: TypeInfo.niceName/kind/entityKind,
     entitySettings, messages, Finder, Frames, Modals, Components) ============================
  export function getTypeSubTitle(entity: ModifiableEntity, pr: PropertyRoute | undefined): React.ReactNode | undefined {

    var settings = entitySettings[entity.Type];

    if (settings?.renderSubTitle)
      return settings.renderSubTitle(entity);

    if (isTypeEntity(entity.Type)) {

      const typeInfo = getTypeInfo(entity.Type);

      if (entity.isNew)
        return null;

      return defaultRenderSubTitle(typeInfo, entity);
    }
    else if (isTypeModel(entity.Type)) {
      return undefined;

    } else {
      return pr!.typeReference().typeNiceName;
    }
  }

  let defaultRenderSubTitle = (typeInfo: TypeInfo, entity: ModifiableEntity): React.ReactElement | null => {
    return <span>{typeInfo.niceName} {renderId(entity as Entity)}</span>;
  }

  export function setDefaultRenderTitleFunction(newFunction: (typeInfo: TypeInfo, entity: ModifiableEntity) => React.ReactElement | null): void {
    defaultRenderSubTitle = newFunction;
  }


  let renderId = (entity: Entity): React.ReactElement | string | number => {
    var idType = getTypeInfo(entity.Type).members["Id"].type;

    const hideId = getSettings(entity.Type)?.hideId ?? idType!.name == "Guid";
    return (
      <>
        <span className={hideId ? "sf-hide-id" : ""}>
          {entity.id}
        </span>
        <CopyLiteButton className={"sf-hide-id"} entity={entity} />
        <CopyLinkButton className={"sf-hide-id"} entity={entity} />
      </>
    );
  }

  export function setRenderIdFunction(newFunction: (entity: Entity) => React.ReactElement | string | number): void {
    renderId = newFunction;
  }


  export function navigateRoute(entity: Entity, viewName?: string): string;
  export function navigateRoute(lite: Lite<Entity>, viewName?: string): string;
  export function navigateRoute(entityOrLite: Entity | Lite<Entity>, viewName?: string): string {
    let typeName: string;
    let id: number | string | undefined;
    if (isEntity(entityOrLite)) {

      typeName = entityOrLite.Type;
      id = entityOrLite.id;
    }
    else if (isLite(entityOrLite)) {
      typeName = entityOrLite.EntityType;
      id = entityOrLite.id;
    }
    else
      throw new Error("Entity or Lite expected");

    if (id == null)
      throw new Error("No Id");

    const es = getSettings(typeName);
    if (es?.onNavigateRoute)
      return es.onNavigateRoute(typeName, id!, viewName);
    else
      return navigateRouteDefault(typeName, id!, viewName);

  }


  ============================ end TODO PORT ============================ */

  // ===== ACTIVE: default URL builders (blob-independent). =====
  export function navigateRouteDefault(typeName: string, id: number | string, viewName?: string): string {
    return "/view/" + typeName.firstLower() + "/" + id + (viewName ? "?viewName=" + viewName : "");

  }

  export function createRoute(type: PseudoType, viewName?: string): string {
    return "/create/" + getTypeName(type) + (viewName ? "?viewName=" + viewName : "");
  }



  /* ============================ TODO PORT — commented (blob + entitySettings + messages + Finder +
     Frames + Modals + Components + Hooks) ============================
  export function renderLiteOrEntity(entity: Lite<Entity> | Entity | ModifiableEntity, modelType?: string): string | React.ReactElement<any, string | React.JSXElementConstructor<any>> | undefined {
    if (isLite(entity))
      return renderLite(entity);

    if (isEntity(entity)) {
      var es = entitySettings[entity.Type];

      if (es.renderEntity)
        return es.renderEntity(entity, new TextHighlighter(undefined));

      if (es.renderLite) {
        var lite = toLite(entity, entity.isNew);
        return es.renderLite(lite, new TextHighlighter(undefined));
      }

      return getToString(entity);
    }
  }

  export function renderLite(lite: Lite<Entity>, hl?: TextHighlighter): React.ReactElement | string {
    var es = entitySettings[lite.EntityType];
    if (es != null && es.renderLite != null) {
      return es.renderLite(lite, hl ?? new TextHighlighter(undefined));
    }

    var toStr = getToString(lite);
    return hl == null ? toStr : hl.highlight(toStr);
  }

  export function renderEntity(entity: ModifiableEntity): React.ReactElement | string {
    var es = entitySettings[entity.Type];
    if (es != null && es.renderEntity != null) {
      return es.renderEntity(entity, new TextHighlighter(undefined));
    }

    if (entity.isNew) {
      var ti = tryGetTypeInfo(entity.Type);

      if (ti) {
        if (isTypeModel(entity.Type))
          return ti.niceName!;

        return FrameMessage.New0_G.niceToString().forGenderAndNumber(ti.gender).formatWith(ti.niceName);
      }
    }

    return getToString(entity);
  }

  export function clearEntitySettings(): void {
    Dic.clear(entitySettings);
  }

  export function clearEvents(): void {

    isCreableEvent.clear();
    isReadonlyEvent.clear();
    isViewableEvent.clear();
    Finder.isFindableEvent.clear();
  }

  export function setViewDispatcher(newDispatcher: ViewDispatcher): void {
    viewDispatcher = newDispatcher;
  }

  export function getFramePage(): Promise<typeof import("./Frames/FramePage")> {
    return import("./Frames/FramePage");
  }

  export function getFrameModal(): Promise<typeof import("./Frames/FrameModal")> {
    return import("./Frames/FrameModal");
  }

  export function onFramePageCreationCancelled(): void {
    AppContext.navigate("/", { replace: true });
  }

  export interface ViewDispatcher {
    hasDefaultView(typeName: string): boolean;
    getViewNames(typeName: string): Promise<string[]>;
    getViewPromise(entity: ModifiableEntity, viewName?: string): ViewPromise<ModifiableEntity>;
    getViewOverrides(typeName: string, viewName?: string): Promise<ViewOverride<ModifiableEntity>[]>;
  }

  export class BasicViewDispatcher implements ViewDispatcher {
    hasDefaultView(typeName: string): boolean {
      const es = getSettings(typeName);
      return (es?.getViewPromise) != null;
    }

    getViewNames(typeName: string): Promise<string[]> {
      const es = getSettings(typeName);
      return Promise.resolve((es?.namedViews && Dic.getKeys(es.namedViews)) ?? []);
    }

    getViewOverrides(typeName: string, viewName?: string): Promise<ViewOverride<ModifiableEntity>[]> {
      const es = getSettings(typeName);
      return Promise.resolve(es?.viewOverrides?.filter(a => a.viewName == viewName) ?? []);
    }


    getViewPromise(entity: ModifiableEntity, viewName?: string): ViewPromise<ModifiableEntity> {
      const es = getSettings(entity.Type);

      if (!es)
        throw new Error(`No EntitySettings registered for '${entity.Type}'`);

      if (viewName == undefined) {

        if (!es.getViewPromise)
          throw new Error(`The EntitySettings registered for '${entity.Type}' has not getViewPromise`);

        return es.getViewPromise(entity).applyViewOverrides(entity.Type);
      } else {
        var nv = es.namedViews && es.namedViews[viewName];

        if (!nv || !nv.getViewPromise)
          throw new Error(`The EntitySettings registered for '${entity.Type}' has not namedView '${viewName}'`);

        return nv.getViewPromise(entity).applyViewOverrides(entity.Type, viewName);
      }
    }
  }


  export class AutoViewDispatcher implements ViewDispatcher {

    hasDefaultView(typeName: string) {
      return true;
    }

    getViewNames(typeName: string): Promise<string[]> {
      const es = getSettings(typeName);
      return Promise.resolve((es?.namedViews && Dic.getKeys(es.namedViews)) ?? []);
    }

    getViewOverrides(typeName: string, viewName?: string): Promise<ViewOverride<ModifiableEntity>[]> {
      const es = getSettings(typeName);
      return Promise.resolve(es?.viewOverrides?.filter(a => a.viewName == viewName) ?? []);
    }

    getViewPromise(entity: ModifiableEntity, viewName?: string): ViewPromise<ModifiableEntity> {
      const es = getSettings(entity.Type);

      if (viewName == undefined) {

        if (es?.getViewPromise == null)
          return new ViewPromise<ModifiableEntity>(import('./AutoComponent'));

        return es.getViewPromise(entity).applyViewOverrides(entity.Type);
      } else {
        if (!es)
          throw new Error(`No EntitySettings registered for '${entity.Type}'`);

        var nv = es.namedViews && es.namedViews[viewName];

        if (!nv || !nv.getViewPromise)
          throw new Error(`The EntitySettings registered for '${entity.Type}' has not namedView '${viewName}'`);

        return nv.getViewPromise(entity).applyViewOverrides(entity.Type, viewName);
      }
    }
  }

  let viewDispatcher: ViewDispatcher = new AutoViewDispatcher();

  export function getViewDispatcher(): ViewDispatcher { return viewDispatcher; }

  export function getViewPromise<T extends ModifiableEntity>(entity: T, viewName?: string): ViewPromise<T> {
    return viewDispatcher.getViewPromise(entity, viewName);
  }

  export const isCreableEvent: Array<(typeName: string, options: IsCreableOptions | undefined) => boolean> = [];

  export interface IsCreableOptions {
    customComponent?: boolean;
    isSearch?: boolean;
    isEmbedded?: boolean;
    fo?: FindOptionsParsed;
  }

  export function isCreable(type: PseudoType, options?: IsCreableOptions): boolean {

    const typeName = getTypeName(type);

    if (!checkFlag(typeIsCreable(typeName, options?.isEmbedded), options?.isSearch))
      return false;

    if (options?.fo != null) {
      const es = entitySettings[typeName];
      if (es && es.isCreableByFilterProps && !es.isCreableByFilterProps(Finder.getPropsFromFiltersSync(type, options.fo.filterOptions)))
        return false;
    }

    if (!(options?.customComponent || viewDispatcher.hasDefaultView(typeName)))
      return false;

    if (!hasAllowedConstructor(typeName))
      return false;

    return isCreableEvent.every(c => c(typeName, options));
  }

  function hasAllowedConstructor(typeName: string) {
    const ti = tryGetTypeInfo(typeName);

    if (ti == undefined || ti.operations == undefined)
      return true;

    if (!ti.hasConstructorOperation)
      return true;

    const allowed = Dic.getValues(ti.operations).some(oi => oi.operationType == "Constructor");

    return allowed;
  }

  function typeIsCreable(typeName: string, isEmbedded?: boolean): EntityWhen {

    const es = entitySettings[typeName];
    if (es != undefined && es.isCreable != undefined)
      return es.isCreable;

    if (isEmbedded)
      return "IsLine";

    const typeInfo = tryGetTypeInfo(typeName);
    if (typeInfo == null)
      return "Never";

    if (typeInfo.kind == "Enum")
      return "Never";

    switch (typeInfo.entityKind) {
      case "SystemString": return "Never";
      case "System": return "Never";
      case "Relational": return "Never";
      case "String": return "IsSearch";
      case "Shared": return "Always";
      case "Main": return "IsSearch";
      case "Part": return "IsLine";
      case "SharedPart": return "IsLine";
      default: return "Never";
    }
  }


  export const isReadonlyEvent: Array<(typeName: string, entity?: EntityPack<ModifiableEntity>, options?: IsReadonlyOptions) => boolean> = [];

  export interface IsReadonlyOptions {
    ignoreTypeIsReadonly?: boolean;
    isEmbedded?: boolean;
  }

  export function isReadOnly(typeOrEntity: PseudoType | EntityPack<ModifiableEntity>, options?: IsReadonlyOptions): boolean {

    const entityPack = isEntityPack(typeOrEntity) ? typeOrEntity : undefined;

    const typeName = isEntityPack(typeOrEntity) ? typeOrEntity.entity.Type : getTypeName(typeOrEntity as PseudoType);

    if (!options?.ignoreTypeIsReadonly && typeIsReadOnly(typeName, options?.isEmbedded))
      return true;

    return isReadonlyEvent.some(f => f(typeName, entityPack, options));
  }

  function typeIsReadOnly(typeName: string, isEmbedded: boolean | undefined): boolean {

    const es = entitySettings[typeName];
    if (es != undefined && es.isReadOnly != undefined)
      return es.isReadOnly;

    if (isEmbedded)
      return false;

    const typeInfo = tryGetTypeInfo(typeName);
    if (typeInfo == undefined)
      return true;

    if (typeInfo.kind == "Enum")
      return true;

    switch (typeInfo.entityKind) {
      case "SystemString": return true;
      case "System": return true;
      case "Relational": return true;
      case "String": return false;
      case "Shared": return false;
      case "Main": return false;
      case "Part": return false;
      case "SharedPart": return false;
      default: return false;
    }
  }
  export function checkFlag(entityWhen: EntityWhen, isSearchMainEntity: boolean | undefined): boolean {
    return entityWhen == "Always" ||
      entityWhen == (isSearchMainEntity ? "IsSearch" : "IsLine");
  }

  export function typeRequiresSaveOperation(typeName: string): boolean {

    const typeInfo = tryGetTypeInfo(typeName);
    if (typeInfo == undefined)
      return false;

    switch (typeInfo.entityKind) {
      case "SystemString": return true;
      case "System": return true;
      case "Relational": return true;
      case "String": return true;
      case "Shared": return true;
      case "Main": return true;
      case "Part": return false;
      case "SharedPart": return false;
      default: return false;
    }
  }

  export interface IsFindableOptions {
    fullScreenSearch?: boolean;
    isEmbeddedEntity?: boolean;
  }

  export function isFindable(type: PseudoType, options?: IsFindableOptions): boolean {

    const typeName = getTypeName(type);

    const baseIsReadOnly = typeIsFindable(typeName, options?.isEmbeddedEntity);

    return baseIsReadOnly && Finder.isFindable(typeName, options?.fullScreenSearch ?? true);
  }

  function typeIsFindable(typeName: string, isEmbeddedEntity: boolean | undefined) {

    const es = entitySettings[typeName];

    if (es != undefined && es.isFindable != undefined)
      return es.isFindable;

    if (isEmbeddedEntity)
      return false;

    const typeInfo = tryGetTypeInfo(typeName);
    if (typeInfo == null)
      return false;

    if (typeInfo.kind == "Enum")
      return true;

    switch (typeInfo.entityKind) {
      case "SystemString": return true;
      case "System": return true;
      case "Relational": return false;
      case "String": return true;
      case "Shared": return true;
      case "Main": return true;
      case "Part": return false;
      case "SharedPart": return true;
      default: return false;
    }
  }

  export const isViewableEvent: Array<(typeName: string, entityPack: EntityPack<ModifiableEntity> | Lite<Entity> | undefined, options: IsViewableOptions | undefined) => boolean> = [];

  export interface IsViewableOptions {
    customComponent?: boolean;
    isSearch?: "main" | "related";
    isEmbedded?: boolean;
    buttons?: ViewButtons;
  }

  export type ViewButtons = "ok_cancel" | "close" | undefined;

  export function typeDefaultButtons(typeName: string, isEmbedded: boolean | undefined): ViewButtons {
    if (isEmbedded)
      return "ok_cancel";

    const ti = tryGetTypeInfo(typeName);
    if (ti != null) {
      if (
        ti.entityKind == undefined ||
        ti.entityKind == "Part" ||
        ti.entityKind == "SharedPart")
        return "ok_cancel";
    }

    return "close";
  }

  export function isViewable(typeOrEntity: PseudoType | EntityPack<ModifiableEntity> | Lite<Entity>, options?: IsViewableOptions): boolean {

    const entity =
      isEntityPack(typeOrEntity) ? typeOrEntity :
        isLite(typeOrEntity) ? typeOrEntity :
          undefined;

    const typeName =
      isEntityPack(typeOrEntity) ? typeOrEntity.entity.Type :
        isLite(typeOrEntity) ? typeOrEntity.EntityType :
          getTypeName(typeOrEntity as PseudoType);

    const typeViewable = checkFlag(typeIsViewable(typeName, options?.isEmbedded), options?.isSearch == "main");
    if (!typeViewable)
      return false;

    const hasView = options?.customComponent || viewDispatcher.hasDefaultView(typeName);
    if (!hasView)
      return false;

    if (entity) {
      const es = entitySettings[typeName];

      if (es != null && isLite(entity) && es.isViewableLite && !es.isViewableLite(entity, options))
        return false;

      if (es != null && isEntityPack(entity) && es.isViewableEntityPack && !es.isViewableEntityPack(entity, options))
        return false;
    }

    if (!isViewableEvent.every(f => f(typeName, entity, options)))
      return false;

    return true;
  }

  function typeIsViewable(typeName: string, isEmbedded: boolean | undefined): EntityWhen {

    const es = entitySettings[typeName];

    if (es != undefined && es.isViewable != undefined)
      return es.isViewable;

    if (isEmbedded)
      return "IsLine";

    const typeInfo = tryGetTypeInfo(typeName);
    if (typeInfo == null)
      return "Never";

    if (typeInfo.kind == "Enum")
      return "Never";

    switch (typeInfo.entityKind) {
      case "SystemString": return "Never";
      case "System": return "Always";
      case "Relational": return "Never";
      case "String": return "IsSearch";
      case "Shared": return "Always";
      case "Main": return "Always";
      case "Part": return "Always";
      case "SharedPart": return "Always";
      default: return "Never";
    }
  }

  export function defaultFindOptions(type: RuntimeType): FindOptions | undefined {
    if (isRuntimeEmbedded(type) || runtimeTypeName(type) == IsByAll)
      return undefined;

    const types = tryGetTypeInfos(runtimeTypeName(type));

    if (types.length == 1 && types[0] != null) {
      var s = getSettings(types[0]);

      if (s?.defaultFindOptions) {
        return s.defaultFindOptions;
      }
    }

    return undefined;
  }

  export function getAutoComplete(type: RuntimeType, findOptions: FindOptions | undefined, findOptionsDictionary: { [typeName: string]: FindOptions } | undefined, ctx: TypeContext<any>, create: boolean, showType?: boolean): AutocompleteConfig<any> | null {
    if (isRuntimeEmbedded(type) || runtimeTypeName(type) == IsByAll)
      return null;

    let types = tryGetTypeInfos(runtimeTypeName(type)).notNull();
    showType ??= types.length > 1;

    types = types.filter(t => isFindable(t, { fullScreenSearch: false }));

    if (types.length == 0)
      return null;

    if (types.length == 1 || findOptions != null)
      return getAutoCompleteBasic(types[0]!, findOptions, ctx, create, showType);

    return new MultiAutoCompleteConfig(types.toObject(t => t!.name,
      t => getAutoCompleteBasic(t!, (findOptionsDictionary && findOptionsDictionary[t!.name]), ctx, create, showType!)
    ));
  }


  export function getAutoCompleteBasic(type: TypeInfo, findOptions: FindOptions | undefined, ctx: TypeContext<any>, create: boolean, showType: boolean): AutocompleteConfig<any> {

    var s = getSettings(type);

    if (s?.autocomplete != null) {
      var acc = s.autocomplete(findOptions, showType);

      if (acc != null)
        return acc;
    }

    var fo = findOptions ?? s?.defaultFindOptions ?? { queryName: type.name };

    return new FindOptionsAutocompleteConfig(fo, {
      showType: showType,
      itemsDelay: s?.autocompleteDelay,
      getAutocompleteConstructor: (subStr, rows) => getAutocompleteConstructors(type, subStr, { ctx, foundLites: rows.map(a => a.entity!), findOptions, create: create }) as AutocompleteConstructor<Entity>[]
    });
  }


  export interface ViewOptions<T extends ModifiableEntity> {
    title?: React.ReactNode | null;
    subTitle?: React.ReactNode | null;
    propertyRoute?: PropertyRoute;
    readOnly?: boolean;
    modalSize?: BsSize;
    isOperationVisible?: (eoc: Operations.EntityOperationContext<T & Entity>) => boolean;
    validate?: boolean;
    requiresSaveOperation?: boolean;
    avoidPromptLoseChange?: boolean;
    buttons?: ViewButtons;
    getViewPromise?: (entity: T) => undefined | string | ViewPromise<T>;
    createNew?: () => Promise<EntityPack<T> | undefined>;
    allowExchangeEntity?: boolean;
    extraProps?: {};
  }


  export function view<T extends ModifiableEntity>(entityOrPack: Lite<T & Entity> | T | EntityPack<T>, viewOptions?: ViewOptions<T>): Promise<T | undefined> {

    const typeName = isEntityPack(entityOrPack) ? entityOrPack.entity.Type : getTypeName(entityOrPack);

    const es = getSettings(typeName) as EntitySettings<T> | undefined;

    if (es?.onView)
      return es.onView(entityOrPack, viewOptions);
    else
      return viewDefault(entityOrPack, viewOptions);
  }

  export function viewDefault<T extends ModifiableEntity>(entityOrPack: Lite<T & Entity> | T | EntityPack<T>, viewOptions?: ViewOptions<T>): Promise<T | undefined> {
    return getFrameModal()
      .then(NP => NP.FrameModalManager.openView(entityOrPack, viewOptions ?? {}));
  }

  export function createInNewTab(pack: EntityPack<ModifiableEntity>, viewName?: string): void {
    var url = createRoute(pack.entity.Type, viewName) + "?waitOpenerData=true";
    window.dataForChildWindow = pack;
    var win = window.open(toAbsoluteUrl(url));
  }

  export function createInCurrentTab(pack: EntityPack<ModifiableEntity>, viewName?: string): void {
    var url = createRoute(pack.entity.Type, viewName) + "?waitCurrentData=true";
    window.dataForCurrentWindow = pack;
    AppContext.navigate(url);
  }

  export function createNavigateOrTab(pack: EntityPack<Entity> | undefined, event: React.MouseEvent<any>): Promise<void> {
    if (!pack || !pack.entity)
      return Promise.resolve();

    const es = getSettings(pack.entity.Type);
    if (es?.avoidPopup || event.ctrlKey || event.button == 1) {
      createInNewTab(pack);
      return Promise.resolve();
    }
    else {
      return view(pack, { buttons: "close" }).then(() => undefined);
    }
  }

  ============================ end TODO PORT ============================ */

  // ===== ACTIVE: entity <-> EntityPack helpers (use the ported API namespace). =====
  export function toEntityPack<T extends BaseEntity>(entityOrEntityPack: Lite<T & Entity> | T | EntityPack<T>): Promise<EntityPack<T>> {
    if ((entityOrEntityPack as EntityPack<T>).canExecute)
      return Promise.resolve(entityOrEntityPack as EntityPack<T>);

    const entity = entityOrEntityPack instanceof BaseEntity ? entityOrEntityPack as T :
      entityOrEntityPack instanceof Lite ? entityOrEntityPack.entityOrNull as T | undefined :
        (entityOrEntityPack as EntityPack<T>).entity;

    if (entity == undefined)
      return API.fetchEntityPack(entityOrEntityPack as Lite<T & Entity>);

    if (!(entity instanceof Entity))
      return Promise.resolve({ entity: cloneEntity(entity), canExecute: {} });

    return API.fetchEntityPackEntity(entity as T & Entity).then(ep => ({ ...ep, entity: cloneEntity(entity) }));
  }

  export async function reloadFrameIfNecessary(frame: EntityFrame): Promise<void> {

    var entity = frame.pack.entity;
    if (entity instanceof Entity && entity.id && entity.ticks != null) {
      var newPack = await API.fetchEntityPack(entity.toLite());
      if (newPack.entity.ticks != entity.ticks)
        frame.onReload(newPack);
    }
  }

  // ALTEA: clone via the Serializer (JSON.parse/stringify would drop the class + $type).
  function cloneEntity(obj: any): any {
    return Serializer.parse(Serializer.stringify(obj));
  }

  // ===== ACTIVE: fetch a single lite into state (uses ported API + Hooks). =====
  export function useFetchInState<T extends Entity>(lite: Lite<T> | null | undefined, options?: APIHookOptions): T | null | undefined {
    return useAPI(signal =>
      lite == null ? Promise.resolve<T | null | undefined>(lite) :
        API.fetch(lite),
      [lite && lite.key()], options);
  }

  export function useFetchInStateWithReload<T extends Entity>(lite: Lite<T> | null | undefined, options?: APIHookOptions): [T | null | undefined, () => void] {
    return useAPIWithReload(signal =>
      lite == null ? Promise.resolve<T | null | undefined>(lite) :
        API.fetch(lite),
      [lite && lite.key()], options);
  }

  // ===== ACTIVE: fetch-and-cache lites -> entities (uses the ported API + lite.key()). =====
  export function useFetchEntities<T extends Entity>(lites: Lite<T>[]): Map<string, T> {

    const [entities, setEntities] = React.useState<Map<string, T>>(new Map());

    const listKey = lites.map(l => l.key()).join(",");

    React.useEffect(() => {
      const unfetched = lites.filter(l => !entities.has(l.key()));
      if (unfetched.length == 0)
        return;

      Promise.all(unfetched.map(l => API.fetch(l)))
        .then(fetched => {
          setEntities(prev => {
            const next = new Map(prev);
            fetched.forEach(e => next.set(e.toLite().key(), e));
            return next;
          });
        });
    }, [listKey]);

    return entities;
  }

  // ===== ACTIVE: fetch-and-remember into the lite; useFetchEntity / useFetchAll (ported API + Hooks). =====
  export function useFetchAndRemember<T extends Entity>(lite: Lite<T> | null, onLoaded?: () => void): T | null | undefined {

    const forceUpdate = useForceUpdate();
    React.useEffect(() => {
      if (lite && !lite.entityOrNull)
        API.fetchAndRemember(lite)
          .then(() => {
            onLoaded && onLoaded();
            forceUpdate();
          });
    }, [lite]);


    if (lite == null)
      return null;

    if (lite.entityOrNull == null)
      return undefined;

    return lite.entityOrNull;
  }

  // ALTEA: partitionId dropped (no partitioning yet).
  export function useFetchEntity<T extends Entity>(type: Type<T>, id: any, deps?: React.DependencyList, options?: APIHookOptions): T | undefined {
    return useAPI(signal => API.fetchEntity(type, id), [type, id, ...(deps ?? [])], options);
  }

  export function useFetchAll<T extends Entity>(type: Type<T>, deps?: React.DependencyList): T[] | undefined {
    return useAPI(signal => API.fetchAll(type), [type, ...(deps ?? [])]);
  }

  /* ============================ TODO PORT — commented (need newLite / fillLiteModels / custom-lite
     models + getAutocompleteConstructors/someNonViewable which need Constructor/entitySettings) ============================
  export function useLiteToString<T extends Entity>(type: Type<T>, id: number | string, deps?: React.DependencyList, options?: APIHookOptions): Lite<T> {

    var lite = React.useMemo(() => newLite(type, id), [type, id, ...(deps ?? [])]);

    useAPI(() => API.fillLiteModels(lite), [lite, ...(deps ?? [])], options);

    return lite;
  }

  export function useFillToString<T extends Entity>(lite: Lite<T> | null | undefined, force: boolean = false, deps?: React.DependencyList): void {
    useAPI(() => {
      return lite == null || ((lite.model != null || lite.entity != null) && !force) ? Promise.resolve() : API.fillLiteModels(lite);
    }, [lite, ...(deps ?? [])]);
  }


  export function getAutocompleteConstructors(tr: RuntimeType, str: string, aac: AutocompleteConstructorContext): AutocompleteConstructor<ModifiableEntity>[] {
    return getTypeInfos(runtimeTypeName(tr)).map(ti => {
      var es = getSettings(ti);

      if (es == null || es.autocompleteConstructor == null)
        return null;

      if (typeof es.autocompleteConstructor == "string")
        return softCast<AutocompleteConstructor<ModifiableEntity>>({
          type: ti.name,
          onClick: () => Constructor.construct(ti.name, { [es!.autocompleteConstructor as string]: str }).then(a => a && view(a))
        });

      return es.autocompleteConstructor(str, aac);
    }).notNull();
  }

  export function someNonViewable(lites: Lite<Entity>[]) : boolean {
    return lites.groupBy(a => a.EntityType).some(gr => {
      var isViewable = Navigator.entitySettings[gr.key]?.isViewableLite;
      return isViewable && gr.elements.some(lite => !isViewable!(lite, { isSearch: "main" }))
    });
  }

  export namespace API {

    export function fillLiteModels(...lites: (Lite<Entity> | null | undefined)[]): Promise<void> {
      return fillLiteModelsArray(lites.filter(l => l != null) as Lite<Entity>[]);
    }

    export function fillLiteModelsArray(lites: Lite<Entity>[], force?: boolean): Promise<void> {

      if (force) {
        lites.forEach(a => a.ModelType = a.ModelType ?? (isModifiableEntity(a.model) ? a.model.Type : "string"));
      }

      const realLites = force ? lites : lites.filter(a => a.model == undefined && a.entity == undefined);

      if (!realLites.length)
        return Promise.resolve();

      return ajaxPost<unknown[]>({ url: "/api/liteModels" }, realLites).then(models => {
        realLites.forEach((l, i) => l.model = models[i]);
      });
    }

    export function fetchAll<T extends Entity>(type: Type<T>): Promise<Array<T>> {
      return ajaxGet({ url: "/api/fetchAll/" + type.typeName });
    }


    export function fetchAndRemember<T extends Entity>(lite: Lite<T>): Promise<T> {
      if (lite.entity)
        return Promise.resolve(lite.entity);

      if (lite.id == null)
        throw new Error("Lite has no Id");

      return fetchEntity(lite.EntityType, lite.id).then(e => lite.entity = e as T);
    }

    export function fetch<T extends Entity>(lite: Lite<T>): Promise<T> {

      if (lite.id == null)
        throw new Error("Lite has no Id");

      return fetchEntity(lite.EntityType, lite.id, lite.partitionId) as Promise<T>;
    }

    export function fetchEntity<T extends Entity>(type: Type<T>, id: any, partitionId?: number): Promise<T>;
    export function fetchEntity(type: PseudoType, id: number | string, partitionId?: number): Promise<Entity>;
    export function fetchEntity(type: PseudoType, id?: number | string, partitionId?: number): Promise<Entity> {

      const typeName = getTypeName(type);
      let idVal = id;

      return ajaxGet({ url: "/api/entity/" + typeName + "/" + id + (partitionId ? "?partitionId=" + partitionId : "") });
    }

    export function exists<T extends Entity>(lite: Lite<T>): Promise<boolean>;
    export function exists<T extends Entity>(entity: T): Promise<boolean>;
    export function exists<T extends Entity>(type: Type<T>, id: any): Promise<boolean>;
    export function exists(type: PseudoType, id: number | string): Promise<boolean>;
    export function exists(typeOrEntity: PseudoType | Lite<Entity> | Entity, idOrNull?: number | string): Promise<boolean> {

      const typeName =
        isEntity(typeOrEntity) ? typeOrEntity.Type :
          isLite(typeOrEntity) ? typeOrEntity.EntityType :
            getTypeName(typeOrEntity);

      let id = isEntity(typeOrEntity) ? typeOrEntity.id :
        isLite(typeOrEntity) ? typeOrEntity.id :
          idOrNull;

      if (id == null)
        throw new Error("No id found");

      return ajaxGet({ url: "/api/exists/" + typeName + "/" + id });
    }


    export function fetchEntityPack<T extends Entity>(lite: Lite<T>): Promise<EntityPack<T>>;
    export function fetchEntityPack<T extends Entity>(type: Type<T>, id: number | string, partitionId?: number): Promise<EntityPack<T>>;
    export function fetchEntityPack(type: PseudoType, id: number | string, partitionId?: number): Promise<EntityPack<Entity>>;
    export function fetchEntityPack(typeOrLite: PseudoType | Lite<any>, id?: any, partitionId?: number): Promise<EntityPack<Entity>> {

      const typeName = (typeOrLite as Lite<any>).EntityType ?? getTypeName(typeOrLite as PseudoType);
      let idVal = (typeOrLite as Lite<any>).id != null ? (typeOrLite as Lite<any>).id : id;
      let pId = (typeOrLite as Lite<any>)?.partitionId ?? partitionId;
      return ajaxGet({ url: "/api/entityPack/" + typeName + "/" + idVal + (pId ? "?partitionId=" + pId : "") });
    }

    export function fetchEntityPackEntity<T extends Entity>(entity: T): Promise<EntityPack<T>> {
      return ajaxPost<EntityPack<T>>({ url: "/api/entityPackEntity" }, entity)
        .then(ep => ({ ...ep, entity }));
    }

    export function validateEntity(entity: ModifiableEntity): Promise<void> {
      return ajaxPost({ url: "/api/validateEntity" }, entity);
    }

    export function getType(typeName: string): Promise<TypeEntity | null> {

      return ajaxGet({ url: `/api/reflection/typeEntity/${typeName}` });
    }

    export function getEnumEntities<T extends string>(type: EnumType<T>): Promise<EnumConverter<T>>;
    export function getEnumEntities(typeName: string): Promise<EnumConverter<string>>;
    export function getEnumEntities(type: string | EnumType<string>): Promise<EnumConverter<string>> {

      var typeName = typeof type == "string" ? type : type.typeName;

      return ajaxGet<{ [enumValue: string]: Entity }>({ url: `/api/reflection/enumEntities/${typeName}` })
        .then(enumToEntity => softCast<EnumConverter<string>>({
          enumToEntity: enumToEntity,
          idToEnum: Object.entries(enumToEntity).toObject(a => a[1].id!.toString(), a => a[0])
        }));
    }
  }
  ============================ end TODO PORT ============================ */

  // ===== Ported + ACTIVE: the entity HTTP client (client half of EntitiesController). =====
  // ALTEA seam: entity responses decode via Serializer.parse (real class graph), entity POST bodies
  // via Serializer.stringify — not the generic JSON ajax. Swept: lite.EntityType -> lite.entityType,
  // entity.Type -> getTypeName(entity), type.typeName static -> getTypeName(type). Inside `namespace
  // API`, `fetch` shadows the DOM fetch -> window.fetch. Deferred (TODO): partitionId,
  // fillLiteModels/custom-lite models, getEnumEntities, getType (need reflection endpoints).
  export namespace API {

    // GET an entity graph and rebuild the real class instances (Serializer, not JSON.parse).
    function getEntity<T>(url: string): Promise<T> {
      return ajaxGetRaw({ url })
        .then(r => r.text())
        .then(t => (t.length ? Serializer.parse(t) : null) as T);
    }

    // POST an entity (Serializer-encoded body) and JSON-decode the (non-entity) response.
    function postEntity<T>(url: string, entity: unknown): Promise<T> {
      const makeCall = (): Promise<Response> => window.fetch(toAbsoluteUrl(url, window.__baseNameAPI), {
        method: "POST",
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        credentials: "same-origin",
        cache: "no-store",
        body: Serializer.stringify(entity),
      });
      return wrapRequest({ url }, makeCall)
        .then(r => r.text())
        .then(t => (t.length ? JSON.parse(t) : null) as T);
    }

    // GET an EntityPack: the envelope is JSON, but its `entity` field is an entity graph.
    function getEntityPack<T extends Entity>(url: string): Promise<EntityPack<T>> {
      return ajaxGet<{ entity: unknown; canExecute: { [key: string]: string } }>({ url })
        .then(pack => ({ canExecute: pack.canExecute, entity: Serializer.parse(JSON.stringify(pack.entity)) as T }));
    }

    export function fetchAll<T extends Entity>(type: Type<T>): Promise<Array<T>> {
      return getEntity("/api/fetchAll/" + getTypeName(type));
    }

    export function fetchAndRemember<T extends Entity>(lite: Lite<T>): Promise<T> {
      if (lite.entityOrNull)
        return Promise.resolve(lite.entityOrNull);
      if (lite.id == null)
        throw new Error("Lite has no Id");
      return fetchEntity(lite.entityType, lite.id).then(e => (lite.setEntity(e), e as T));
    }

    export function fetch<T extends Entity>(lite: Lite<T>): Promise<T> {
      if (lite.id == null)
        throw new Error("Lite has no Id");
      return fetchEntity(lite.entityType, lite.id) as Promise<T>;
    }

    export function fetchEntity<T extends Entity>(type: Type<T>, id: number | string): Promise<T>;
    export function fetchEntity(type: PseudoType, id: number | string): Promise<Entity>;
    export function fetchEntity(type: PseudoType, id?: number | string): Promise<Entity> {
      return getEntity("/api/entity/" + getTypeName(type) + "/" + id);
    }

    export function exists<T extends Entity>(lite: Lite<T>): Promise<boolean>;
    export function exists<T extends Entity>(entity: T): Promise<boolean>;
    export function exists(type: PseudoType, id: number | string): Promise<boolean>;
    export function exists(typeOrEntity: PseudoType | Lite<Entity> | Entity, idOrNull?: number | string): Promise<boolean> {
      const typeName = getTypeName(typeOrEntity as PseudoType | Lite<Entity> | Entity);
      const id =
        typeOrEntity instanceof Entity ? typeOrEntity.id :
          typeOrEntity instanceof Lite ? typeOrEntity.id :
            idOrNull;
      if (id == null)
        throw new Error("No id found");
      return ajaxGet({ url: "/api/exists/" + typeName + "/" + id });
    }

    export function fetchEntityPack<T extends Entity>(lite: Lite<T>): Promise<EntityPack<T>>;
    export function fetchEntityPack<T extends Entity>(type: Type<T>, id: number | string): Promise<EntityPack<T>>;
    export function fetchEntityPack(type: PseudoType, id: number | string): Promise<EntityPack<Entity>>;
    export function fetchEntityPack(typeOrLite: PseudoType | Lite<Entity>, id?: number | string): Promise<EntityPack<Entity>> {
      const typeName = getTypeName(typeOrLite as PseudoType | Lite<Entity>);
      const idVal = typeOrLite instanceof Lite ? typeOrLite.id : id;
      return getEntityPack("/api/entityPack/" + typeName + "/" + idVal);
    }

    export function fetchEntityPackEntity<T extends Entity>(entity: T): Promise<EntityPack<T>> {
      return postEntity<EntityPack<T>>("/api/entityPackEntity", entity)
        .then(ep => ({ ...ep, entity }));
    }

    export function validateEntity(entity: Entity): Promise<void> {
      return postEntity("/api/validateEntity", entity);
    }
  }

  // ================= ACTIVE: EntitySettings registry + type classification =================
  // Uses the enriched TypeInfo (entityKind / kind). This is a MINIMAL EntitySettings — the
  // view/autocomplete/render fields of Signum's full EntitySettings (commented in region C below)
  // land with their deps (ViewReplacer / AutocompleteConfig / Modals / Frames). Local `isEntityPack`
  // replaces the removed free helper. `isFindable` stays commented (needs Finder).

  // EntityWhen + the FULL EntitySettings (and ViewPromise) now live in ./EntitySettings (staged; the
  // view-override machinery is stubbed there). Imported at module scope above — this replaces the
  // earlier MINIMAL inline EntitySettings so the autocomplete/getViewPromise/render fields exist for
  // EntityLine/getAutoComplete.

  export const entitySettings: { [type: string]: EntitySettings } = {};

  export function addSettings(...settings: EntitySettings[]): void {
    settings.forEach(s => Dic.addOrThrow(entitySettings, s.typeName, s));
  }

  export function getOrAddSettings<T extends BaseEntity>(type: Type<T>): EntitySettings<T>;
  export function getOrAddSettings(type: PseudoType): EntitySettings;
  export function getOrAddSettings(type: PseudoType): EntitySettings {
    const typeName = getTypeName(type);
    return entitySettings[typeName] || (entitySettings[typeName] = new EntitySettings(typeName));
  }

  export function getSettings<T extends BaseEntity>(type: Type<T>): EntitySettings<T> | undefined;
  export function getSettings(type: PseudoType): EntitySettings | undefined;
  export function getSettings(type: PseudoType): EntitySettings | undefined {
    return entitySettings[getTypeName(type)];
  }

  function isEntityPack(x: unknown): x is EntityPack<BaseEntity> {
    return x != null && (x as EntityPack<BaseEntity>).entity != null && (x as { canExecute?: unknown }).canExecute !== undefined;
  }

  // Minimal view-dispatch: only hasDefaultView is needed by isCreable/isViewable; the real
  // ViewDispatcher (view promises / overrides) lands with Frames/ViewReplacer.
  export function hasDefaultView(typeName: string): boolean { return true; } // TODO: real ViewDispatcher

  export function checkFlag(entityWhen: EntityWhen, isSearchMainEntity: boolean | undefined): boolean {
    return entityWhen == "Always" || entityWhen == (isSearchMainEntity ? "IsSearch" : "IsLine");
  }

  // ---- isReadOnly ----
  export interface IsReadonlyOptions { ignoreTypeIsReadonly?: boolean; isEmbedded?: boolean; }
  export const isReadonlyEvent: Array<(typeName: string, entity?: EntityPack<BaseEntity>, options?: IsReadonlyOptions) => boolean> = [];

  export function isReadOnly(typeOrEntity: PseudoType | EntityPack<BaseEntity>, options?: IsReadonlyOptions): boolean {
    const entityPack = isEntityPack(typeOrEntity) ? typeOrEntity : undefined;
    const typeName = isEntityPack(typeOrEntity) ? getTypeName(typeOrEntity.entity) : getTypeName(typeOrEntity as PseudoType);
    if (!options?.ignoreTypeIsReadonly && typeIsReadOnly(typeName, options?.isEmbedded))
      return true;
    return isReadonlyEvent.some(f => f(typeName, entityPack, options));
  }

  function typeIsReadOnly(typeName: string, isEmbedded: boolean | undefined): boolean {
    const es = entitySettings[typeName];
    if (es?.isReadOnly != undefined) return es.isReadOnly;
    if (isEmbedded) return false;
    const ti = tryGetTypeInfo(typeName);
    if (ti == undefined) return true;
    if (ti.kind == "Enum") return true;
    switch (ti.entityKind) {
      case "SystemString": case "System": case "Relational": return true;
      default: return false;
    }
  }

  export function typeRequiresSaveOperation(typeName: string): boolean {
    const ti = tryGetTypeInfo(typeName);
    if (ti == undefined) return false;
    switch (ti.entityKind) {
      case "Part": case "SharedPart": return false;
      case "SystemString": case "System": case "Relational": case "String": case "Shared": case "Main": return true;
      default: return false;
    }
  }

  // ---- isCreable ----
  export interface IsCreableOptions { customComponent?: boolean; isSearch?: boolean; isEmbedded?: boolean; }
  export const isCreableEvent: Array<(typeName: string, options: IsCreableOptions | undefined) => boolean> = [];

  export function isCreable(type: PseudoType, options?: IsCreableOptions): boolean {
    const typeName = getTypeName(type);
    if (!checkFlag(typeIsCreable(typeName, options?.isEmbedded), options?.isSearch))
      return false;
    if (!(options?.customComponent || hasDefaultView(typeName)))
      return false;
    if (!hasAllowedConstructor(typeName))
      return false;
    return isCreableEvent.every(c => c(typeName, options));
  }

  function hasAllowedConstructor(typeName: string): boolean {
    const ti = tryGetTypeInfo(typeName);
    if (ti == undefined || ti.operations == undefined) return true;
    if (!ti.hasConstructorOperation) return true;
    return Dic.getValues(ti.operations).some(oi => (oi as { operationType: string }).operationType == "Constructor");
  }

  function typeIsCreable(typeName: string, isEmbedded?: boolean): EntityWhen {
    const es = entitySettings[typeName];
    if (es?.isCreable != undefined) return es.isCreable;
    if (isEmbedded) return "IsLine";
    const ti = tryGetTypeInfo(typeName);
    if (ti == null) return "Never";
    if (ti.kind == "Enum") return "Never";
    switch (ti.entityKind) {
      case "SystemString": case "System": case "Relational": return "Never";
      case "String": return "IsSearch";
      case "Shared": return "Always";
      case "Main": return "IsSearch";
      case "Part": case "SharedPart": return "IsLine";
      default: return "Never";
    }
  }

  // ---- isViewable ----
  export interface IsViewableOptions { customComponent?: boolean; isSearch?: "main" | "related"; isEmbedded?: boolean; }
  export const isViewableEvent: Array<(typeName: string, entityPack: EntityPack<BaseEntity> | Lite<Entity> | undefined, options: IsViewableOptions | undefined) => boolean> = [];

  export function isViewable(typeOrEntity: PseudoType | EntityPack<BaseEntity> | Lite<Entity>, options?: IsViewableOptions): boolean {
    const entity = isEntityPack(typeOrEntity) ? typeOrEntity : typeOrEntity instanceof Lite ? typeOrEntity : undefined;
    const typeName = isEntityPack(typeOrEntity) ? getTypeName(typeOrEntity.entity) :
      typeOrEntity instanceof Lite ? getTypeName(typeOrEntity) : getTypeName(typeOrEntity as PseudoType);
    if (!checkFlag(typeIsViewable(typeName, options?.isEmbedded), options?.isSearch == "main"))
      return false;
    if (!(options?.customComponent || hasDefaultView(typeName)))
      return false;
    const es = entitySettings[typeName];
    if (es != null && entity instanceof Lite && es.isViewableLite && !es.isViewableLite(entity, options))
      return false;
    if (es != null && isEntityPack(entity) && es.isViewableEntityPack && !es.isViewableEntityPack(entity, options))
      return false;
    return isViewableEvent.every(f => f(typeName, entity, options));
  }

  function typeIsViewable(typeName: string, isEmbedded: boolean | undefined): EntityWhen {
    const es = entitySettings[typeName];
    if (es?.isViewable != undefined) return es.isViewable;
    if (isEmbedded) return "IsLine";
    const ti = tryGetTypeInfo(typeName);
    if (ti == null) return "Never";
    if (ti.kind == "Enum") return "Never";
    switch (ti.entityKind) {
      case "SystemString": return "Never";
      case "System": return "Always";
      case "Relational": return "Never";
      case "String": return "IsSearch";
      case "Shared": case "Main": case "Part": case "SharedPart": return "Always";
      default: return "Never";
    }
  }

  // ---- navigateRoute (uses getSettings) ----
  export function navigateRoute(entity: Entity, viewName?: string): string;
  export function navigateRoute(lite: Lite<Entity>, viewName?: string): string;
  export function navigateRoute(entityOrLite: Entity | Lite<Entity>, viewName?: string): string {
    let typeName: string;
    let id: number | string | undefined;
    if (entityOrLite instanceof Entity) { typeName = getTypeName(entityOrLite); id = entityOrLite.id; }
    else if (entityOrLite instanceof Lite) { typeName = getTypeName(entityOrLite); id = entityOrLite.id; }
    else throw new Error("Entity or Lite expected");
    if (id == null) throw new Error("No Id");
    const es = getSettings(typeName);
    return es?.onNavigateRoute ? es.onNavigateRoute(typeName, id!, viewName) : navigateRouteDefault(typeName, id!, viewName);
  }

  // ---- isFindable (Finder is ported) ----
  export interface IsFindableOptions { fullScreenSearch?: boolean; isEmbeddedEntity?: boolean; }

  export function isFindable(type: PseudoType, options?: IsFindableOptions): boolean {
    const typeName = getTypeName(type);
    return typeIsFindable(typeName, options?.isEmbeddedEntity) && Finder.isFindable(typeName, options?.fullScreenSearch ?? true);
  }

  function typeIsFindable(typeName: string, isEmbeddedEntity: boolean | undefined): boolean {
    const es = entitySettings[typeName];
    if (es?.isFindable != undefined) return es.isFindable;
    if (isEmbeddedEntity) return false;
    const ti = tryGetTypeInfo(typeName);
    if (ti == null) return false;
    if (ti.kind == "Enum") return true;
    switch (ti.entityKind) {
      case "SystemString": case "System": return true;
      case "Relational": return false;
      case "String": case "Shared": case "Main": case "SharedPart": return true;
      case "Part": return false;
      default: return false;
    }
  }

  // ---- render lite / entity (display). ModifiableEntity→BaseEntity; idioms swept. ----
  export function renderLiteOrEntity(entity: Lite<Entity> | Entity | BaseEntity, modelType?: string): string | React.ReactElement | undefined {
    if (entity instanceof Lite)
      return renderLite(entity);

    if (entity instanceof Entity) {
      var es = entitySettings[getTypeName(entity)];
      if (es?.renderEntity)
        return es.renderEntity(entity, new TextHighlighter(undefined));
      if (es?.renderLite) {
        var lite = entity.toLite(entity.isNew);
        return es.renderLite(lite, new TextHighlighter(undefined));
      }
      return entity.toString();
    }
  }

  export function renderLite(lite: Lite<Entity>, hl?: TextHighlighter): React.ReactElement | string {
    var es = entitySettings[getTypeName(lite)];
    if (es?.renderLite != null)
      return es.renderLite(lite, hl ?? new TextHighlighter(undefined));

    var toStr = lite.toString();
    return hl == null ? toStr : hl.highlight(toStr);
  }

  export function renderEntity(entity: BaseEntity): React.ReactElement | string {
    var es = entitySettings[getTypeName(entity)];
    if (es?.renderEntity != null)
      return es.renderEntity(entity, new TextHighlighter(undefined));

    if ((entity as Entity).isNew) {
      var ti = tryGetTypeInfo(getTypeName(entity));
      if (ti)
        return ti.getNiceName(); // TODO(port): FrameMessage.New0_G gender-formatted "New {0}"
    }
    return entity.toString();
  }

  // ---- defaultFindOptions (from a query column's RuntimeType, or a bare type name) ----
  // ALTEA: overloaded to also accept a type NAME string — the Lines layer (EntityBase) carries a
  // FieldInfo (whose `.typeName` is a plain name), not a query-column RuntimeType. Signum's single
  // TypeReference covered both; here the string form is the field-line path.
  export function defaultFindOptions(type: RuntimeType): FindOptions | undefined;
  export function defaultFindOptions(typeName: string): FindOptions | undefined;
  export function defaultFindOptions(type: RuntimeType | string): FindOptions | undefined {
    const typeName = typeof type == "string" ? type : runtimeTypeName(type);
    if ((typeof type != "string" && isRuntimeEmbedded(type)) || typeName == IsByAll)
      return undefined;
    // TODO(port): polymorphic @implementedBy uses the FIRST impl only (runtimeTypeName gives one name).
    return getSettings(typeName)?.defaultFindOptions;
  }

  // ---- entity autocomplete (AutoCompleteConfig; Finder query APIs + Typeahead) ----
  export function getAutoComplete(type: RuntimeType, findOptions: FindOptions | undefined, findOptionsDictionary: { [typeName: string]: FindOptions } | undefined, ctx: TypeContext<any>, create: boolean, showType?: boolean): AutocompleteConfig<any> | null {
    if (isRuntimeEmbedded(type) || runtimeTypeName(type) == IsByAll)
      return null;

    let types = tryGetTypeInfos(runtimeTypeName(type)).notNull();
    showType ??= types.length > 1;

    types = types.filter(t => isFindable(cleanTypeName(t.ctor!), { fullScreenSearch: false }));

    if (types.length == 0)
      return null;

    if (types.length == 1 || findOptions != null)
      return getAutoCompleteBasic(types[0], findOptions, ctx, create, showType);

    return new MultiAutoCompleteConfig(types.toObject(t => cleanTypeName(t.ctor!),
      t => getAutoCompleteBasic(t, (findOptionsDictionary && findOptionsDictionary[cleanTypeName(t.ctor!)]), ctx, create, showType!)
    ));
  }

  export function getAutoCompleteBasic(type: TypeInfo, findOptions: FindOptions | undefined, ctx: TypeContext<any>, create: boolean, showType: boolean): AutocompleteConfig<any> {
    const typeName = cleanTypeName(type.ctor!);
    var s = getSettings(typeName);

    if (s?.autocomplete != null) {
      var acc = s.autocomplete(findOptions, showType);
      if (acc != null)
        return acc;
    }

    var fo = findOptions ?? s?.defaultFindOptions ?? { queryName: typeName };

    return new FindOptionsAutocompleteConfig(fo, {
      showType: showType,
      itemsDelay: s?.autocompleteDelay,
      getAutocompleteConstructor: (subStr, rows) => getAutocompleteConstructors(type, subStr, { ctx, foundLites: rows.map(a => a.entity!), findOptions, create: create }),
    });
  }

  // ALTEA: takes a single TypeInfo (Signum took a RuntimeType then re-resolved via getTypeInfos).
  // `view(a)` is currently a STUB, so the "create new" onClick throws until Frames land — acceptable
  // (autocomplete search itself works).
  export function getAutocompleteConstructors(ti: TypeInfo, str: string, aac: AutocompleteConstructorContext): AutocompleteConstructor<Entity>[] {
    const typeName = cleanTypeName(ti.ctor!);
    const es = getSettings(typeName);
    if (es?.autocompleteConstructor == null)
      return [];

    const ac = es.autocompleteConstructor;
    if (typeof ac == "string")
      return [softCast<AutocompleteConstructor<Entity>>({
        type: typeName,
        onClick: () => Constructor.construct(typeName, { [ac]: str }).then(a => a && view(a as Entity)),
      })];

    if (typeof ac == "function") {
      const r = ac(str, aac);
      return r ? [r as AutocompleteConstructor<Entity>] : [];
    }
    return [];
  }

  // ---- view promise (ViewPromise from ./EntitySettings; overrides are a no-op until Frames land) ----
  export function getViewPromise<T extends BaseEntity>(entity: T, viewName?: string): ViewPromise<T> {
    const typeName = getTypeName(entity);
    const es = getSettings(typeName) as EntitySettings<T> | undefined;
    if (!es)
      throw new Error(`No EntitySettings registered for '${typeName}'`);

    if (viewName == undefined) {
      if (!es.getViewPromise)
        throw new Error(`The EntitySettings registered for '${typeName}' has no getViewPromise`);
      return es.getViewPromise(entity).applyViewOverrides(typeName);
    } else {
      var nv = es.namedViews && es.namedViews[viewName];
      if (!nv?.getViewPromise)
        throw new Error(`The EntitySettings registered for '${typeName}' has no namedView '${viewName}'`);
      return nv.getViewPromise(entity).applyViewOverrides(typeName, viewName);
    }
  }

  // ---- view (STUB: opens a FrameModal — the Frames view-render layer is not ported yet) ----
  export type ViewButtons = "ok_cancel" | "close" | undefined;

  export interface ViewOptions<T extends BaseEntity> {
    title?: React.ReactNode | null;
    subTitle?: React.ReactNode | null;
    propertyRoute?: PropertyRoute;
    readOnly?: boolean;
    modalSize?: BsSize;
    validate?: boolean;
    requiresSaveOperation?: boolean;
    avoidPromptLoseChange?: boolean;
    buttons?: ViewButtons;
    getViewPromise?: (entity: T) => undefined | string | ViewPromise<T>;
    createNew?: () => Promise<EntityPack<T> | undefined>;
    allowExchangeEntity?: boolean;
    extraProps?: {};
  }

  export function view<T extends BaseEntity>(entityOrPack: Lite<T & Entity> | T | EntityPack<T>, viewOptions?: ViewOptions<T>): Promise<T | undefined> {
    throw new Error("TODO(port): Navigator.view — the Frames view-render layer (FrameModal) is not ported yet");
  }
}


/* ===== TODO PORT — EntitySettings / ViewPromise / view-registration (needs ViewReplacer,
   Modals, Lines, Components, and the types blob). Uncomment as those land. =====
export interface EnumConverter<T> {
  enumToEntity: { [enumValue: string]: EnumEntity<T> };
  idToEnum: { [id: string]: T };
}


export interface EntitySettingsOptions<T extends ModifiableEntity> {
  isCreable?: EntityWhen;
  isCreableByFilterProps?: (props: Partial<T>) => boolean; 
  isFindable?: boolean;
  isViewable?: EntityWhen;
  isViewableLite?: (lite: Lite<T & Entity>, options: Navigator.IsViewableOptions | undefined) => boolean;
  isViewableEntityPack?: (entityPack: EntityPack<T>, options: Navigator.IsViewableOptions | undefined) => boolean;
  isReadOnly?: boolean;
  avoidPopup?: boolean;
  supportsAdditionalTabs?: boolean;

  hideId?: boolean;

  allowWrapEntityLink?: boolean;
  avoidFillSearchColumnWidth?: boolean;

  modalSize?: BsSize;
  modalMaxWidth?: boolean;
  modalDialogClass?: string;
  modalFullScreen?: boolean;

  stickyHeader?: boolean;


  renderSubTitle?: (entity: T) => React.ReactNode;

  autocomplete?: (fo: FindOptions | undefined, showType: boolean) => AutocompleteConfig<any> | undefined | null;
  autocompleteDelay?: number;
  autocompleteConstructor?: (keyof T) | ((str: string, aac: AutocompleteConstructorContext) => AutocompleteConstructor<T> | null);
  defaultFindOptions?: FindOptions;

  getViewPromise?: (entity: T) => ViewPromise<T>;
  onNavigateRoute?: (typeName: string, id: string | number) => string;
  onView?: (entityOrPack: Lite<Entity & T> | T | EntityPack<T>, viewOptions?: Navigator.ViewOptions<T>) => Promise<T | undefined>;
  onCreateNew?: (oldEntity: EntityPack<T>) => (Promise<EntityPack<T> | undefined>) | undefined; // Save An New

  renderLite?: (lite: Lite<T & Entity>, hl: TextHighlighter) => React.ReactElement | string;
  renderEntity?: (entity: T, hl: TextHighlighter) => React.ReactElement | string; 
  extraToolbarButtons?: (ctx: ButtonsContext) => (ButtonBarElement | undefined)[];
  enforceFocusInModal?: boolean;

  namedViews?: NamedViewSettings<T>[];

  showContextualSearchBox?: (ctx: ContextualItemsContext<Entity>, blocks?: MenuItemBlock[]) => boolean
}

export interface AutocompleteConstructorContext {
  ctx: TypeContext<any>;
  foundLites: Lite<Entity>[];
  findOptions?: FindOptions;
  create: boolean;
}

export interface ViewOverride<T extends ModifiableEntity> {
  viewName?: string;
  override: (replacer: ViewReplacer<T>) => void;
}

export interface AutocompleteConstructor<T extends ModifiableEntity> {
  type: PseudoType;
  onClick: () => Promise<T | Lite<T & Entity> | undefined>;
  customElement?: React.ReactNode;
}

export class EntitySettings<T extends ModifiableEntity> {
  typeName: string;

  getViewPromise?: (entity: T) => ViewPromise<T>;

  viewOverrides?: Array<ViewOverride<T>>;

  isCreable?: EntityWhen;
  isCreableByFilterProps?: (props: Partial<T>) => boolean; 
  isFindable?: boolean;
  isViewable?: EntityWhen;
  isViewableLite?: (lite: Lite<T & Entity>, options: Navigator.IsViewableOptions | undefined) => boolean;
  isViewableEntityPack?: (entityPack: EntityPack<T>, options: Navigator.IsViewableOptions | undefined) => boolean;
  isReadOnly?: boolean;
  avoidPopup!: boolean;
  supportsAdditionalTabs?: boolean;

  hideId?: boolean;

  allowWrapEntityLink?: boolean;
  avoidFillSearchColumnWidth?: boolean;

  modalSize?: BsSize;
  modalMaxWidth?: boolean;
  modalDialogClass?: string;
  modalFullScreen?: boolean;

  stickyHeader?: boolean;

  renderSubTitle?: (entity: T) => React.ReactNode;

  autocomplete?: (fo: FindOptions | undefined, showType: boolean) => AutocompleteConfig<any> | undefined | null;
  autocompleteDelay?: number;
  autocompleteConstructor?: (keyof T) | ((str: string, aac: AutocompleteConstructorContext) => AutocompleteConstructor<T> | null);
  defaultFindOptions?: FindOptions;

  onView?: (entityOrPack: Lite<Entity & T> | T | EntityPack<T>, viewOptions?: Navigator.ViewOptions<T>) => Promise<T | undefined>;
  onNavigateRoute?: (typeName: string, id: string | number, viewName?: string) => string;

  namedViews?: { [viewName: string]: NamedViewSettings<T> };
  overrideView(override: (replacer: ViewReplacer<T>) => void, viewName?: string): void {
    if (this.viewOverrides == undefined)
      this.viewOverrides = [];

    this.viewOverrides.push({ override, viewName });
  }

  renderLite?: (lite: Lite<T & Entity>, hl: TextHighlighter) => React.ReactElement | string; 
  renderEntity?: (entity: T, hl: TextHighlighter) => React.ReactElement | string; 
  extraToolbarButtons?: (ctx: ButtonsContext) => (ButtonBarElement | undefined)[];
  enforceFocusInModal?: boolean;

  showContextualSearchBox = (ctx: any, blocks?: MenuItemBlock[]) : boolean => Boolean(blocks && blocks.notNull().sum(b => b.menuItems?.length) > 20);

  constructor(type: Type<T> | string, getViewModule?: (entity: T) => Promise<ViewModule<T>>, options?: EntitySettingsOptions<T>) {

    this.typeName = (type as Type<T>).typeName ?? type as string;
    this.getViewPromise = getViewModule && (entity => new ViewPromise(getViewModule(entity)));

    if (options) {
      var { namedViews, ...rest } = options;
      Dic.assign(this, rest);

      if (namedViews != null)
        this.namedViews = namedViews.toObject(a => a.viewName);
    }
  }

  registerNamedView(settings: NamedViewSettings<T>): void {
    if (!this.namedViews)
      this.namedViews = {};

    this.namedViews[settings.viewName] = settings;
  }
}

interface NamedViewSettingsOptions<T extends ModifiableEntity> {
  getViewPromise?: (entity: T) => ViewPromise<T>;
}

export class NamedViewSettings<T extends ModifiableEntity> {
  type: Type<T>

  viewName: string;

  getViewPromise: (entity: T) => ViewPromise<T>;

  constructor(type: Type<T>, viewName: string, getViewModule?: (entity: T) => Promise<ViewModule<T>>, options?: NamedViewSettingsOptions<T>) {
    this.type = type;
    this.viewName = viewName;
    var getViewPromise = (getViewModule && ((entity: T) => new ViewPromise(getViewModule(entity)))) || (options?.getViewPromise);
    if (!getViewPromise)
      throw new Error("setting getViewModule or options.getViewPromise arguments is mandatory");
    this.getViewPromise = getViewPromise;
    Dic.assign(this, options)
  }
}

export type ViewModule<T extends ModifiableEntity> = { default: React.ComponentClass<any> | React.FunctionComponent<any> };

export class ViewPromise<T extends ModifiableEntity> {
  promise!: Promise<(ctx: TypeContext<T>) => React.ReactElement>;

  constructor(promise?: Promise<ViewModule<T>>) {
    if (promise)
      this.promise = promise
        .then(mod => {
          return (ctx: TypeContext<T>): React.ReactElement => React.createElement(mod.default, { ctx });
        });
  }

  static resolve<T extends ModifiableEntity>(getComponent: (ctx: TypeContext<T>) => React.ReactElement): ViewPromise<T> {
    var result = new ViewPromise<T>();
    result.promise = Promise.resolve(getComponent);
    return result;
  }

  withProps<P>(props: Partial<P>): ViewPromise<T> {

    var result = new ViewPromise<T>();

    result.promise = this.promise.then(func => {
      return (ctx: TypeContext<T>): React.ReactElement => {
        var result = func(ctx);
        return React.cloneElement(result, { ...props });
      };
    });

    return result;
  }

  applyViewOverrides(typeName: string, viewName?: string): ViewPromise<T> {
    this.promise = this.promise.then(func =>
      Navigator.getViewDispatcher().getViewOverrides(typeName, viewName).then(vos => {

        if (vos.length == 0)
          return func;

        return (ctx: TypeContext<T>) => {
          var result = func(ctx);
          var component = result.type as React.ComponentClass<{ ctx: TypeContext<T> }> | React.FunctionComponent<{ ctx: TypeContext<T> }>;
          if (component.prototype.render) {
            monkeyPatchClassComponent<T>(component as React.ComponentClass<{ ctx: TypeContext<T> }>, vos!);
            return result;
          } else {
            var newFunc = ViewPromise.surroundFunctionComponent(component as React.FunctionComponent<{ ctx: TypeContext<T> }>, vos)
            return React.createElement(newFunc, result.props as any);
          }
        };
      }));

    return this;
  }

  static flat<T extends ModifiableEntity>(promise: Promise<ViewPromise<T>>): ViewPromise<T> {
    var result = new ViewPromise<T>();
    result.promise = promise.then(vp => vp.promise);
    return result;
  }

  static surroundFunctionComponent<T extends ModifiableEntity>(functionComponent: React.FunctionComponent<{ ctx: TypeContext<T> }>, viewOverrides: ViewOverride<T>[]): React.FunctionComponent<{ ctx: TypeContext<T> }> {

    var cache = (functionComponent as any).cache as FunctionCache<T>;

    if (cache) {
      if (cache.viewOverrides.every((vo, i) => viewOverrides[i] == vo))
        return cache.overridenView;
      else {
        (functionComponent as any).cache = null;
      }
    }

    var result = function NewComponent(props: { ctx: TypeContext<T> }) {
      var view = functionComponent(props);

      const replacer = new ViewReplacer<T>(view! as React.ReactElement, props.ctx, functionComponent);
      viewOverrides.forEach(vo => vo.override(replacer));
      return replacer.result;
    };

    Object.defineProperty(result, "name", { value: functionComponent.name + "VO" });

    (functionComponent as any).cache = softCast<FunctionCache<T>>({
      overridenView: result,
      viewOverrides: viewOverrides,
    });

    return result;
  }

}

function monkeyPatchClassComponent<T extends ModifiableEntity>(component: React.ComponentClass<{ ctx: TypeContext<T> }>, viewOverrides: ViewOverride<T>[]) {

  if (!component.prototype.render)
    throw new Error("render function not defined in " + component);

  if (component.prototype.render.withViewOverrides)
    return;

  const baseRender = component.prototype.render as (this: React.Component<any>) => React.ReactElement;

  component.prototype.render = function (this: React.Component<any, any>) {

    const ctx = this.props.ctx;

    const view = baseRender.call(this);

    const replacer = new ViewReplacer<T>(view!, ctx, component);
    viewOverrides.forEach(vo => vo.override(replacer));
    return replacer.result;
  };

  component.prototype.render.withViewOverrides = true;
}

interface FunctionCache<T extends ModifiableEntity>  {
  overridenView: React.FunctionComponent<{ ctx: TypeContext<T> }>,
  viewOverrides: ViewOverride<T>[]
}


export type EntityWhen = "Always" | "IsSearch" | "IsLine" | "Never";
===== end TODO PORT ===== */



