// altea list-line base. Signum's EntityListBase was over `MList<V>` (the MList element WAS the value);
// altea has NO MList — a collection field is a plain `R[]` of ROW entities. This base is generic ONLY
// on R (the stored row). There is NO value generic: every callback (onCreate/onFind/onView/move/…)
// and the stored list are typed over R, so a user overriding onCreate/onFindMany builds the R rows
// themselves.
//
// The @valueField distinction (N-M junction like PersonEntity_Friend.friend, or 1-N value like
// PersonEntity_Telephon.telephone) is handled purely as a RUNTIME DEFAULT: when the row type declares
// a @valueField, the default create/find opens the modal for the VALUE type and then auto-wraps the
// picked value into a row via `RowType.create({ [valueField]: value })`; when it doesn't (owned 1-N
// part rows), create/find operate on R directly. `getElementValue(row)` reads the value back for
// display (the @valueField value, or the row itself). None of this is in the type system — override a
// callback and you're back to plain R.
//
// altea fixes vs Signum: MListElement gone (`list[i]` IS the row, no `.element` / `newMListElement`);
// `mlistItemContext` is altea's plain-array version; `addLambda(a=>a[0])` → `propertyRoute.add("Item")`;
// idiom sweep; `member.preserveOrder` (an MList attr) → the ROW type declaring a @rowOrder field.
// Finder.find/findMany + Navigator.view are throwing stubs until SearchControl/Frames land.
import * as React from 'react'
import { classes, KeyGenerator } from '../../data/globals'
import { BaseEntity, Entity, EmbeddedEntity } from '../../data/entity'
import { Lite, parseLiteList } from '../../data/lite'
import { EntityControlMessage } from '../../data/uiMessages'
import { Finder } from '../Finder'
import { Navigator } from '../Navigator'
import { ViewPromise } from '../EntitySettings'
import { Constructor } from '../Constructor'
import type { FindOptions } from '../FindOptions'
import { TypeContext, mlistItemContext } from '../TypeContext'
import { EntityBaseController } from './EntityBase'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { LineBaseController, type LineBaseProps, defaultTasks } from './LineBase'
import { getTypeInfo, getTypeName } from '../Reflection'
import { PropertyRoute, PropertyRouteType } from '../../data/propertyRoute'
import { type FieldInfo } from '../../data/reflection'
import { cleanTypeName } from '../../data/registration'
import { toAbsoluteUrl } from '../AppContext'
import { KeyNames } from '../Components'
import { LinkButton } from '../Basics/LinkButton'

// TODO(port): AppContext.isRtl (right-to-left). altea has no RTL detection yet → horizontal move icons
// assume LTR.
function isRtl(): boolean { return false; }

export interface IndexWithOffset {
  index: number;
  offset: 0 | 1;
}

export interface EntityListBaseProps<R extends BaseEntity> extends LineBaseProps<R[]> {
  view?: boolean | ((row: NoInfer<R>) => boolean);
  viewOnCreate?: boolean;
  create?: boolean;
  createOnFind?: boolean;
  find?: boolean;
  remove?: boolean | ((row: NoInfer<R>) => boolean);
  paste?: boolean;
  move?: boolean | ((row: NoInfer<R>) => boolean);
  moveMode?: "DragIcon" | "MoveIcons";

  onView?: (row: NoInfer<R>, pr: PropertyRoute) => Promise<R | undefined> | undefined;
  onCreate?: (pr: PropertyRoute) => Promise<R | undefined> | R | undefined;
  onFindMany?: () => Promise<R[] | undefined> | undefined;
  onRemove?: (row: NoInfer<R>) => Promise<boolean>;
  onMove?: (list: NoInfer<R[]>, oldIndex: number, newIndex: IndexWithOffset) => void;
  findOptions?: FindOptions;
  findOptionsDictionary?: { [typeName: string]: FindOptions };

  getComponent?: (ctx: TypeContext<NoInfer<R>>) => React.ReactElement;
  getViewPromise?: (row: NoInfer<R>) => undefined | string | ViewPromise<BaseEntity>;

  fatLite?: boolean;

  filterRows?: (ctxs: TypeContext<R>[]) => TypeContext<R>[]; /*Not only filter, also order/skip/take*/
  onAddElement?: (list: R[], newRow: R) => void;
}

