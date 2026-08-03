// Ported from Signum.React/Lines/EntityBase.tsx — copy-paste + fix. altea fixes:
//   - ModifiableEntity → BaseEntity.
//   - Signum's TypeReference is gone: the line's `type` is a FieldInfo. Its carriers map as
//     `.isEmbedded`→`.kind == "Embedded"`, `.name`→`.typeName`, `.isLite`→`.lite`. Navigator's
//     defaultFindOptions accepts the plain type-name string for this field-line path.
//   - idioms: isLite(x)→x instanceof Lite; e.EntityType / e.Type→getTypeName(e); toLite(e,fat,toStr)
//     →e.toLite(fat) (altea's toLite can't take a custom toString alongside fat — see TODO in convert);
//     getToString(t)→t.toString(); ti.name→cleanTypeName(ti.ctor!); getTypeInfo(e.Type)→getTypeInfo(e);
//     Navigator.isCreable/isViewable/isFindable & Finder.isFindable take a name string (PseudoType),
//     not a TypeInfo.
//   - entityInfo is inlined (Signum's Signum.Entities helper); parseLiteList lives in entities/lite.
//   - Finder.find is a throwing STUB until the SearchControl/SearchModal layer lands, so the find
//     button (and IsByAll type-picker) compile but throw at runtime. Navigator.view is likewise a stub
//     (Frames layer), so view/viewOnCreate throw until ported.
//   - paste: Signum re-queries the chosen lite via Finder.fetchLites(findOptions); altea's fetchLites
//     takes a wire QueryEntitiesRequest, so until the request builder is wired we use the chosen lite
//     directly (paste ignores the line's findOptions filters). Marked TODO.
import * as React from 'react'
import { classes } from '../../data/globals'
import { Navigator } from '../Navigator'
import { ViewPromise } from '../EntitySettings'
import { Constructor } from '../Constructor'
import { Finder } from '../Finder'
import type { FindOptions } from '../FindOptions'
import type { TypeContext } from '../TypeContext'
import { PropertyRoute } from '../../data/propertyRoute'
import { getTypeInfo, getTypeName } from '../Reflection'
import { TypeInfo } from '../../data/reflection'
import type { FieldInfo, TypeReference } from '../../data/reflection'
import { cleanTypeName } from '../../data/registration'
import { BaseEntity, Entity, EmbeddedEntity } from '../../data/entity'
import { Lite, parseLiteList } from '../../data/lite'
import { EntityControlMessage, SelectorMessage } from '../../data/uiMessages'
import { LineBaseController, type LineBaseProps } from './LineBase'
import SelectorModal from '../SelectorModal'
import { TypeEntity } from '../../data/typeEntity'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { toAbsoluteUrl } from '../AppContext'
import { LinkButton } from '../Basics/LinkButton'

export interface EntityBaseProps<V extends BaseEntity | Lite<Entity> | null> extends LineBaseProps<V> {
  view?: boolean;
  viewOnCreate?: boolean;
  create?: boolean;
  createOnFind?: boolean;
  find?: boolean;
  remove?: boolean;
  paste?: boolean;

  onView?: (entity: NN<V>, pr: PropertyRoute) => Promise<Aprox<V> | undefined> | undefined;
  onCreate?: (pr: PropertyRoute) => Promise<Aprox<V> | undefined> | undefined;
  onFind?: () => Promise<Aprox<V> | undefined> | undefined;
  onRemove?: (entity: NN<V>) => Promise<boolean>;
  findOptions?: FindOptions;
  findOptionsDictionary?: { [typeName: string]: FindOptions };
  liteToString?: (e: AsEntity<V>) => string;

  getComponent?: (ctx: TypeContext<AsEntity<V>>) => React.ReactElement;
  getViewPromise?: (entity: AsEntity<V>) => undefined | string | ViewPromise<BaseEntity>;

  fatLite?: boolean;
}

export type NN<T> = NoInfer<NonNullable<T>>;

