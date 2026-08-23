// Ported from Signum.React/Lines/EntityTable.tsx onto altea's EntityListBase. A row-editing grid: each
// row R edits in place through per-column <AutoLine>s, so `needsValue=false` (super(false)) — a
// @valueField on the row is IGNORED. Big altea adaptations (Signum leaned on PropertyRoute.subMembers /
// addMember / addLambda, none of which altea has — it only has `add(name)`):
//   - default columns = the row type's data fields (TypeInfo.fields, minus id / mixins / @backReference
//     / @rowOrder / non-serialized bookkeeping), each as a bare string `property`.
//   - a column template just renders `<AutoLine ctx={rowCtx.subCtx(property)} />` (string or lambda) —
//     AutoLine derives the FieldInfo from the sub-context; no precomputed factory.
//   - header niceName + mergeCells key resolve the field via `getLambdaMembers`/TypeInfo.fields.
//   - MListElement gone: `list[i]` IS the row (Signum's `.element`), `.extract`/`.last` over R[].
//   - Signum's `is(a,b,false,false)` → local null-safe `mergeEquals`.
import * as React from 'react'
import { classes } from '../../data/globals'
import type { TypeContext } from '../TypeContext'
import { BaseEntity, Entity } from '../../data/entity'
import { getLambdaMembers } from '../../data/lambdaMembers'
import { Lite } from '../../data/lite'
import { EntityControlMessage } from '../../data/uiMessages'
import { EntityBaseController } from './EntityBase'
import { EntityListBaseController, type EntityListBaseProps, type DragConfig, type MoveConfig } from './EntityListBase'
import { Breakpoints, getBreakpoint, useForceUpdate } from '../Hooks'
import { DomUtils } from '../domGlobals'
import { PropertyRoute } from '../../data/propertyRoute'
import type { FieldInfo } from '../../data/reflection'
import type { Quoted } from 'quote-transformer/quoted'
import { useController } from './LineBase'
import { KeyNames } from '../Components'
import { getTimeMachineIcon } from './TimeMachineIcon'
import { GroupHeader, type HeaderType } from './GroupHeader'
import { AutoLine } from './AutoLine'
import { LinkButton } from '../Basics/LinkButton'


export interface EntityTableProps<R extends BaseEntity, RS> extends EntityListBaseProps<R> {
  createAsLink?: boolean | string | ((er: EntityTableController<R, RS>) => React.ReactElement);
  findAsLink?: boolean | string | ((er: EntityTableController<R, RS>) => React.ReactElement);
  firstColumnHtmlAttributes?: React.ThHTMLAttributes<any>;
  rowHooks?: (ctx: TypeContext<NoInfer<R>>, row: EntityTableRowHandle<R, unknown>) => RS;
  columns?: (EntityTableColumn<R, NoInfer<RS>> | false | null | undefined)[],
  onRowHtmlAttributes?: (ctx: TypeContext<NoInfer<R>>, row: EntityTableRowHandle<R, NoInfer<RS>>, rowState: any) => React.HTMLAttributes<any> | null | undefined;
  avoidFieldSet?: boolean | HeaderType;
  avoidEmptyTable?: boolean;
  maxResultsHeight?: string | number;
  scrollable?: boolean;
  rowSubContext?: NoInfer<(ctx: TypeContext<R>) => TypeContext<R>>;
  tableClasses?: string;
  theadClasses?: string;
  createMessage?: string;
  findMessage?: string;
  createOnBlurLastRow?: boolean;
  responsive?: boolean;
  customKey?: (entity: R) => string | undefined;
  afterView?: (ctx: TypeContext<NoInfer<R>>, row: EntityTableRowHandle<R, NoInfer<RS>>, rowState: NoInfer<RS>) => React.ReactElement | boolean | null | undefined;
  afterRow?: (ctx: TypeContext<NoInfer<R>>, row: EntityTableRowHandle<R, NoInfer<RS>>, rowState: NoInfer<RS>) => React.ReactElement | boolean | null | undefined;
  ref?: React.Ref<EntityTableController<R, RS>>;
}