export abstract class EntityListBaseController<P extends EntityListBaseProps<R>, R extends BaseEntity> extends LineBaseController<P, R[]>
{
  dragIndex!: number | undefined;
  setDragIndex!: React.Dispatch<number | undefined>;
  dropBorderIndex!: IndexWithOffset | undefined;
  setDropBorderIndex!: React.Dispatch<IndexWithOffset | undefined>;

  keyGenerator: KeyGenerator = new KeyGenerator();

  // `needsValue` decides how the LINE treats the row (NOT auto-detected from the row's shape):
  //   - needsValue=false (EntityTable / EntityRepeater): the whole row IS the element — a @valueField
  //     on the row is IGNORED even if present.
  //   - needsValue=true (EntityStrip / EntityCheckboxList / …): the element is the row's @valueField
  //     value — the row type MUST declare one (getValueField throws otherwise).
  // Subclasses fix it via `constructor() { super(true|false) }` (useController news them with no args).
  constructor(protected needsValue: boolean = false) {
    super();
  }

  override init(p: P): void {
    super.init(p);
    [this.dragIndex, this.setDragIndex] = React.useState<number | undefined>(undefined);
    [this.dropBorderIndex, this.setDropBorderIndex] = React.useState<IndexWithOffset | undefined>(undefined);
  }

  override getDefaultProps(state: P): void {
    if (state.ctx.memberType) {
      // Defaults key off the ELEMENT type: the @valueField's type when the line consumes a value
      // (needsValue), else the row (collection) type.
      let targetFi = state.ctx.memberType;
      if (this.needsValue && !this.isDirectValueArray(state.ctx.memberType)) {
        const vf = state.ctx.memberType.typeInfo().valueField;
        if (vf == null)
          throw new Error(`${this.constructor.name}: row type '${state.ctx.memberType.getTypeName()}' must declare a @valueField`);
        targetFi = vf;
      }

      state.create = EntityBaseController.defaultIsCreable(targetFi, false);
      state.view = EntityBaseController.defaultIsViewable(targetFi, false);
      state.find = EntityBaseController.defaultIsFindable(targetFi);
      state.findOptions = Navigator.defaultFindOptions(targetFi.getTypeName() ?? "");

      state.viewOnCreate = true;
      state.remove = true;
      state.paste = (targetFi.isByAll() ? true : undefined);
    }
    super.getDefaultProps(state);
    state.moveMode ??= "DragIcon";
  }

  // ---- @valueField runtime helpers (row ⇄ value) ----
  // A "direct value array": the bound array holds the VALUES themselves (Lite<T>[]) with NO wrapping
  // row — the case for a FilterBuilder IsIn / IsNotIn editor, whose value is a plain Lite<T>[]. Signum
  // modeled this as MList<Lite<T>>; altea has no MList, so the array element IS the value. Detected by
  // the memberType being a lite reference (a real N-M/1-N collection field's memberType is the ROW
  // type, never lite). In this mode there is no @valueField and no wrapping: getElementValue /
  // createRowFromValue are identity.
  isDirectValueArray(memberType = this.props.ctx.memberType): boolean {
    return this.needsValue && memberType?.lite == true;
  }

  // The row type's @valueField — ONLY when this line consumes a value (needsValue) via a wrapping row;
  // returns null otherwise (whole row / direct value is the element), and THROWS when a value line's row
  // type lacks one.
  getValueField(): FieldInfo | null {
    if (!this.needsValue || this.isDirectValueArray())
      return null;
    const vf = this.props.ctx.memberType!.typeInfo().valueField;
    if (vf == null)
      throw new Error(`${this.constructor.name}: row type '${this.props.ctx.memberType!.getTypeName()}' must declare a @valueField`);
    return vf;
  }

  // The element value shown/edited for a row: the @valueField value (value lines), or the row itself.
  getElementValue(row: R): unknown {
    const vf = this.getValueField();
    return vf ? (row as any)[vf.name] : row;
  }

