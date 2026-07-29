// Ported from Signum.React/Lines/EntityCheckboxList.tsx onto altea's EntityListBase. A VALUE line
// (super(true)): the row's @valueField value is the checkbox's lite; the stored list is R[] of rows,
// each wrapping one checked value. altea fixes: no MList/MListElementBinding — toggling off removes the
// matching ROW (`ctx.value.remove(rowCtx.value)`), toggling on `addValue(lite)` (base wraps the value
// into a row via @valueField). Signum's getLiteFromElement / createElementFromLite props are gone — the
// runtime @valueField (getElementValue / addValue) replaces them. Time-machine (oldCtx / checkbox icon)
// dropped (altea list ctxs carry no previousVersion). Data (the option lites) is fetched from the VALUE
// field's type (getValueField().typeName) or the findOptions query.
import * as React from 'react'
import { classes } from '../../entities/globals'
import { Finder } from '../Finder'
import type { FindOptions } from '../FindOptions'
import type { ResultRow, ResultTable } from '../../entities/dynamicQuery/queryRequest'
import { mlistItemContext, type TypeContext } from '../TypeContext'
import { BaseEntity, Entity } from '../../entities/entity'
import { Lite } from '../../entities/lite'
import { EntityListBaseController, type EntityListBaseProps } from './EntityListBase'
import { useController } from './LineBase'
import { normalizeEmptyArray } from './EntityCombo'
import { fieldTypeName } from '../../entities/reflection'
import { Navigator } from '../Navigator'
import { GroupHeader, type HeaderType } from './GroupHeader'

// null-safe entity/lite equality (BaseEntity has no `.is`, so type as Entity|Lite).
function isLiteEqual(a?: Entity | Lite<Entity>, b?: Entity | Lite<Entity>): boolean {
  return a == null ? b == null : a.is(b);
}

// A value shown as an option is always a lite; an entity value is converted (Signum's maybeToLite).
function maybeToLite(value: unknown): Lite<Entity> {
  if (value instanceof Entity)
    return value.toLite(value.isNew);
  return value as Lite<Entity>;
}

export interface RenderCheckboxItemContext<R extends BaseEntity> {
  row: ResultRow;
  index: number;
  checked: boolean;
  controller: EntityCheckboxListController<R>;
  resultTable?: ResultTable;
  ectx: TypeContext<R> | null;
}

export interface EntityCheckboxListProps<R extends BaseEntity> extends EntityListBaseProps<R> {
  data?: Lite<Entity>[];
  columnCount?: number | null;
  columnWidth?: number | null;
  elementsHtmlAttributes?: React.HTMLAttributes<any>;
  avoidFieldSet?: boolean | HeaderType;
  deps?: React.DependencyList;
  onRenderCheckbox?: (ric: RenderCheckboxItemContext<R>) => React.ReactElement;
  onRenderItem?: (ric: RenderCheckboxItemContext<R>) => React.ReactElement;

  groupElementsBy?: (e: ResultRow) => unknown;
  groupStringify?: (key: unknown) => string;
  renderGroupTitle?: (key: unknown, i?: number) => React.ReactNode;

  ref?: React.Ref<EntityCheckboxListController<R>>;
}

export class EntityCheckboxListController<R extends BaseEntity> extends EntityListBaseController<EntityCheckboxListProps<R>, R> {

  // Value line: each checked option is stored as a row wrapping the value on its @valueField.
  constructor() {
    super(true);
  }

  override getDefaultProps(state: EntityCheckboxListProps<R>): void {
    super.getDefaultProps(state);

    if (state.ctx.value == null)
      state.ctx.value = [];

    state.remove = false;
    state.create = false;
    state.view = false;
    state.find = false;
    state.columnWidth = 200;
  }

  handleOnChange = async (event: React.SyntheticEvent, lite: Lite<Entity>): Promise<void> => {
    const ctx = this.props.ctx;
    const toRemove = this.getMListItemContext(ctx).filter(rc => isLiteEqual(this.getElementValue(rc.value) as Entity | Lite<Entity>, lite));

    if (toRemove.length) {
      toRemove.forEach(rc => ctx.value.remove(rc.value));
      this.setValue(ctx.value, event);
    }
    else {
      await this.addValue(lite);
    }
  }
}