export interface EntityTableColumn<R extends BaseEntity, RS> {
  property?: Quoted<(a: R) => unknown> | string;
  header?: React.ReactNode | null;
  headerHtmlAttributes?: React.ThHTMLAttributes<any>;
  cellHtmlAttributes?: (ctx: TypeContext<R>, row: EntityTableRowHandle<R, RS>, rowState: RS) => React.TdHTMLAttributes<any> | null | undefined;
  template?: (ctx: TypeContext<R>, row: EntityTableRowHandle<R, RS>, rowState: RS) => React.ReactElement | string | number | null | undefined | false;
  mergeCells?: (boolean | ((a: R) => any) | string);
  footer?: React.ReactNode | null;
  footerHtmlAttributes?: React.ThHTMLAttributes<any>;
}

// A column's header label: the declared name for its route, else the humanised member name. Goes through
// the route rather than only its FieldInfo because a column can name a `@quoted` EXPRESSION member
// (OrderLine.subTotalPrice) — a method, so it has no FieldInfo, but it does have a translatable member
// name under its type. undefined when the property doesn't resolve at all.
function columnNiceName(elementPr: PropertyRoute, property: ((a: any) => unknown) | string): string | undefined {
  const fi = columnFieldInfo(elementPr, property);
  if (fi != null)
    return fi.niceToString();
  const member = typeof property == "string" ? property
    : tryOrUndefined(() => getLambdaMembers(property).map(m => m.name).join("."));
  const rootType = elementPr.type.getFunction();
  return member == null ? undefined
    : rootType != null ? (rootType as typeof BaseEntity).nicePropertyName(member)
      : undefined;
}

function tryOrUndefined<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

// Resolve a column's field (for header niceName) by navigating the element route via the new
// PropertyRoute.add/addLambda; best-effort (returns undefined if the property doesn't resolve).
// The route a column's `property` (a member NAME or a Quoted lambda) names, relative to the row type.
// undefined when it doesn't resolve — the caller then leaves the column alone and lets the cell report it.
function columnRoute(elementPr: PropertyRoute, property: ((a: any) => unknown) | string): PropertyRoute | undefined {
  try {
    return typeof property == "string" ? elementPr.add(property) : elementPr.addLambda(property);
  } catch {
    return undefined;
  }
}

function columnFieldInfo(elementPr: PropertyRoute, property: ((a: any) => unknown) | string): FieldInfo | undefined {
  return columnRoute(elementPr, property)?.fieldInfo ?? undefined;
}

// Signum's `is(a, b, false, false)` for the mergeCells key — null-safe, entity/lite by id, else ===.
function mergeEquals(a: unknown, b: unknown): boolean {
  if (a === b)
    return true;
  if ((a instanceof Entity || a instanceof Lite) && (b instanceof Entity || b instanceof Lite))
    return a.is(b);
  return false;
}


export class EntityTableController<R extends BaseEntity, RS> extends EntityListBaseController<EntityTableProps<R, RS>, R> {
  containerDiv!: React.RefObject<HTMLDivElement | null>;
  thead!: React.RefObject<HTMLTableSectionElement | null>;
  tfoot!: React.RefObject<HTMLTableSectionElement | null>;
  recentlyCreated!: React.RefObject<Lite<Entity> | BaseEntity | null>;

  // Row-editing line: the whole row is the element (ignore any @valueField).
  constructor() {
    super(false);
  }

  override init(p: EntityTableProps<R, RS>): void {
    super.init(p);
    this.containerDiv = React.useRef<HTMLDivElement>(null);
    this.thead = React.useRef<HTMLTableSectionElement>(null);
    this.tfoot = React.useRef<HTMLTableSectionElement>(null);
    this.recentlyCreated = React.useRef<Lite<Entity> | BaseEntity | null>(null);

    React.useEffect(() => {
      this.containerDiv.current && this.containerDiv.current.addEventListener("scroll", (e) => {
        var translate = "translate(0," + this.containerDiv.current!.scrollTop + "px)";
        this.thead.current!.style.transform = translate;
      });
    }, []);
  }

  override getDefaultProps(p: EntityTableProps<R, RS>): void {
    super.getDefaultProps(p);
    p.viewOnCreate = false;
    p.view = false;
    p.createAsLink = true;
    p.findAsLink = true;
  }