  // Wrap a value into a row: `RowType.create({ [valueField]: value })`, or identity when owned.
  createRowFromValue(value: unknown): R {
    const vf = this.getValueField();
    if (vf == null)
      return value as R;
    const ctor = this.props.ctx.memberType!.getFunction();
    if (ctor == null)
      throw new Error(`EntityListBase: row type '${this.props.ctx.memberType!.getTypeName()}' is not registered`);
    return (ctor as unknown as { create(v: any): R }).create({ [vf.name]: value });
  }

  // Match a found/created value to the @valueField's shape (lite↔entity); scalars / owned pass through.
  // In direct-value-array mode there is no @valueField but the element is a Lite, so wantLite is read
  // off the memberType instead.
  async convertValue(valueOrLite: unknown): Promise<unknown> {
    const vf = this.getValueField();
    const isRef = valueOrLite instanceof Lite || valueOrLite instanceof BaseEntity;
    const wantLite = vf ? !!vf.lite : this.isDirectValueArray();
    if (!isRef || (vf == null && !wantLite))
      return valueOrLite;
    const isLiteVal = valueOrLite instanceof Lite;
    if (isLiteVal == wantLite)
      return valueOrLite;

    if (isLiteVal)
      return await Navigator.API.fetch(valueOrLite as Lite<Entity>);

    const entity = valueOrLite as Entity;
    const ti = getTypeInfo(entity);
    const fatLite = this.props.fatLite || this.props.fatLite == null && (ti.entityKind == "Part" || ti.entityKind == "SharedPart" || entity.isNew);
    return entity.toLite(fatLite);
  }

  async valueToRow(value: unknown): Promise<R> {
    return this.createRowFromValue(await this.convertValue(value));
  }

  // Convenience for line subclasses (e.g. EntityStrip autocomplete select): wrap a value + add it.
  async addValue(value: unknown): Promise<void> {
    this.addElement(await this.valueToRow(value));
  }

  // ---- element contexts / list ----
  getMListItemContext(ctx: TypeContext<R[]>): TypeContext<R>[] {
    var rows = mlistItemContext(ctx);
    return this.props.filterRows ? this.props.filterRows(rows) : rows;
  }

  getFindOptions(typeName: string): FindOptions | undefined {
    if (this.props.findOptionsDictionary)
      return this.props.findOptionsDictionary[typeName];

    return this.props.findOptions;
  }

  addElement(row: R): void {
    const list = this.props.ctx.value!;
    if (this.props.onAddElement)
      this.props.onAddElement(list, row);
    else
      list.push(row);
    this.setValue(list);
  }

  removeElement(row: R): void {
    const list = this.props.ctx.value!;
    list.remove(row);
    this.setValue(list);
  }

  handleRemoveElementClick = async (event: React.SyntheticEvent<any>, index: number): Promise<void> => {
    event.preventDefault();

    const list = this.props.ctx.value!;
    const row = list[index];

    var result = this.props.onRemove ? await this.props.onRemove(row) : await Promise.resolve(true);

    if (result)
      this.removeElement(row);
  }

  canMove(row: R): boolean | undefined {
    const move = this.props.move;
    if (move == undefined) return undefined;
    if (typeof move === "function") return move(row);
    return move;
  }

  canRemove(row: R): boolean | undefined {
    const remove = this.props.remove;
    if (remove == undefined) return undefined;
    if (typeof remove === "function") return remove(row);
    return remove;
  }

  canView(row: R): boolean | undefined {
    const view = this.props.view;
    if (view == undefined) return undefined;
    if (typeof view === "function") return view(row);
    return view;
  }

  // ---- create / find / view flow (all in terms of R; @valueField wrapping is runtime) ----
  async convert(entityOrLite: R | Lite<Entity>): Promise<R> {
    const type = this.props.ctx.memberType!;
    const entityType = getTypeName(entityOrLite as any);
    const typeName = type.getTypeName();

    if (type.is(EmbeddedEntity)) {
      if (entityType != typeName || entityOrLite instanceof Lite)
        throw new Error(`Impossible to convert '${entityType}' to '${typeName}'`);
      return entityOrLite as R;
    }
    else {
      // ALTEA: only enforce the name match for a plain single-type reference; @implementedBy /
      // @implementedByAll accept any of their (polymorphic) implementations.
      if (!type.isByAll() && type.implementations == null && typeName != null && !typeName.split(',').map(a => a.trim()).includes(entityType))
        throw new Error(`Impossible to convert '${entityType}' to '${typeName}'`);

      if (!!(entityOrLite instanceof Lite) == !!type.lite)
        return entityOrLite as unknown as R;

      if (entityOrLite instanceof Lite)
        return (await Navigator.API.fetch(entityOrLite as Lite<Entity>)) as unknown as R;

      const entity = entityOrLite as unknown as Entity;
      const ti = getTypeInfo(entity);
      const fatLite = this.props.fatLite || this.props.fatLite == null && (ti.entityKind == "Part" || ti.entityKind == "SharedPart" || entity.isNew);
      return entity.toLite(fatLite) as unknown as R;
    }
  }