export type Aprox<T> = NoInfer<
  T extends Entity ? T | Lite<T> :
  T extends Lite<infer E> ? E | Lite<E> :
  T extends BaseEntity ? T :
  never>;

export type AsEntity<T> = NoInfer<
  T extends BaseEntity ? T :
  T extends Lite<infer E> ? E :
  never>;

export type AsLite<T> = NoInfer<
  T extends Entity ? Lite<T> :
  T extends Lite<infer E> ? T :
  never>;

// ALTEA: Signum's `entityInfo(entity)` (Signum.Entities) — the `data-entity` attribute value used by
// e2e tooling. Inlined here as "CleanType;id".
function entityInfo(entity: BaseEntity | Lite<Entity> | undefined | null): string {
  if (entity == null)
    return "null";
  const id = (entity as any).id;
  return `${getTypeName(entity as any)};${id ?? ""}`;
}

export class EntityBaseController<P extends EntityBaseProps<V>, V extends BaseEntity | Lite<Entity> | null> extends LineBaseController<P, V>{

  static getCreateIcon = (): React.ReactElement => <FontAwesomeIcon icon="plus" aria-hidden />;
  static getFindIcon = (): React.ReactElement => <FontAwesomeIcon icon="magnifying-glass" aria-hidden />;
  static getRemoveIcon = (): React.ReactElement => <FontAwesomeIcon icon="xmark" aria-hidden />;
  static getTrashIcon = (): React.ReactElement => <FontAwesomeIcon icon="trash-can" aria-hidden />;
  static getViewIcon = (): React.ReactElement => <FontAwesomeIcon icon="arrow-right" aria-hidden />;
  static getMoveIcon = (): React.ReactElement => <FontAwesomeIcon icon="bars" aria-hidden />;
  static getPasteIcon = (): React.ReactElement => <FontAwesomeIcon icon="clipboard" aria-hidden />;

  static hasChildrens(element: React.ReactElement): any {

    return (element.props as any).children && React.Children.toArray((element.props as any).children).length;
  }

  static defaultIsCreable(type: TypeReference, customComponent: boolean): boolean {
    return type.is(EmbeddedEntity) ? Navigator.isCreable(type.getTypeName() ?? "", { customComponent, isEmbedded: true }) :
      type.isByAll() ? false :
        type.typeInfos().some(ti => Navigator.isCreable(cleanTypeName(ti.ctor!), { customComponent }));
  }

  static defaultIsViewable(type: TypeReference, customComponent: boolean): boolean {
    return type.is(EmbeddedEntity) ? Navigator.isViewable(type.getTypeName() ?? "", { customComponent, isEmbedded: true }) :
      type.isByAll() ? true :
        type.typeInfos().some(ti => Navigator.isViewable(cleanTypeName(ti.ctor!), { customComponent }));
  }

  static defaultIsFindable(type: TypeReference): boolean {
    return type.is(EmbeddedEntity) ? false :
      type.isByAll() ? true :
        type.typeInfos().some(ti => Navigator.isFindable(cleanTypeName(ti.ctor!)));
  }

  static override propEquals(prevProps: EntityBaseProps<any>, nextProps: EntityBaseProps<any>): boolean {
    if (
      nextProps.getComponent || prevProps.getComponent ||
      nextProps.extraButtons || prevProps.extraButtons ||
      nextProps.extraButtonsBefore || prevProps.extraButtonsBefore)
      return false;

    return LineBaseController.propEquals(prevProps, nextProps);
  }

  override getDefaultProps(state: P): void {
    if (state.ctx.memberType) {
      const type = state.ctx.memberType;

      state.create = EntityBaseController.defaultIsCreable(type, false);
      state.view = EntityBaseController.defaultIsViewable(type, false);
      state.find = EntityBaseController.defaultIsFindable(type);
      state.findOptions = Navigator.defaultFindOptions(type.getTypeName() ?? "");

      state.viewOnCreate = true;
      state.remove = true;
      state.paste = (type.isByAll() ? true : undefined);
    }
  }