  override overrideProps(state: EntityTableProps<R, RS>, overridenProps: EntityTableProps<R, RS>): void {
    super.overrideProps(state, overridenProps);

    if (state.ctx.propertyRoute) {
      const elementPr = state.ctx.propertyRoute.add("Item");

      if (!state.columns) {
        // Default columns = the element's fields (PropertyRoute.subMembers), dropping id / ticks / mixins /
        // the structural markers (@backReference / @rowOrder) and non-serialized bookkeeping. `ticks` only
        // appears when the row is a @part ENTITY rather than an embedded (an embedded has none), and it is
        // the concurrency token — never a data column.
        state.columns = Object.entries(elementPr.subMembers())
          .filter(([name, fi]) => name != "id" && name != "ticks" && !name.startsWith("[") && !fi.isBackReference && !fi.isRowOrder && !fi.noSerialize && !fi.notVisible)
          .map(([name]) => ({ property: name }) as EntityTableColumn<R, RS>);
      }
      else {
        state.columns = state.columns.filter(c => c) as EntityTableColumn<R, RS>[];
      }

      // Drop a column the current user may not READ (PropertyRoute.isAllowedCallback — installed by the
      // authorization module; unset = everything allowed). The per-cell <AutoLine> would hide itself
      // anyway, but the HEADER is rendered from this list, so without this the table keeps a titled column
      // of permanently empty cells. A column with a custom `template` is left alone: its content is the
      // caller's, and `property` there is only a merge key.
      // Resolve against the ROW TYPE's own root, not the owner's `details/…` route: a row is a `@part`
      // ENTITY, so its rules (and its cells' own routes) are keyed under the row type itself.
      const rowCtor = elementPr.type.getFunction();
      const rowRoot = rowCtor != null ? PropertyRoute.root(rowCtor) : elementPr;
      state.columns = (state.columns as EntityTableColumn<R, RS>[]).filter(c =>
        c.template !== undefined || c.property == null
        || (columnRoute(rowRoot, c.property)?.isAllowed() ?? null) == null);

      (state.columns as EntityTableColumn<R, RS>[]).forEach(c => {
        if (c.mergeCells == true) {
          if (c.property == null)
            throw new Error("Column has no property but mergeCells is true");
          c.mergeCells = c.property;
        }

        if (typeof c.mergeCells == "string") {
          const prop = c.mergeCells;
          c.mergeCells = a => (a as any)[prop];
        }
      });
    }

    if (state.responsive === undefined) {
      state.responsive = getBreakpoint() <= Breakpoints.sm;
    }
  }

  handleKeyDown = (sender: EntityTableRowHandle<R, RS>, e: React.KeyboardEvent<HTMLTableRowElement>): void => {
    if (e.key != KeyNames.tab) {
      if (this.recentlyCreated.current && sender.props.ctx.value == this.recentlyCreated.current)
        this.recentlyCreated.current = null;

      return;
    }
  }