  async defaultCreate(pr: PropertyRoute): Promise<R | undefined> {
    const vf = this.getValueField();
    const targetFi = vf ?? this.props.ctx.memberType!;

    var typeName = await EntityBaseController.chooseType(targetFi, t => this.props.create /*Hack?*/ || Navigator.isCreable(cleanTypeName(t.ctor!), { customComponent: !!this.props.getComponent || !!this.props.getViewPromise, isEmbedded: targetFi.is(EmbeddedEntity) }));
    if (typeName == null)
      return undefined;

    var props = await Finder.getPropsFromFindOptions(typeName, this.getFindOptions(typeName));
    var created = await Constructor.construct(typeName, props, vf ? pr.add(vf.name) : pr);
    if (created == null)
      return undefined;

    return vf ? await this.valueToRow(created) : (created as R);
  }

  defaultFindMany(): Promise<R[] | undefined> {
    const vf = this.getValueField();
    const targetFi = vf ?? this.props.ctx.memberType!;

    const wrap = (lites: (Entity | Lite<Entity>)[] | undefined): Promise<R[] | undefined> =>
      lites == undefined ? Promise.resolve(undefined) :
        Promise.all(lites.map(l => vf ? this.valueToRow(l) : this.convert(l as R | Lite<Entity>)));

    if (this.props.findOptions)
      return Finder.findMany(this.props.findOptions).then(wrap);

    return EntityBaseController.chooseType(targetFi, ti => Finder.isFindable(cleanTypeName(ti.ctor!), false))
      .then<R[] | undefined>(typeName => {
        if (typeName == null)
          return undefined;

        var fo: FindOptions = (this.props.findOptionsDictionary && this.props.findOptionsDictionary[typeName]) ?? Navigator.defaultFindOptions(typeName) ?? { queryName: typeName };
        return Finder.findMany(fo).then(wrap);
      });
  }

  getGetViewPromise(): undefined | ((row: R) => undefined | string | ViewPromise<R>) {
    var getComponent = this.props.getComponent;
    if (getComponent)
      return e => ViewPromise.resolve(getComponent!);

    var getViewPromise = this.props.getViewPromise;
    if (getViewPromise)
      return e => getViewPromise!(e) as (undefined | string | ViewPromise<R>);

    return undefined;
  }

  doView(row: R): Promise<R | undefined> | undefined {
    const pr = this.props.ctx.propertyRoute?.add("Item")!;
    return this.props.onView ?
      this.props.onView(row, pr) :
      this.defaultView(row, pr);
  }

  // Owned: view the row. Value collection: view the @valueField value and write the (possibly changed)
  // value back into the row in place. Either way resolves to the row to store.
  defaultView(row: R, propertyRoute: PropertyRoute): Promise<R | undefined> {
    const vf = this.getValueField();
    if (vf != null) {
      const value = (row as any)[vf.name];
      if (!(value instanceof Lite || value instanceof Entity))
        return Promise.resolve(row);
      return (Navigator.view(value as BaseEntity, {
        propertyRoute: propertyRoute.add(vf.name),
        allowExchangeEntity: false,
      }) as Promise<unknown>).then(async nv => {
        if (nv == undefined)
          return undefined;
        (row as any)[vf.name] = await this.convertValue(nv);
        return row;
      });
    }

    return Navigator.view(row, {
      propertyRoute: propertyRoute,
      getViewPromise: this.getGetViewPromise() as (undefined | ((entity: BaseEntity) => undefined | string | ViewPromise<BaseEntity>)),
      allowExchangeEntity: false,
    }) as Promise<R | undefined>;
  }