  async convert(entityOrLite: Aprox<V>): Promise<V> {

    const type = this.props.ctx.memberType!;

    const entityType = getTypeName(entityOrLite as any);

    const typeName = type.getTypeName();
    if (type.is(EmbeddedEntity)) {
      if (entityType != typeName || entityOrLite instanceof Lite)
        throw new Error(`Impossible to convert '${entityType}' to '${typeName}'`);

      return entityOrLite as unknown as V;
    }
    else {
      // ALTEA: only enforce the name match for a plain single-type reference; @implementedBy /
      // @implementedByAll accept any of their (polymorphic) implementations.
      if (!type.isByAll() && type.implementations == null && typeName != null && !typeName.split(',').map(a => a.trim()).contains(entityType))
        throw new Error(`Impossible to convert '${entityType}' to '${typeName}'`);

      if (!!(entityOrLite instanceof Lite) == !!type.lite)
        return entityOrLite as unknown as V;

      if (entityOrLite instanceof Lite) {
        const lite = entityOrLite as Lite<Entity>;
        return (await Navigator.API.fetch(lite)) as unknown as V;
      }

      const entity = entityOrLite as Entity;
      const ti = getTypeInfo(entity);
      const fatLite = this.props.fatLite || this.props.fatLite == null && (ti.entityKind == "Part" || ti.entityKind == "SharedPart" || entity.isNew);
      // TODO(port): Signum's toLite(entity, fat, toStr) also set a custom toString from `liteToString`;
      // altea's toLite takes EITHER fat OR a model string, so the custom toString is not applied here.
      return entity.toLite(fatLite) as unknown as V;
    }
  }

  doView(entity: V): Promise<Aprox<V> | undefined> | undefined {
    const pr = this.props.ctx.propertyRoute!;
    return this.props.onView ?
      this.props.onView(entity!, pr) :
      this.defaultView(entity!, pr);
  }


  defaultView(value: NonNullable<V>, propertyRoute: PropertyRoute): Promise<Aprox<V> | undefined> {
    return Navigator.view(value!, {
      propertyRoute: propertyRoute,
      getViewPromise: this.getGetViewPromise() as (undefined | ((entity: BaseEntity) => undefined | string | ViewPromise<BaseEntity>)),
      allowExchangeEntity: false,
    }) as Promise<Aprox<V> | undefined>;
  }

  getGetViewPromise(): undefined | ((entity: AsEntity<V>) => undefined | string | ViewPromise<AsEntity<V>>) {
    var getComponent = this.props.getComponent;
    if (getComponent)
      return e => ViewPromise.resolve(getComponent!);

    var getViewPromise = this.props.getViewPromise;
    if (getViewPromise)
      return e => getViewPromise!(e) as (undefined | string | ViewPromise<AsEntity<V>>);

    return undefined;
  }

  handleViewClick = async (event: React.MouseEvent<any>): Promise<void> => {

    event.preventDefault();

    const ctx = this.props.ctx;
    const entity = ctx.value as V;

    const openWindow = (event.button == 1 || event.ctrlKey) && !this.props.ctx.memberType!.is(EmbeddedEntity);
    if (openWindow) {
      event.preventDefault();
      const route = Navigator.navigateRoute(entity as Lite<Entity> /*or Entity*/);
      window.open(toAbsoluteUrl(route));
    }
    else {
      const e = await this.doView(entity);

      if (!e)
        return;

      //Modifying the sub entity, saving and coming back should change the entity in the UI (ToString, or EntityDetails),
      //the parent entity is not really modified, but I'm not sure it his is a real problem in practice, till then the line is commented out
      //if (e.modified || !is(e, entity))
      // return;

      this.setValue(await this.convert(e), event);
    }
  }

  renderViewButton(btn: boolean): React.ReactElement | undefined {

    if (!this.props.view)
      return undefined;
    return (
      <LinkButton className={classes("sf-line-button", "sf-view", btn ?  "input-group-text" : undefined)}
        onClick={this.handleViewClick}
        title={this.props.ctx.titleLabels ? EntityControlMessage.View.niceToString() + " " + (this.props.label ?? "") : undefined}>
        {EntityBaseController.getViewIcon()}
      </LinkButton>
    );
  }