  handleCreateLastRowBlur = (sender: EntityTableRowHandle<R, RS>, e: React.FocusEvent<HTMLTableRowElement>): void => {
    const p = this.props;
    var tr = DomUtils.closest(e.target, "tr")!;

    if (e.relatedTarget == null || tr == DomUtils.closest(e.relatedTarget as HTMLElement, "tr")) {
      if (this.recentlyCreated.current && sender.props.ctx.value == this.recentlyCreated.current)
        this.recentlyCreated.current = null;

      return;
    }

    if (this.recentlyCreated.current && sender.props.ctx.value == this.recentlyCreated.current) {
      p.ctx.value.extract(row => row == this.recentlyCreated.current);
      this.setValue(p.ctx.value);
      return;
    }

    var last = p.ctx.value.last();

    if (sender.props.ctx.value == last && DomUtils.closest(e.relatedTarget as HTMLElement, "tfoot") == this.tfoot.current) {
      var focusable = Array.from(tr.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(e => {
          var html = e as HTMLInputElement;
          return html.tabIndex >= 0 && html.disabled != true;
        });

      if (focusable.last() == e.target) {
        this.createLastRow();
      }
    }
  }

  async createLastRow(): Promise<void> {
    const p = this.props;
    var pr = this.props.ctx.propertyRoute!.add("Item");
    const entity = p.onCreate ? await p.onCreate(pr) : await this.defaultCreate(pr);

    if (!entity)
      return;

    this.recentlyCreated.current = entity;
    var c = await this.convert(entity);
    this.addElement(c);
  }
}


export function EntityTable<R extends BaseEntity, RS>(props: EntityTableProps<R, RS>): React.JSX.Element | null {
  const c = useController<EntityTableController<R, RS>, EntityTableProps<R, RS>, R[]>(EntityTableController, props);
  const p = c.props;

  if (p.ctx.memberType && p.ctx.memberType.lite)
    throw new Error("Lite not supported");

  if (c.isHidden)
    return null;

  let ctx = p.ctx.subCtx({ formGroupStyle: "SrOnly" });

  return (
    <GroupHeader className={classes("sf-table-field sf-control-container", c.getErrorClass("border"))}
      label={p.label}
      labelIcon={p.labelIcon}
      avoidFieldSet={p.avoidFieldSet}
      buttons={renderButtons()}
      htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes, ...c.errorAttributes() }}>
      {renderTable()}
    </GroupHeader >
  );

  function renderButtons() {
    const buttons = (
      <span className="ms-2">
        {c.props.extraButtonsBefore && c.props.extraButtonsBefore(c)}
        {p.createAsLink == false && c.renderCreateButton(false, p.createMessage)}
        {p.findAsLink == false && c.renderFindButton(false, p.findMessage)}
        {c.props.extraButtons && c.props.extraButtons(c)}
      </span>
    );

    return (EntityBaseController.hasChildrens(buttons) ? buttons : undefined);
  }

  function renderTable() {

    const readOnly = ctx.readOnly;
    const elementPr = ctx.propertyRoute!.add("Item");

    var elementCtxs = c.getMListItemContext(ctx);
    var isEmpty = p.avoidEmptyTable && elementCtxs.length == 0;
    var firstColumnVisible = !(p.readOnly || p.remove == false && p.move == false && p.view == false);

    var cleanColumns = p.columns as EntityTableColumn<R, RS>[];
    var hasFooters = cleanColumns.some(a => a.footer != null);

    var hasLinkButtons = !readOnly && (p.create && p.createAsLink || p.find && p.findAsLink);

    return (
      <div ref={c.containerDiv}
        className={classes(
          p.scrollable ? "sf-scroll-table-container position-relative" /*Fix chrome double scroll bar (in div and in page)*/ : undefined,
          p.responsive && "table-responsive")}
        style={{ maxHeight: p.scrollable ? p.maxResultsHeight : undefined }}>
        <table className={classes("table table-sm sf-table", p.tableClasses, c.mandatoryClass)} >
          {
            !isEmpty &&
            <thead ref={c.thead}>
              <tr className={p.theadClasses}>
                {/* The row-button column (remove / move / view): `width: 0%` collapses it to just what its
                    buttons need, so the DATA columns get the rest of the table instead of the browser
                    handing this one an equal share. Spread after, so firstColumnHtmlAttributes can override. */}
                {firstColumnVisible && <th style={{ width: "0%" }} {...p.firstColumnHtmlAttributes}></th>}
                {
                  cleanColumns.map((col, i) => <th key={i} {...col.headerHtmlAttributes}>
                    {col.header === undefined && col.property ? columnNiceName(elementPr, col.property) : col.header}
                  </th>)
                }
              </tr>
            </thead>
          }
          <tbody>
            {
              elementCtxs
                .map((mlec, i, array) => <EntityTableRow key={p.customKey?.(mlec.value) ?? c.keyGenerator.getKey(mlec.value)}
                  ctx={p.rowSubContext ? p.rowSubContext(mlec) : mlec}
                  array={array}
                  index={i}
                  firstColumnVisible={firstColumnVisible}
                  onRowHtmlAttributes={p.onRowHtmlAttributes}
                  rowHooks={p.rowHooks}
                  onRemove={c.canRemove(mlec.value) && !readOnly ? e => c.handleRemoveElementClick(e, mlec.index!) : undefined}
                  onView={c.canView(mlec.value) ? e => c.handleViewElement(e, mlec.index!) : undefined}
                  move={c.canMove(mlec.value) && p.moveMode == "MoveIcons" && !readOnly ? c.getMoveConfig(false, mlec.index!, "v") : undefined}
                  drag={c.canMove(mlec.value) && p.moveMode == "DragIcon" && !readOnly ? c.getDragConfig(mlec.index!, "v") : undefined}
                  columns={cleanColumns}
                  onCreateLastRowBlur={p.createOnBlurLastRow && p.create && !readOnly ? c.handleCreateLastRowBlur : undefined}
                  onKeyDown={p.createOnBlurLastRow && p.create && !readOnly ? c.handleKeyDown : undefined}
                  afterRow={p.afterRow}
                  afterView={p.afterView}
                />
                )
            }
          </tbody>
          {
            (hasFooters || hasLinkButtons) &&
            <tfoot ref={c.tfoot}>
              {
                hasLinkButtons && <tr>
                  <td colSpan={1 + p.columns!.length} className={isEmpty ? "border-0" : undefined}>

                      {(p.find && p.findAsLink) && (typeof p.findAsLink == "function" ? p.findAsLink(c) :
                        <LinkButton
                          title={ctx.titleLabels ? EntityControlMessage.Find.niceToString() : undefined}
                          className="sf-line-button sf-find me-3"
                          tabIndex={0}
                          onClick={c.handleFindClick}>
                          <span className="me-1">{EntityBaseController.getFindIcon()}</span>{p.findMessage ?? EntityControlMessage.Find.niceToString()}
                        </LinkButton>)}

                      {(p.create && p.createAsLink) && (typeof p.createAsLink == "function" ? p.createAsLink(c) :
                      <LinkButton
                        title={ctx.titleLabels ? EntityControlMessage.Create.niceToString() : undefined}
                        className="sf-line-button sf-create "
                        tabIndex={0}
                        onClick={c.handleCreateClick}>
                          <span className="me-1">{EntityBaseController.getCreateIcon()}</span>{p.createMessage ?? EntityControlMessage.Create.niceToString()}
                      </LinkButton>)}
                  </td>
                </tr>
              }
              {
                hasFooters && <tr>
                  {firstColumnVisible && <td></td>}
                  {cleanColumns.map((col, i) =>
                    <td key={i} {...col.footerHtmlAttributes}>{col.footer}</td>)}
                </tr>
              }
            </tfoot>
          }
        </table>
      </div >
    );
  }
}