  handleCreateClick = async (event: React.SyntheticEvent<any>): Promise<void> => {
    event.preventDefault();

    var pr = this.props.ctx.propertyRoute?.add("Item")!;
    const e = this.props.onCreate ? await this.props.onCreate(pr) : await this.defaultCreate(pr);
    if (!e)
      return;

    if (!this.props.viewOnCreate) {
      this.addElement(e);
    } else {
      var v = await this.doView(e);
      if (v != null)
        this.addElement(v);
    }
  }

  handleFindClick = async (event: React.SyntheticEvent<any>): Promise<void> => {
    event.preventDefault();

    const rows = this.props.onFindMany ? await this.props.onFindMany() : await this.defaultFindMany();
    if (!rows)
      return;

    rows.forEach(r => this.addElement(r));
  };

  handleViewElement = async (event: React.MouseEvent<any>, index: number): Promise<void> => {
    event.preventDefault();

    const p = this.props;
    const list = p.ctx.value!;
    const row = list[index];
    const displayVal = this.getElementValue(row);

    const openWindow = (event.button == 1 || event.ctrlKey) && (displayVal instanceof Entity || displayVal instanceof Lite);
    if (openWindow) {
      event.preventDefault();
      window.open(toAbsoluteUrl(Navigator.navigateRoute(displayVal as Entity)));
      return;
    }

    const pr = p.ctx.propertyRoute?.add("Item")!;
    const promise = p.onView ? p.onView(row, pr) : this.defaultView(row, pr);
    if (promise == null)
      return;

    const e = await promise;
    if (e == undefined)
      return;

    list[index] = e;
    this.setValue(list);
  }

  renderCreateButton(btn: boolean, createMessage?: string): React.ReactElement | undefined {
    if (!this.props.create || this.props.ctx.readOnly)
      return undefined;

    return (
      <LinkButton className={classes("sf-line-button", "sf-create", btn ? "input-group-text" : undefined)}
        onClick={this.handleCreateClick}
        title={this.props.ctx.titleLabels ? createMessage ?? EntityControlMessage.Create.niceToString() : undefined}>
        {EntityBaseController.getCreateIcon()}
      </LinkButton>
    );
  }