  static chooseType(t: TypeReference, predicate: (ti: TypeInfo) => boolean): Promise<string | undefined> {

    if (t.is(EmbeddedEntity))
      return Promise.resolve(t.getTypeName());

    if (t.isByAll())
      return Finder.find(TypeEntity, { title: SelectorMessage.PleaseSelectAType.niceToString() }).then(t => t ? t.toString() /*CleanName*/ : undefined);

    const tis = t.typeInfos().filter(ti => predicate(ti));

    return SelectorModal.chooseType(tis)
      .then(ti => ti ? cleanTypeName(ti.ctor!) : undefined);
  }

  getFindOptions(typeName: string): FindOptions | undefined {
    if (this.props.findOptionsDictionary)
      return this.props.findOptionsDictionary[typeName];

    return this.props.findOptions;
  }

  async defaultCreate(pr: PropertyRoute): Promise<Aprox<V> | undefined> {

    var typeName = await EntityBaseController.chooseType(this.props.ctx.memberType!, t => this.props.create /*Hack?*/ || Navigator.isCreable(cleanTypeName(t.ctor!), { customComponent: !!this.props.getComponent || !!this.props.getViewPromise, isEmbedded: pr.fieldInfo != null && pr.fieldInfo.is(EmbeddedEntity) }));

    if (typeName == null)
      return undefined;

    var fo = this.getFindOptions(typeName);

    var props = await Finder.getPropsFromFindOptions(typeName, fo);

    var result = (await Constructor.construct(typeName, props, pr));

    return result as Aprox<V>;
  }

  handleCreateClick = async (event: React.SyntheticEvent<any>): Promise<void> => {

    event.preventDefault();

    var pr = this.props.ctx.propertyRoute!;
    const e = this.props.onCreate ? await this.props.onCreate(pr) :
      await this.defaultCreate(pr);

    if (!e)
      return;

    if (!this.props.viewOnCreate) {
      var value = await this.convert(e);
      this.setValue(value);

    } else {
      var conv = await this.convert(e);
      var v = await this.doView(conv);
      if (v != null) {
        var value = await this.convert(v);
        this.setValue(value);

      }
    }
  }

  async paste(text: string): Promise<void> {

    var lites = parseLiteList(text);
    if (lites.length == 0)
      return;

    var tis = this.props.ctx.memberType!.typeInfos();
    lites = lites.filter(lite => tis.length == 0 || tis.singleOrNull(ti => cleanTypeName(ti.ctor!) == getTypeName(lite)) != null);
    if (lites.length == 0)
      return;

    tis = lites.map(lite => getTypeName(lite)).distinctBy().map(tn => getTypeInfo(tn));
    var ti = await SelectorModal.chooseType(tis);

    if (!ti)
      return;

    const tiName = cleanTypeName(ti.ctor!);
    lites = lites.filter(lite => getTypeName(lite) == tiName);

    // TODO(port): Signum pre-fills the lites' models/toStrings via Navigator.API.fillLiteModels before
    // the selector; that API is not in the active Navigator region yet, so the selector shows the raw
    // lites until it lands.
    var lite = await SelectorModal.chooseLite(tiName, lites);
    if (!lite)
      return;

    // TODO(port): Signum re-queries the chosen lite via Finder.fetchLites(findOptions) to enforce the
    // line's filters; altea's fetchLites takes a wire QueryEntitiesRequest, so until the request
    // builder is wired we use the chosen lite directly (paste ignores findOptions filters).
    var value = await this.convert(lite as Aprox<V>);
    this.setValue(value);
  }

  handlePasteClick = (event: React.SyntheticEvent<any>): void => {

    event.preventDefault();

    navigator.clipboard.readText()
      .then(text => this.paste(text));
  }

