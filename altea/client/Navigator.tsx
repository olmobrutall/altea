// Ported from Signum.React/Navigator.tsx (copied verbatim + staged, then fixed for altea).
// MOST of this file is commented out below: it depends on the reflection types blob
// (TypeInfo.niceName/kind/entityKind/operations/gender/members) and on modules not yet ported
// (Finder, Operations, Constructor, Frames/*, Lines/*, Components/*, Modals/*, Hooks,
// SearchControl, EntitySettings/ViewPromise/ViewReplacer). Only the API namespace (the entity HTTP
// client) is ported and ACTIVE. Uncomment each region as its dependencies land.

// --- Active altea imports (what the ported / activated code needs) ---
import * as React from "react";
import type { RouteObject } from 'react-router';
import { ImportComponent } from './ImportComponent';
import { ajaxGet, ajaxPost } from './Services';
import { toAbsoluteUrl, navigate } from './AppContext';
import { getTypeName, tryGetTypeInfo, getOperationInfos, getKindOfType } from './Reflection';
import type { PseudoType } from './Reflection';
import type { Type } from '../data/entity';
import { Dic } from '../data/globals';
import { Entity, BaseEntity } from '../data/entity';
import { Lite } from '../data/lite';
import type { EntityPack } from '../data/entityPack';
import type { EntityFrame } from './TypeContext';
import { useAPI, useAPIWithReload, useForceUpdate } from './Hooks';
import type { APIHookOptions } from './Hooks';
import { Serializer } from '../data/serializer';
// Staged Navigator activation (entity-nav): the FULL EntitySettings/ViewPromise live in ./EntitySettings
// (view-override machinery stubbed). Navigator's earlier MINIMAL inline EntitySettings is replaced by this.
import { EntitySettings } from './EntitySettings';
import type { EntityWhen, AutocompleteConstructor, AutocompleteConstructorContext, ViewOverride } from './EntitySettings';
import { ViewPromise } from './EntitySettings';
import { Finder } from './Finder';
import { Constructor } from './Constructor';
import { TextHighlighter } from './Components/Typeahead';
import { IsByAll } from './Reflection';
import { TypeInfo, TypeReference } from '../data/reflection';
import type { PropertyRoute } from '../data/propertyRoute';
import { EmbeddedEntity } from '../data/entity';
import { cleanTypeName } from '../data/registration';
import { softCast } from '../data/globals';
import type { FindOptions } from './FindOptions';
import type { BsSize } from './Components';
import type { TypeContext } from './TypeContext';
import { FindOptionsAutocompleteConfig, MultiAutoCompleteConfig } from './Lines/AutoCompleteConfig';
import type { AutocompleteConfig } from './Lines/AutoCompleteConfig';
import CopyLiteButton from './Components/CopyLiteButton';
import CopyLinkButton from './Components/CopyLinkButton';
import type { TypeEntity } from "../data/typeEntity";
import * as AppContext from './AppContext';
/* ===== Original Signum imports — rewire to altea modules as they are ported =====
import * as React from "react"
import { RouteObject } from 'react-router'
import { Dic, classes, softCast, } from './Globals';                          // -> ../entities/globals
import { ajaxGet, ajaxPost, clearContextHeaders } from './Services';
import { Lite, Entity, ModifiableEntity, EntityPack, isEntity, isLite, isEntityPack, toLite, liteKey, FrameMessage, ModelEntity, getToString, isModifiableEntity, EnumEntity, SearchMessage } from './Signum.Entities'; // -> ../entities/*, .is()/.toString()/.key()
import { ExceptionEntity } from './Signum.Basics';
import { PropertyRoute, PseudoType, Type, getTypeInfo, tryGetTypeInfos, getTypeName, isTypeModel, OperationType, runtimeTypeName, isRuntimeEmbedded, IsByAll, isTypeEntity, tryGetTypeInfo, getTypeInfos, newLite, TypeInfo, EnumType } from './Reflection';
import type { RuntimeType } from './runtimeTypes';
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

// altea: Navigator's per-user client state slice. Signum keeps `entitySettings` as a module-level var
// reset through `AppContext.clearSettingsActions`; altea stores it in `AppContext.clientState` (see
// IClientState), the same call Finder makes, so a single `newClientState()` resets every module at once.
interface NavigatorClientState {
  entitySettings: { [type: string]: EntitySettings };
}
declare module "./AppContext" {
  interface IClientState {
    navigator?: NavigatorClientState;
    navReadonlyEvent?: Array<(typeName: string, entity?: EntityPack<BaseEntity>, options?: Navigator.IsReadonlyOptions) => boolean>;
    navCreableEvent?: Array<(typeName: string, options: Navigator.IsCreableOptions | undefined) => boolean>;
    navViewableEvent?: Array<(typeName: string, entityPack: EntityPack<BaseEntity> | Lite<Entity> | undefined, options: Navigator.IsViewableOptions | undefined) => boolean>;
  }
}

export namespace Navigator {

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
    // A `Type<T>` is a CONSTRUCTOR in altea, so `.toString()` is its SOURCE TEXT — which never matches the
    // clean name `useEntityChanged` registered under, so a raise passing a type silently notified nobody.
    // (Signum's argument is a string type name, so its `.toString()` is correct there.) The first consumer
    // to hit it was @altea/altea-whats-new's news page raising WhatsNewLogEntity to refresh the navbar badge.
    var cleanName = typeof typeOrEntity === "string" ? typeOrEntity : getTypeName(typeOrEntity);
    var entity = typeOrEntity instanceof Entity ? typeOrEntity : undefined;

    entityChanged[cleanName]?.forEach(func => func(cleanName, entity, isRedirect));
  }

  /* ============================ TODO PORT — swappable default sub-title renderer (Signum's
     defaultRenderSubTitle / setDefaultRenderTitleFunction). The active getTypeSubTitle inlines the
     rendering; port this hook if an app needs to override sub-titles globally. ============================
  let defaultRenderSubTitle = (typeInfo: TypeInfo, entity: ModifiableEntity): React.ReactElement | null => {
    return <span>{typeInfo.niceName} {renderId(entity as Entity)}</span>;
  }

  export function setDefaultRenderTitleFunction(newFunction: (typeInfo: TypeInfo, entity: ModifiableEntity) => React.ReactElement | null): void {
    defaultRenderSubTitle = newFunction;
  }
  ============================ end TODO PORT ============================ */

  // ===== ACTIVE: default URL builders (blob-independent). =====
  export function navigateRouteDefault(typeName: string, id: number | string, viewName?: string): string {
    return "/view/" + typeName.firstLower() + "/" + id + (viewName ? "?viewName=" + viewName : "");

  }

  export function createRoute(type: PseudoType, viewName?: string): string {
    return "/create/" + getTypeName(type) + (viewName ? "?viewName=" + viewName : "");
  }

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

  /* ============================ TODO PORT — custom Lite models + enum-entity map. Needs server routes
     /api/liteModels and /api/reflection/enumEntities (plus newLite); useLiteToString / useFillToString
     hang off fillLiteModels. ============================
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
  // fillLiteModels/custom-lite models, getEnumEntities (need reflection endpoints). getType is now ACTIVE
  // below (served by reflectionServer's /api/reflection/typeEntity/:typeName).
  export namespace API {

    // GET an entity graph — ajaxGet already rebuilds the real class instances via Serializer.parse.
    function getEntity<T>(url: string): Promise<T> {
      return ajaxGet<T>({ url });
    }

    // POST an entity — ajaxPost already Serializer-encodes the body (real graph → wire) and decodes the
    // response (rebuilds any returned entity graph).
    function postEntity<T>(url: string, entity: unknown): Promise<T> {
      return ajaxPost<T>({ url }, entity);
    }

    // GET an EntityPack: the envelope is JSON and its `entity` field is an entity graph — ajaxGet's
    // Serializer.parse revives the nested { $type } entity and leaves `canExecute` plain.
    function getEntityPack<T extends Entity>(url: string): Promise<EntityPack<T>> {
      return ajaxGet<EntityPack<T>>({ url });
    }

    // The persisted TypeEntity row for a (clean) type name (Signum's Navigator.API.getType). Served by
    // reflectionServer's /api/reflection/typeEntity/:typeName; ajaxGet revives the real TypeEntity (or null
    // when the type is unknown). Used e.g. by the chart ColorPalette link to pre-scope a new palette.
    export function getType(typeName: string): Promise<TypeEntity | null> {
      return ajaxGet({ url: `/api/reflection/typeEntity/${typeName}` });
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

  // Lazily initialise + return Navigator's slice of the per-user client state. Signum keeps its
  // EntitySettings in a module-level dictionary reset through `AppContext.clearSettingsActions`; altea has
  // no such registry, so the dictionary lives in `AppContext.clientState` (see IClientState) and ONE
  // `newClientState()` drops it — which is what lets a host re-run its full registration bundle on a
  // credential change, exactly as Signum's `clearAllSettings()` + `startFull(routes)` does.
  function state(): NavigatorClientState {
    return AppContext.clientState.navigator ??= { entitySettings: {} };
  }

  /** The registered EntitySettings, keyed by clean type name (stored in AppContext.clientState). */
  export function entitySettings(): { [type: string]: EntitySettings } {
    return state().entitySettings;
  }

  export function clearEntitySettings(): void {
    state().entitySettings = {};
  }

  export function addSettings(...settings: EntitySettings[]): void {
    settings.forEach(s => Dic.addOrThrow(state().entitySettings, s.typeName, s));
  }

  export function getOrAddSettings<T extends BaseEntity>(type: Type<T>): EntitySettings<T>;
  export function getOrAddSettings(type: PseudoType): EntitySettings;
  export function getOrAddSettings(type: PseudoType): EntitySettings {
    const typeName = getTypeName(type);
    const es = state().entitySettings;
    return es[typeName] || (es[typeName] = new EntitySettings(typeName));
  }

  export function getSettings<T extends BaseEntity>(type: Type<T>): EntitySettings<T> | undefined;
  export function getSettings(type: PseudoType): EntitySettings | undefined;
  export function getSettings(type: PseudoType): EntitySettings | undefined {
    return state().entitySettings[getTypeName(type)];
  }

  function isEntityPack(x: unknown): x is EntityPack<BaseEntity> {
    // Check `canExecute` (a plain property) BEFORE `.entity`: reading `.entity` on a thin Lite throws
    // ("not loaded"), so a Lite must be rejected here without ever touching its `.entity` getter.
    return x != null && (x as { canExecute?: unknown }).canExecute !== undefined && (x as EntityPack<BaseEntity>).entity != null;
  }

  // ---- ViewDispatcher (Signum's Navigator.ViewDispatcher) --------------------------------------
  // The seam that decides, for a type, WHICH view component renders it — and therefore the one thing a
  // module can replace to serve views that are not compiled into the app. @altea/altea-dynamic installs
  // one that reads a view tree out of the database; everything else uses the Basic one below, whose
  // behaviour is exactly what these four calls did inline before the seam existed.
  export interface ViewDispatcher {
    hasDefaultView(typeName: string): boolean;
    getViewNames(typeName: string): Promise<string[]>;
    getViewPromise<T extends BaseEntity>(entity: T, viewName?: string): ViewPromise<T>;
    getViewOverrides(typeName: string, viewName?: string): Promise<ViewOverride<BaseEntity>[]>;
  }

  export class BasicViewDispatcher implements ViewDispatcher {

    // altea always has a view for a type: with no registered one it AUTO-GENERATES from the property
    // routes (AutoComponent). Signum returns `es?.getViewPromise != null` here, because it has no
    // auto-component and a type with no view really cannot be shown.
    hasDefaultView(_typeName: string): boolean {
      return true;
    }

    getViewNames(typeName: string): Promise<string[]> {
      const es = getSettings(typeName);
      return Promise.resolve(es?.namedViews ? Dic.getKeys(es.namedViews) : []);
    }

    getViewOverrides(typeName: string, viewName?: string): Promise<ViewOverride<BaseEntity>[]> {
      const es = getSettings(typeName);
      return Promise.resolve((es?.viewOverrides ?? []).filter(vo => vo.viewName == viewName) as ViewOverride<BaseEntity>[]);
    }

    getViewPromise<T extends BaseEntity>(entity: T, viewName?: string): ViewPromise<T> {
      const typeName = getTypeName(entity);
      const es = getSettings(typeName) as EntitySettings<T> | undefined;

      if (viewName == undefined) {
        // No registered view → auto-generate one from the entity's property routes (Signum's
        // AutoComponent). The Frame renders whatever component this ViewPromise resolves to.
        if (!es?.getViewPromise)
          return new ViewPromise<T>(import('./AutoComponent')).applyViewOverrides(typeName);
        return es.getViewPromise(entity).applyViewOverrides(typeName);
      } else {
        const nv = es?.namedViews && es.namedViews[viewName];
        if (!nv?.getViewPromise)
          throw new Error(`The EntitySettings registered for '${typeName}' has no namedView '${viewName}'`);
        return nv.getViewPromise(entity).applyViewOverrides(typeName, viewName);
      }
    }
  }

  let viewDispatcher: ViewDispatcher = new BasicViewDispatcher();

  export function getViewDispatcher(): ViewDispatcher { return viewDispatcher; }

  export function setViewDispatcher(vd: ViewDispatcher): void { viewDispatcher = vd; }

  export function hasDefaultView(typeName: string): boolean {
    return viewDispatcher.hasDefaultView(typeName);
  }

  export function getViewNames(typeName: string): Promise<string[]> {
    return viewDispatcher.getViewNames(typeName);
  }

  export function getViewOverrides(typeName: string, viewName?: string): Promise<ViewOverride<BaseEntity>[]> {
    return viewDispatcher.getViewOverrides(typeName, viewName);
  }

  export function checkFlag(entityWhen: EntityWhen, isSearchMainEntity: boolean | undefined): boolean {
    return entityWhen == "Always" || entityWhen == (isSearchMainEntity ? "IsSearch" : "IsLine");
  }

  // ---- isReadOnly ----
  export interface IsReadonlyOptions { ignoreTypeIsReadonly?: boolean; isEmbedded?: boolean; }
  // The three authorization EVENT lists, in clientState for the same reason as entitySettings above:
  // altea-auth pushes its type-rule checks here from `AuthAdminClient.start`, so a second registration run
  // would evaluate each one twice (and, since isCreable/isViewable use `every`, keep answering the same —
  // but isReadonly uses `some`, and a duplicated list is a duplicated cost on every render).
  export function isReadonlyEvent(): Array<(typeName: string, entity?: EntityPack<BaseEntity>, options?: IsReadonlyOptions) => boolean> {
    return AppContext.clientState.navReadonlyEvent ??= [];
  }

  export function isReadOnly(typeOrEntity: PseudoType | EntityPack<BaseEntity>, options?: IsReadonlyOptions): boolean {
    const entityPack = isEntityPack(typeOrEntity) ? typeOrEntity : undefined;
    const typeName = isEntityPack(typeOrEntity) ? getTypeName(typeOrEntity.entity) : getTypeName(typeOrEntity as PseudoType);
    if (!options?.ignoreTypeIsReadonly && typeIsReadOnly(typeName, options?.isEmbedded))
      return true;
    return isReadonlyEvent().some(f => f(typeName, entityPack, options));
  }

  function typeIsReadOnly(typeName: string, isEmbedded: boolean | undefined): boolean {
    const es = state().entitySettings[typeName];
    if (es?.isReadOnly != undefined) return es.isReadOnly;
    if (isEmbedded) return false;
    const ti = tryGetTypeInfo(typeName);
    if (ti == undefined) return true;
    if (getKindOfType(typeName) == "Enum") return true;
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
  export function isCreableEvent(): Array<(typeName: string, options: IsCreableOptions | undefined) => boolean> {
    return AppContext.clientState.navCreableEvent ??= [];
  }

  export function isCreable(type: PseudoType, options?: IsCreableOptions): boolean {
    const typeName = getTypeName(type);
    if (!checkFlag(typeIsCreable(typeName, options?.isEmbedded), options?.isSearch))
      return false;
    if (!(options?.customComponent || hasDefaultView(typeName)))
      return false;
    if (!hasAllowedConstructor(typeName))
      return false;
    return isCreableEvent().every(c => c(typeName, options));
  }

  function hasAllowedConstructor(typeName: string): boolean {
    // Operations now come from the metadata blob (per role) instead of TypeInfo. Same three-step rule as
    // before: no operations reach the client → nothing gates construction; none of them CONSTRUCTS →
    // likewise; otherwise a plain "New" needs a plain Constructor operation the role may actually run.
    const ops = getOperationInfos(typeName);
    if (ops.length == 0) return true;
    if (!ops.some(oi => oi.operationType != "Execute" && oi.operationType != "Delete")) return true;
    return ops.some(oi => oi.operationType == "Constructor");
  }

  function typeIsCreable(typeName: string, isEmbedded?: boolean): EntityWhen {
    const es = state().entitySettings[typeName];
    if (es?.isCreable != undefined) return es.isCreable;
    if (isEmbedded) return "IsLine";
    const ti = tryGetTypeInfo(typeName);
    if (ti == null) return "Never";
    if (getKindOfType(typeName) == "Enum") return "Never";
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
  export function isViewableEvent(): Array<(typeName: string, entityPack: EntityPack<BaseEntity> | Lite<Entity> | undefined, options: IsViewableOptions | undefined) => boolean> {
    return AppContext.clientState.navViewableEvent ??= [];
  }

  export function isViewable(typeOrEntity: PseudoType | EntityPack<BaseEntity> | Lite<Entity>, options?: IsViewableOptions): boolean {
    const entity = isEntityPack(typeOrEntity) ? typeOrEntity : typeOrEntity instanceof Lite ? typeOrEntity : undefined;
    const typeName = isEntityPack(typeOrEntity) ? getTypeName(typeOrEntity.entity) :
      typeOrEntity instanceof Lite ? getTypeName(typeOrEntity) : getTypeName(typeOrEntity as PseudoType);
    if (!checkFlag(typeIsViewable(typeName, options?.isEmbedded), options?.isSearch == "main"))
      return false;
    if (!(options?.customComponent || hasDefaultView(typeName)))
      return false;
    const es = state().entitySettings[typeName];
    if (es != null && entity instanceof Lite && es.isViewableLite && !es.isViewableLite(entity, options))
      return false;
    if (es != null && isEntityPack(entity) && es.isViewableEntityPack && !es.isViewableEntityPack(entity, options))
      return false;
    return isViewableEvent().every(f => f(typeName, entity, options));
  }

  function typeIsViewable(typeName: string, isEmbedded: boolean | undefined): EntityWhen {
    const es = state().entitySettings[typeName];
    if (es?.isViewable != undefined) return es.isViewable;
    if (isEmbedded) return "IsLine";
    const ti = tryGetTypeInfo(typeName);
    if (ti == null) return "Never";
    if (getKindOfType(typeName) == "Enum") return "Never";
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
    const es = state().entitySettings[typeName];
    if (es?.isFindable != undefined) return es.isFindable;
    if (isEmbeddedEntity) return false;
    const ti = tryGetTypeInfo(typeName);
    if (ti == null) return false;
    if (getKindOfType(typeName) == "Enum") return true;
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
      var es = state().entitySettings[getTypeName(entity)];
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
    var es = state().entitySettings[getTypeName(lite)];
    if (es?.renderLite != null)
      return es.renderLite(lite, hl ?? new TextHighlighter(undefined));

    var toStr = lite.toString();
    return hl == null ? toStr : hl.highlight(toStr);
  }

  export function renderEntity(entity: BaseEntity): React.ReactElement | string {
    var es = state().entitySettings[getTypeName(entity)];
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
  export function defaultFindOptions(type: TypeReference): FindOptions | undefined;
  export function defaultFindOptions(typeName: string): FindOptions | undefined;
  export function defaultFindOptions(type: TypeReference | string): FindOptions | undefined {
    if (typeof type != "string" && (type.is(EmbeddedEntity) || type.isByAll()))
      return undefined;
    const typeName = typeof type == "string" ? type : (type.getTypeName() ?? "");
    if (typeName == IsByAll)
      return undefined;
    // TODO(port): polymorphic @implementedBy uses the FIRST impl only (getTypeName gives one name).
    return getSettings(typeName)?.defaultFindOptions;
  }

  // ---- entity autocomplete (AutoCompleteConfig; Finder query APIs + Typeahead) ----
  export function getAutoComplete(type: TypeReference, findOptions: FindOptions | undefined, findOptionsDictionary: { [typeName: string]: FindOptions } | undefined, ctx: TypeContext<any>, create: boolean, showType?: boolean): AutocompleteConfig<any> | null {
    if (type.is(EmbeddedEntity) || type.isByAll())
      return null;

    let types = type.typeInfos();
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

  // ---- view promise — delegated to the installed ViewDispatcher (see BasicViewDispatcher above) ----
  export function getViewPromise<T extends BaseEntity>(entity: T, viewName?: string): ViewPromise<T> {
    return viewDispatcher.getViewPromise(entity, viewName);
  }

  // ---- view — opens a FrameModal (Frames view-render layer). ----
  export function getFrameModal(): Promise<typeof import("./Frames/FrameModal")> {
    return import("./Frames/FrameModal");
  }

  export function getFramePage(): Promise<typeof import("./Frames/FramePage")> {
    return import("./Frames/FramePage");
  }

  // Registers the entity view/create page routes. A client app calls this at bootstrap with its
  // react-router route array. (Signum's full `start` also pushed per-module cache-clear callbacks onto
  // AppContext.clearSettingsActions and wired ErrorModalOptions; altea diverges — module state resets
  // via AppContext.clientState/newClientState and ErrorModal self-wires its exception link — so only
  // the routes remain here.)
  export function start(options: { routes: RouteObject[] }): void {
    options.routes.push({ path: "/view/:type/:id", element: <ImportComponent onImport={() => getFramePage()} /> });
    options.routes.push({ path: "/create/:type", element: <ImportComponent onImport={() => getFramePage()} /> });
  }

  export function onFramePageCreationCancelled(): void {
    navigate("/");
  }

  // Activated for the Operations client layer (Signum's versions live in the commented staging block;
  // altea fixes: lite.EntityType→lite.entityType, getSettings by clean name, window data-transfer cast).
  export function someNonViewable(lites: Lite<Entity>[]): boolean {
    return lites.groupBy(a => a.entityType).some(gr => {
      var isViewable = getSettings(gr.key)?.isViewableLite;
      return Boolean(isViewable) && gr.elements.some(lite => !isViewable!(lite, { isSearch: "main" }));
    });
  }

  export function createInNewTab(pack: EntityPack<Entity>, viewName?: string): void {
    var url = "/create/" + getTypeName(pack.entity) + (viewName ? "?viewName=" + viewName : "") + (viewName ? "&" : "?") + "waitOpenerData=true";
    (window as { dataForChildWindow?: unknown }).dataForChildWindow = pack;
    window.open(toAbsoluteUrl(url));
  }

  // Same as createInNewTab but navigates the CURRENT tab (Signum's Navigator.createInCurrentTab). The
  // target FramePage reads `dataForCurrentWindow` when the "/create" route carries `waitCurrentData`.
  export function createInCurrentTab(pack: EntityPack<Entity>, viewName?: string): void {
    var url = "/create/" + getTypeName(pack.entity) + (viewName ? "?viewName=" + viewName : "") + (viewName ? "&" : "?") + "waitCurrentData=true";
    (window as { dataForCurrentWindow?: unknown }).dataForCurrentWindow = pack;
    navigate(url);
  }

  export function createNavigateOrTab(pack: EntityPack<Entity> | undefined, event: React.MouseEvent<any>): Promise<void> {
    if (!pack || !pack.entity)
      return Promise.resolve();

    const es = getSettings(getTypeName(pack.entity));
    if (es?.avoidPopup || event.ctrlKey || event.button == 1) {
      createInNewTab(pack);
      return Promise.resolve();
    }
    return view(pack, { buttons: "close" }).then(() => undefined);
  }

  export function typeDefaultButtons(typeName: string, isEmbedded: boolean | undefined): ViewButtons {
    if (isEmbedded)
      return "ok_cancel";

    const ti = tryGetTypeInfo(typeName);
    if (ti != null) {
      if (ti.entityKind == undefined || ti.entityKind == "Part" || ti.entityKind == "SharedPart")
        return "ok_cancel";
    }

    return "close";
  }

  // ALTEA: Signum's getTypeSubTitle used entity.Type + isTypeEntity/isTypeModel + defaultRenderSubTitle;
  // altea uses instanceof + getNiceName(). Now also renders the id + copy-lite / copy-link buttons
  // (Signum's defaultRenderSubTitle → renderId), which fade in on hover via the `.sf-hide-id` CSS.
  export function getTypeSubTitle(entity: BaseEntity, pr: PropertyRoute | undefined): React.ReactNode | undefined {
    const es = getSettings(getTypeName(entity));
    if (es?.renderSubTitle)
      return es.renderSubTitle(entity as Entity);

    if (entity instanceof Entity) {
      if (entity.isNew)
        return null;
      const niceName = tryGetTypeInfo(getTypeName(entity))?.getNiceName();
      return <span>{niceName} {renderId(entity)}</span>;
    } else if (entity instanceof EmbeddedEntity) {
      return pr?.type.getTypeName();
    }
    return undefined;
  }

  // Ported from Signum's Navigator.renderId. altea fixes: id field via tryGetTypeInfo(...).members["id"]
  // (real lowercase prop name, not "Id"); the Guid-default hideId reads the primary-key type off the id
  // field's columnOptions (`uuid`/`uuid7`) instead of Signum's TypeReference.name == "Guid".
  let renderId = (entity: Entity): React.ReactElement | string | number => {
    const idField = tryGetTypeInfo(getTypeName(entity))?.members["id"];
    const pk = idField?.columnOptions?.primaryKey;
    const hideId = getSettings(getTypeName(entity))?.hideId ?? (pk == "uuid" || pk == "uuid7");
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
    isOperationVisible?: (eoc: any /*EntityOperationContext*/) => boolean;
    buttons?: ViewButtons;
    getViewPromise?: (entity: T) => undefined | string | ViewPromise<T>;
    createNew?: () => Promise<EntityPack<T> | undefined>;
    allowExchangeEntity?: boolean;
    extraProps?: {};
  }

  // An EntitySettings can override how an entity opens (Signum's Navigator.view → es.onView); otherwise
  // fall back to the default FrameModal (viewDefault).
  export function view<T extends BaseEntity>(entityOrPack: Lite<T & Entity> | T | EntityPack<T>, viewOptions?: ViewOptions<T>): Promise<T | undefined> {
    const typeName = isEntityPack(entityOrPack) ? getTypeName(entityOrPack.entity) : getTypeName(entityOrPack as Lite<Entity> | BaseEntity);
    const es = getSettings(typeName) as EntitySettings<T> | undefined;
    if (es?.onView)
      return es.onView(entityOrPack, viewOptions);
    return viewDefault(entityOrPack, viewOptions);
  }

  export function viewDefault<T extends BaseEntity>(entityOrPack: Lite<T & Entity> | T | EntityPack<T>, viewOptions?: ViewOptions<T>): Promise<T | undefined> {
    return getFrameModal()
      .then(NP => NP.FrameModalManager.openView(entityOrPack, viewOptions ?? {}));
  }
}