export function EntityCheckboxList<R extends BaseEntity>(props: EntityCheckboxListProps<R>): React.JSX.Element | null {
  const c = useController<EntityCheckboxListController<R>, EntityCheckboxListProps<R>, R[]>(EntityCheckboxListController, props);
  const p = c.props;

  if (c.isHidden)
    return null;

  return (
    <GroupHeader className={classes("sf-checkbox-list", c.getErrorClass("border"))}
      label={p.label}
      labelIcon={p.labelIcon}
      avoidFieldSet={p.avoidFieldSet}
      buttons={renderButtons()}
      htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes, ...c.errorAttributes() }} >
      {renderCheckboxList()}
    </GroupHeader >
  );

  function renderButtons() {
    return (
      <span>
        {p.extraButtonsBefore?.(c)}
        {c.renderCreateButton(false)}
        {c.renderFindButton(false)}
        {p.extraButtons?.(c)}
      </span>
    );
  }

  function renderCheckboxList() {
    return (
      <EntityCheckboxListSelect ctx={p.ctx} controller={c} />
    );
  }
}


interface EntityCheckboxListSelectProps<R extends BaseEntity> {
  ctx: TypeContext<R[]>;
  controller: EntityCheckboxListController<R>;
}

export function EntityCheckboxListSelect<R extends BaseEntity>(props: EntityCheckboxListSelectProps<R>): React.ReactElement {

  const c = props.controller;
  const p = c.props;

  var [data, setData] = React.useState<Lite<Entity>[] | ResultTable | undefined>(p.data);
  var requestStarted = React.useRef(false);

  React.useEffect(() => {
    if (p.data) {
      if (requestStarted.current)
        console.warn(`The 'data' was set too late. Consider using [] as default value to avoid automatic query. EntityCheckboxList: ${fieldTypeName(p.type!)}`);
      setData(p.data);
    } else {
      requestStarted.current = true;
      const fo = p.findOptions;
      if (fo) {
        Finder.getResultTable(Finder.defaultNoColumnsAllRows(fo, undefined))
          .then(data => setData(data));
      }
      else {
        // ALTEA: options come from the @valueField's type (Signum used getLiteFromElement/typeReference).
        Finder.API.fetchAllLites({ types: fieldTypeName(c.getValueField()!) ?? "" })
          .then(data => setData(data.orderBy(a => a.toString())));
      }
    }
  }, [normalizeEmptyArray(p.data), fieldTypeName(p.type!), p.deps, p.findOptions && Finder.findOptionsPath(p.findOptions)]);


  return (
    <div {...p.elementsHtmlAttributes}
      className={classes("sf-checkbox-elements", p.elementsHtmlAttributes?.className)}
      style={{ ...p.elementsHtmlAttributes?.style, ...getColumnStyle() }} >
      {renderContent()}
    </div>
  );

  function getColumnStyle(): React.CSSProperties | undefined {
    if (p.columnCount && p.columnWidth)
      return { columns: `${p.columnCount} ${p.columnWidth}px` };

    if (p.columnCount)
      return { columnCount: p.columnCount };

    if (p.columnWidth)
      return { columnWidth: p.columnWidth };

    return undefined;
  }

  function renderContent() {
    if (data == undefined)
      return undefined;

    const fixedData = Array.isArray(data) ? data.map(lite => ({ entity: lite } as ResultRow)) :
      typeof data == "object" ? data.rows :
        [];

    var listCtx = mlistItemContext(p.ctx);

    if (p.filterRows)
      listCtx = p.filterRows(listCtx);

    listCtx.forEach(ctx => {
      var lite = maybeToLite(c.getElementValue(ctx.value));
      if (!fixedData.some(d => isLiteEqual(d.entity, lite)))
        fixedData.insertAt(0, { entity: lite } as ResultRow)
    });

    const resultTable = Array.isArray(data) ? undefined : data;

    function renderRow(row: ResultRow, i: number) {
      var ectx = listCtx.firstOrNull(ectx => isLiteEqual(c.getElementValue(ectx.value) as Entity | Lite<Entity>, row.entity));

      var ric: RenderCheckboxItemContext<R> = {
        row,
        index: i,
        checked: ectx != null,
        controller: c,
        resultTable: resultTable,
        ectx: ectx,
      };

      if (p.onRenderCheckbox)
        return p.onRenderCheckbox(ric);

      return (
        <label className="sf-checkbox-element" key={i}>
          <input type="checkbox"
            className="form-check-input"
            checked={ectx != null}
            disabled={p.ctx.readOnly}
            name={row.entity!.key()}
            onChange={e => c.handleOnChange(e, row.entity!)} />
          &nbsp;
          {p.onRenderItem ? p.onRenderItem(ric) : <span>{Navigator.renderLite(row.entity!)}</span>}
        </label>
      );
    }

    return p.groupElementsBy == undefined ? fixedData.map((row, i) => renderRow(row, i)) :
      <>
        {fixedData.groupBy(p.groupElementsBy, p.groupStringify).map((gr, i) => <div className={classes("mb-2")} key={i} >
          <small className="text-muted">{p.renderGroupTitle != undefined ? p.renderGroupTitle(gr.key, i) : gr.key!.toString()}</small>
          {gr.elements.map((mle, j) => renderRow(mle, j))}
        </div>)}
      </>;
  }
}