  renderCreateButton(btn: boolean, createMessage?: string): React.ReactElement | undefined {
    if (!this.props.create || this.props.ctx.readOnly)
      return undefined;

    return (
      <LinkButton className={classes("sf-line-button", "sf-create", btn ? "input-group-text" : undefined)}
        onClick={this.handleCreateClick}
        title={this.props.ctx.titleLabels ? (createMessage ?? EntityControlMessage.Create.niceToString() + " " + (this.props.label ?? "")) : undefined}>
        {EntityBaseController.getCreateIcon()}
      </LinkButton>
    );
  }

  renderPasteButton(btn: boolean): React.ReactElement | undefined {
    if (!this.props.paste || this.props.ctx.readOnly)
      return undefined;

    return (
      <LinkButton className={classes("sf-line-button", "sf-paste", btn ? "input-group-text" : undefined)}
        onClick={this.handlePasteClick}
        title={EntityControlMessage.Paste.niceToString()}>
        {EntityBaseController.getPasteIcon()}
      </LinkButton>
    );
  }

  static entityHtmlAttributes(entity: BaseEntity | Lite<Entity> | undefined | null): React.HTMLAttributes<any> {

    return {
      'data-entity': entityInfo(entity)
    } as any;
  }

  async defaultFind(): Promise<Aprox<V> | undefined> {

    // TODO(port): Signum passes `{ searchControlProps: { create: this.props.createOnFind } }` so the
    // search modal offers a "create" button; `create` isn't on altea's SearchControlProps stub yet
    // (SearchControl unported — Finder.find throws regardless), so createOnFind is not wired here.
    if (this.props.findOptions) {
      var lite = await Finder.find(this.props.findOptions);

      return lite as Aprox<V> | undefined;

    } else {

      var typeName = await EntityBaseController.chooseType(this.props.ctx.memberType!, ti => Finder.isFindable(cleanTypeName(ti.ctor!), false));

      if (typeName == null)
        return undefined;

      var fo: FindOptions = (this.props.findOptionsDictionary && this.props.findOptionsDictionary[typeName]) ?? Navigator.defaultFindOptions(typeName) ?? { queryName: typeName };

      var lite = await Finder.find(fo);

      return lite as Aprox<V> | undefined;
    }

  }

  handleFindClick = async (event: React.SyntheticEvent<any>): Promise<void> => {

    event.preventDefault();

    const lite = this.props.onFind ?
      await this.props.onFind() :
      await this.defaultFind();

    if (lite != null) {
      var value = await this.convert(lite);
      this.setValue(value);
    }
  }

  renderFindButton(btn: boolean): React.ReactElement | undefined {
    if (!this.props.find || this.props.ctx.readOnly)
      return undefined;

    return (
      <LinkButton className={classes("sf-line-button", "sf-find", btn ? "input-group-text" : undefined)}
        onClick={this.handleFindClick}
        title={this.props.ctx.titleLabels ? EntityControlMessage.Find.niceToString() + " " + (this.props.label ?? "") : undefined}>
        {EntityBaseController.getFindIcon()}
      </LinkButton>
    );
  }

  handleRemoveClick = (event: React.SyntheticEvent<any>): void => {

    event.preventDefault();

    (this.props.onRemove ? this.props.onRemove(this.props.ctx.value!) : Promise.resolve(true))
      .then(result => {
        if (result == false)
          return;

        this.setValue(null!, event);
      });
  };

  renderRemoveButton(btn: boolean): React.ReactElement | undefined {
    if (!this.props.remove || this.props.ctx.readOnly)
      return undefined;

    return (
      <LinkButton className={classes("sf-line-button", "sf-remove", btn ? "input-group-text" : undefined)}
        onClick={this.handleRemoveClick}
        title={this.props.ctx.titleLabels ? EntityControlMessage.Remove.niceToString() + " " + (this.props.label ?? "") : undefined}>
        {EntityBaseController.getRemoveIcon()}
      </LinkButton>
    );
  }
}