export interface EntityTableRowProps<R extends BaseEntity, RS> {
  ctx: TypeContext<R>;
  array: TypeContext<R>[];
  index: number;
  firstColumnVisible: boolean;
  columns: EntityTableColumn<R, RS>[],
  onRemove?: (event: React.MouseEvent<any>) => void;
  onView?: (event: React.MouseEvent<any>) => void;
  drag?: DragConfig;
  move?: MoveConfig;
  rowHooks?: (ctx: TypeContext<R>, row: EntityTableRowHandle<R, unknown>) => RS;
  onRowHtmlAttributes?: (ctx: TypeContext<R>, row: EntityTableRowHandle<R, RS>, rowState: RS) => React.HTMLAttributes<any> | null | undefined;
  onCreateLastRowBlur?: (sender: EntityTableRowHandle<R, RS>, e: React.FocusEvent<HTMLTableRowElement>) => void;
  onKeyDown?: (sender: EntityTableRowHandle<R, RS>, e: React.KeyboardEvent<HTMLTableRowElement>) => void;
  afterView?: (ctx: TypeContext<NoInfer<R>>, row: EntityTableRowHandle<R, RS>, rowState: RS) => React.ReactElement | boolean | null | undefined;
  afterRow?: (ctx: TypeContext<NoInfer<R>>, row: EntityTableRowHandle<R, RS>, rowState: RS) => React.ReactElement | boolean | null | undefined;
}

