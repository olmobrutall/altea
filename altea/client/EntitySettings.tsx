// Ported from Signum.React/Navigator.tsx's EntitySettings / ViewPromise region — extracted into its
// own module (altea, STAGED). altea fixes:
//   - ModifiableEntity → BaseEntity.
//   - ViewPromise core (constructor / resolve / withProps / flat) is ported, and applyViewOverrides is
//     real: it runs the overrides the Navigator's ViewDispatcher reports through ViewReplacer.
//     surroundFunctionComponent / monkeyPatch are dropped — altea's ViewReplacer rewrites the returned
//     element tree, so a view needs no patching of the component itself.
//   - Type deps not yet ported are stubbed to `any` with TODOs: ViewReplacer (Frames),
//     AutocompleteConfig (AutoCompleteConfig — wired for real when that ports), ContextualItemsContext
//     / MenuItemBlock (SearchControl), Navigator view-option types.
import * as React from 'react';
import { Dic } from '../data/globals';
import { type Type } from '../data/entity';
import type { BaseEntity, Entity } from '../data/entity';
import type { Lite } from '../data/lite';
import type { EntityPack } from '../data/entityPack';
import type { EnumEntity } from '../data/enumEntity';
import type { TypeContext, ButtonsContext, ButtonBarElement } from './TypeContext';
import type { TextHighlighter } from './Components/Typeahead';
import type { BsSize } from './Components';
import type { FindOptions } from './FindOptions';
import type { PseudoType } from './Reflection';

// ViewReplacer is the real Frames class now (re-exported so `import { ViewReplacer } from
// './EntitySettings'` keeps working). ReactVisitor imports only React + TypeContext types → no cycle.
export { ViewReplacer } from './Frames/ReactVisitor';
import { ViewReplacer } from './Frames/ReactVisitor';

// TODO(port): real types land with their modules (AutoCompleteConfig / SearchControl).
type AutocompleteConfig<A> = any;
type ContextualItemsContext<T extends Entity> = any;
type MenuItemBlock = any;

export type EntityWhen = "Always" | "IsSearch" | "IsLine" | "Never";

export interface EnumConverter<T> {
  enumToEntity: { [enumValue: string]: EnumEntity<T> };
  idToEnum: { [id: string]: T };
}

export type ViewModule<T extends BaseEntity> = { default: React.ComponentClass<any> | React.FunctionComponent<any> };

export interface ViewOverride<T extends BaseEntity> {
  viewName?: string;
  override: (replacer: ViewReplacer<T>) => void;
}

export interface AutocompleteConstructorContext {
  ctx: TypeContext<any>;
  foundLites: Lite<Entity>[];
  findOptions?: FindOptions;
  create: boolean;
}

export interface AutocompleteConstructor<T extends BaseEntity> {
  type: PseudoType;
  onClick: () => Promise<T | Lite<T & Entity> | undefined>;
  customElement?: React.ReactNode;
}

export interface EntitySettingsOptions<T extends BaseEntity> {
  isCreable?: EntityWhen;
  isCreableByFilterProps?: (props: Partial<T>) => boolean;
  isFindable?: boolean;
  isViewable?: EntityWhen;
  isViewableLite?: (lite: Lite<T & Entity>, options: any) => boolean;
  isViewableEntityPack?: (entityPack: EntityPack<T>, options: any) => boolean;
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
  onView?: (entityOrPack: Lite<Entity & T> | T | EntityPack<T>, viewOptions?: any) => Promise<T | undefined>;
  onCreateNew?: (oldEntity: EntityPack<T>) => (Promise<EntityPack<T> | undefined>) | undefined;
  renderLite?: (lite: Lite<T & Entity>, hl: TextHighlighter) => React.ReactElement | string;
  renderEntity?: (entity: T, hl: TextHighlighter) => React.ReactElement | string;
  extraToolbarButtons?: (ctx: ButtonsContext) => (ButtonBarElement | undefined)[];
  enforceFocusInModal?: boolean;
  namedViews?: NamedViewSettings<T>[];
  showContextualSearchBox?: (ctx: ContextualItemsContext<Entity>, blocks?: MenuItemBlock[]) => boolean;
}

export class EntitySettings<T extends BaseEntity = BaseEntity> {
  typeName: string;

  getViewPromise?: (entity: T) => ViewPromise<T>;
  viewOverrides?: Array<ViewOverride<T>>;

  isCreable?: EntityWhen;
  isCreableByFilterProps?: (props: Partial<T>) => boolean;
  isFindable?: boolean;
  isViewable?: EntityWhen;
  isViewableLite?: (lite: Lite<T & Entity>, options: any) => boolean;
  isViewableEntityPack?: (entityPack: EntityPack<T>, options: any) => boolean;
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
  onView?: (entityOrPack: Lite<Entity & T> | T | EntityPack<T>, viewOptions?: any) => Promise<T | undefined>;
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

  showContextualSearchBox = (ctx: any, blocks?: MenuItemBlock[]): boolean => Boolean(blocks && blocks.notNull().sum((b: any) => b.menuItems?.length) > 20);

  constructor(type: Type<T> | string, getViewModule?: (entity: T) => Promise<ViewModule<T>>, options?: EntitySettingsOptions<T>) {

    this.typeName = (type as any).typeName ?? type as string;
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

interface NamedViewSettingsOptions<T extends BaseEntity> {
  getViewPromise?: (entity: T) => ViewPromise<T>;
}

export class NamedViewSettings<T extends BaseEntity> {
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

export class ViewPromise<T extends BaseEntity> {
  promise!: Promise<(ctx: TypeContext<T>) => React.ReactElement>;

  constructor(promise?: Promise<ViewModule<T>>) {
    if (promise)
      this.promise = promise
        .then(mod => {
          return (ctx: TypeContext<T>): React.ReactElement => React.createElement(mod.default, { ctx });
        });
  }

  static resolve<T extends BaseEntity>(getComponent: (ctx: TypeContext<T>) => React.ReactElement): ViewPromise<T> {
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

  // Wraps the resolved view component so the EntitySettings' registered `overrideView` callbacks run
  // over its element tree (via ViewReplacer) before it renders. Navigator is imported lazily inside
  // the async callback to avoid the EntitySettings <-> Navigator module cycle.
  applyViewOverrides(typeName: string, viewName?: string): ViewPromise<T> {
    const result = new ViewPromise<T>();
    result.promise = this.promise.then(async func => {
      const { Navigator } = await import('./Navigator');
      // Through the DISPATCHER, not the EntitySettings directly (Signum does the same): that is what
      // lets a module contribute overrides for a type it does not own — @altea/altea-dynamic serves
      // DynamicViewOverride rows this way.
      const overrides = await Navigator.getViewOverrides(typeName, viewName);
      if (overrides.length == 0)
        return func;

      return (ctx: TypeContext<T>): React.ReactElement => {
        const replacer = new ViewReplacer<T>(func(ctx), ctx, func);
        overrides.forEach(vo => vo.override(replacer as ViewReplacer<BaseEntity>));
        return replacer.result as React.ReactElement;
      };
    });
    return result;
  }

  static flat<T extends BaseEntity>(promise: Promise<ViewPromise<T>>): ViewPromise<T> {
    var result = new ViewPromise<T>();
    result.promise = promise.then(vp => vp.promise);
    return result;
  }
}