  renderFindButton(btn: boolean, findMessage?: string): React.ReactElement | undefined {
    if (!this.props.find || this.props.ctx.readOnly)
      return undefined;

    return (
      <LinkButton className={classes("sf-line-button", "sf-find", btn ? "input-group-text" : undefined)}
        onClick={this.handleFindClick}
        title={this.props.ctx.titleLabels ? findMessage ?? EntityControlMessage.Find.niceToString() : undefined}>
        {EntityBaseController.getFindIcon()}
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

  handlePasteClick = (event: React.SyntheticEvent<any>): void => {
    event.preventDefault();
    navigator.clipboard.readText()
      .then(text => this.paste(text));
  }

  paste(text: string): Promise<void> | undefined {
    var lites = parseLiteList(text);
    if (lites.length == 0)
      return;

    const vf = this.getValueField();
    const tis = (vf ?? this.props.ctx.memberType!).typeInfos();
    if (tis.length > 0)
      lites = lites.filter(l => tis.some(ti => cleanTypeName(ti.ctor!) == getTypeName(l)));
    if (lites.length == 0)
      return;

    // TODO(port): no findOptions re-query (altea's fetchLites takes a wire QueryEntitiesRequest); the
    // pasted lites are converted + added directly (paste ignores findOptions filters).
    return Promise.all(lites.map(l => vf ? this.valueToRow(l) : this.convert(l as Lite<Entity>)))
      .then(rows => rows.forEach(r => this.addElement(r)));
  }

  // ---- move / drag ----
  moveUp(index: number): void {
    const list = this.props.ctx.value!;
    list.moveUp(index);
    this.setValue(list);
  }

  renderMoveUp(btn: boolean, index: number, orientation: "h" | "v"): React.ReactElement | undefined {
    if (!this.canMove(this.props.ctx.value[index]) || this.props.ctx.readOnly)
      return undefined;

    return (
      <LinkButton
        className={classes("sf-line-button", "sf-move", "sf-move-step", btn ? "input-group-text" : undefined)}
        onClick={e => { this.moveUp(index); }}
        tabIndex={0}
        title={this.props.ctx.titleLabels ? (orientation == "v" ? EntityControlMessage.MoveUp : (isRtl() ? EntityControlMessage.MoveRight : EntityControlMessage.MoveLeft)).niceToString() : undefined}>
        <FontAwesomeIcon aria-hidden={true} icon={orientation == "v" ? "chevron-up" : (isRtl() ? "chevron-right" : "chevron-left")} />
      </LinkButton>
    );
  }

  moveDown(index: number): void {
    const list = this.props.ctx.value!;
    list.moveDown(index);
    this.setValue(list);
  }

  renderMoveDown(btn: boolean, index: number, orientation: "h" | "v"): React.ReactElement | undefined {
    if (!this.canMove(this.props.ctx.value[index]) || this.props.ctx.readOnly)
      return undefined;

    return (
      <LinkButton
        className={classes("sf-line-button", "sf-move", "sf-move-step", btn ? "input-group-text" : undefined)}
        onClick={e => { this.moveDown(index); }}
        tabIndex={0}
        title={this.props.ctx.titleLabels ? (orientation == "v" ? EntityControlMessage.MoveDown : (isRtl() ? EntityControlMessage.MoveLeft : EntityControlMessage.MoveRight)).niceToString() : undefined}>
        <FontAwesomeIcon aria-hidden={true} icon={orientation == "v" ? "chevron-down" : (isRtl() ? "chevron-left" : "chevron-right")} />
      </LinkButton>
    );
  }

  handleDragStart = (de: React.DragEvent<any>, index: number): void => {
    de.dataTransfer.setData('text', "start"); //cannot be empty string
    de.dataTransfer.effectAllowed = "move";
    this.setDragIndex(index);
  }

  handleDragEnd = (de: React.DragEvent<any>): void => {
    this.setDragIndex(undefined);
    this.setDropBorderIndex(undefined);
    this.forceUpdate();
  }

  getOffsetHorizontal(dragEvent: DragEvent, rect: DOMRect): 0 | 1 | undefined {
    const margin = Math.min(50, rect.width / 2);
    const width = rect.width;
    const offsetX = dragEvent.x - rect.left;
    if (offsetX < margin) return 0;
    if (offsetX > (width - margin)) return 1;
    return undefined;
  }

  getOffsetVertical(dragEvent: DragEvent, rect: DOMRect): 0 | 1 | undefined {
    var margin = Math.min(50, rect.height / 2);
    const height = rect.height;
    const offsetY = dragEvent.y - rect.top;
    if (offsetY < margin) return 0;
    if (offsetY > (height - margin)) return 1;
    return undefined;
  }

  handlerDragOver = (de: React.DragEvent<any>, index: number, orientation: "h" | "v"): void => {
    if (this.dragIndex == null)
      return;

    de.preventDefault();

    const th = de.currentTarget as HTMLElement;

    const offset = orientation == "v" ?
      this.getOffsetVertical((de.nativeEvent as DragEvent), th.getBoundingClientRect()) :
      this.getOffsetHorizontal((de.nativeEvent as DragEvent), th.getBoundingClientRect());

    let dropBorderIndex: IndexWithOffset | undefined = offset == undefined ? undefined :
      { index, offset };

    if (dropBorderIndex != null && dropBorderIndex.index == this.dragIndex)
      dropBorderIndex = undefined;

    if (this.dropBorderIndex != dropBorderIndex) {
      this.setDropBorderIndex(dropBorderIndex);
      this.forceUpdate();
    }
  }

  getDragConfig(index: number, orientation: "h" | "v"): DragConfig {
    return {
      dropClass: classes(
        index == this.dragIndex && "sf-dragging",
        this.dropClass(index, orientation)),
      onDragStart: e => this.handleDragStart(e, index),
      onDragEnd: this.handleDragEnd,
      onKeyDown: e => this.handleMoveKeyDown(e, index),
      onDragOver: e => this.handlerDragOver(e, index, orientation),
      onDrop: this.handleDrop,
      title: !this.props.ctx.titleLabels ? undefined :
        orientation == "h" ? EntityControlMessage.MoveWithDragAndDropOrCtrlLeftRight.niceToString() :
          EntityControlMessage.MoveWithDragAndDropOrCtrlUpDown.niceToString()
    };
  }

  getMoveConfig(btn: boolean, index: number, orientation: "h" | "v"): MoveConfig {
    return {
      renderMoveUp: (): React.ReactElement => this.renderMoveUp(false, index, orientation)!,
      renderMoveDown: (): React.ReactElement | undefined => this.renderMoveDown(false, index, orientation)
    }
  }

  dropClass(index: number, orientation: "h" | "v"): "drag-left" | "drag-top" | "drag-right" | "drag-bottom" | undefined {
    const dropBorderIndex = this.dropBorderIndex;

    if (dropBorderIndex != null) {

      if (index == dropBorderIndex.index) {
        if (dropBorderIndex.offset == 0)
          return (orientation == "h" ? "drag-left" : "drag-top");
        else
          return (orientation == "h" ? "drag-right" : "drag-bottom")
      }

      if (!this.props.filterRows) {
        if (dropBorderIndex.index == (index - 1) && dropBorderIndex.offset == 1)
          return (orientation == "h" ? "drag-left" : "drag-top");
        else if (dropBorderIndex.index == (index + 1) && dropBorderIndex.offset == 0)
          return (orientation == "h" ? "drag-right" : "drag-bottom")
      }
    }

    return undefined;
  }

  handleMoveKeyDown = (ke: React.KeyboardEvent<any>, index: number): void => {
    if (ke.ctrlKey) {
      if (ke.key == KeyNames.arrowDown || ke.key == KeyNames.arrowRight) {
        ke.preventDefault();
        this.onMoveElement(index, ({ index: index + 1, offset: 1 }));
      } else if (ke.key == KeyNames.arrowUp || ke.key == KeyNames.arrowLeft) {
        ke.preventDefault();
        this.onMoveElement(index, ({ index: index - 1, offset: 0 }));
      }
    }
  }

  handleDrop = (de: React.DragEvent<any>): void => {
    de.preventDefault();
    const dropBorderIndex = this.dropBorderIndex;
    const dragIndex = this.dragIndex;
    if (dropBorderIndex == null || dragIndex == null)
      return;

    this.onMoveElement(dragIndex, dropBorderIndex);
  }

  onMoveElement(oldIndex: number, newIndex: IndexWithOffset): void {
    const list = this.props.ctx.value!;

    if (this.props.onMove) {
      this.props.onMove(list, oldIndex, newIndex);
    }
    else {
      const temp = list[oldIndex];
      list.removeAt(oldIndex);
      var completeNewIndex = newIndex.index + newIndex.offset;
      const rebasedDropIndex = newIndex.index > oldIndex ? completeNewIndex - 1 : completeNewIndex;
      list.insertAt(rebasedDropIndex, temp);
    }

    this.setValue(list);
    this.setDropBorderIndex(undefined);
    this.setDragIndex(undefined);
    this.forceUpdate();
  }
}

export interface DragConfig {
  onDragStart?: React.DragEventHandler<any>;
  onDragEnd?: React.DragEventHandler<any>;
  onDragOver?: React.DragEventHandler<any>;
  onDrop?: React.DragEventHandler<any>;
  onKeyDown?: React.KeyboardEventHandler<any>;
  dropClass?: string;
  title?: string;
}

export interface MoveConfig {
  renderMoveUp: () => (React.ReactElement | undefined);
  renderMoveDown: () => (React.ReactElement | undefined);
}


defaultTasks.push(taskSetMove);
export function taskSetMove(lineBase: LineBaseController<LineBaseProps, unknown>, state: LineBaseProps): void {
  if (lineBase instanceof EntityListBaseController &&
    (state as EntityListBaseProps<any>).move == undefined &&
    state.ctx.propertyRoute &&
    state.ctx.propertyRoute.propertyRouteType == PropertyRouteType.FieldOrProperty &&
    // A polymorphic collection has >1 row type (no single @rowOrder) → onlyOrNull() yields null, no move.
    state.ctx.memberType && state.ctx.memberType.typeInfos().onlyOrNull()?.rowOrderField != null) {
    (state as EntityListBaseProps<any>).move = true;
  }
}