export interface EntityTableRowHandle<R extends BaseEntity, RS = unknown> {
  props: EntityTableRowProps<R, RS>;
  rowState?: RS;
  forceUpdate(): void;
}

export function EntityTableRow<R extends BaseEntity, RS>(p: EntityTableRowProps<R, RS>): React.ReactElement {
  const forceUpdate = useForceUpdate();

  const rowState = p.rowHooks?.(p.ctx, { props: p as EntityTableRowProps<R, unknown>, forceUpdate })!;

  const rowHandle = { props: p, rowState, forceUpdate } as EntityTableRowHandle<R, RS>;

  var ctx = p.ctx;

  var rowAtts = p.onRowHtmlAttributes && p.onRowHtmlAttributes(ctx, rowHandle, rowState);
  const drag = p.drag;
  var row = (
    <tr
      onBlur={p.onCreateLastRowBlur && (e => p.onCreateLastRowBlur!(rowHandle, e))}
      {...rowAtts}
      onDragEnter={drag?.onDragOver}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onKeyDown={p.onKeyDown && (e => p.onKeyDown!(rowHandle, e))}
      className={classes(drag?.dropClass, rowAtts?.className)}
    >
      {p.firstColumnVisible && <td style={{ verticalAlign: "middle" }}>
        <div className="item-group">
          {getTimeMachineIcon({ ctx: ctx, isContainer: true })}
          {p.onRemove && <LinkButton className={classes("sf-line-button", "sf-remove")}
            onClick={p.onRemove}
            title={ctx.titleLabels ? EntityControlMessage.Remove.niceToString() : undefined}>
            {EntityBaseController.getRemoveIcon()}
          </LinkButton>}
          &nbsp;
          {drag && <LinkButton className={classes("sf-line-button", "sf-move")} onClick={e => { e.stopPropagation(); }}
            draggable={true}
            onKeyDown={drag.onKeyDown}
            onDragStart={drag.onDragStart}
            onDragEnd={drag.onDragEnd}
            title={drag.title}>
            {EntityBaseController.getMoveIcon()}
          </LinkButton>}
          {p.move?.renderMoveUp()}
          {p.move?.renderMoveDown()}
          {p.onView && <LinkButton className={classes("sf-line-button", "sf-view")}
            onClick={p.onView}
            title={ctx.titleLabels ? EntityControlMessage.View.niceToString() : undefined}>
            {EntityBaseController.getViewIcon()}
          </LinkButton>}
          {p.afterView?.(p.ctx, rowHandle, rowState)}
        </div>
      </td>}
      {p.columns.map((col, i) => {

        var td = <td style={{ verticalAlign: "middle" }} key={i} {...col.cellHtmlAttributes && col.cellHtmlAttributes(ctx, rowHandle, rowState)}>{getTemplate(col)}</td>;

        var mc = col.mergeCells as ((a: any) => any) | undefined

        if (!mc)
          return td;

        var equals = (a: any, b: any) => mergeEquals(mc!(a), mc!(b));

        var current = p.ctx.value;
        if (p.index > 0 && equals(p.array[p.index - 1].value, current))
          return null;

        var rowSpan = 1;
        for (var j = p.index + 1; j < p.array.length; j++) {
          if (equals(p.array[j].value, current))
            rowSpan++;
          else
            break;
        }

        if (rowSpan == 1)
          return td;

        return React.cloneElement(td, { rowSpan });
      })}
    </tr>
  );

  if (!p.afterRow)
    return row;
  else
    return (
      <>
        {row}
        {p.afterRow(p.ctx, rowHandle, rowState)}
      </>
    );


  function getTemplate(col: EntityTableColumn<R, RS>): React.ReactElement | string | number | undefined | null | false {

    if (col.template === null)
      return null;

    if (col.template !== undefined)
      return col.template(p.ctx, rowHandle, rowState);

    if (col.property == null)
      throw new Error("Column has no property and no template");

    // ALTEA: Signum precomputed a factory per column; here we just render AutoLine over the sub-context
    // (string or lambda property) — AutoLine resolves the FieldInfo from ctx.propertyRoute.
    return <AutoLine ctx={p.ctx.subCtx(col.property as any)} />;
  }
}
