// Ported from Signum.React/Lines/EntityCombo.tsx — copy-paste + fix. altea fixes:
//   - ModifiableEntity → BaseEntity; the line's `type` is a FieldInfo (`.name`→`.typeName`); TypeInfo
//     has no `.name` → cleanTypeName(ti.ctor!).
//   - idioms: is(a,b)→isLiteEqual (null-safe a.is(b)); liteKey(l)→l.key(); isEntity(x)→x instanceof
//     Entity; getToString(x, f?)→comboToString (f = liteToString applied to the resolved entity;
//     altea's toLite can't carry a custom toString, so getLite drops it — see TODO).
//   - ResultRow/ResultTable come from entities/dynamicQuery/queryRequest (wire DTOs).
//   - the DropdownList (onRenderItem) branch is wrapped in <Localization> (Intl localizer), matching
//     EnumLine; the plain <select> branch needs none. Data loads via the active Finder query APIs
//     (getResultTable / defaultNoColumnsAllRows), so the combo is fully functional.
import * as React from 'react'
import { BaseEntity, Entity } from '../../entities/entity'
import { Lite } from '../../entities/lite'
import { Finder } from '../Finder'
import type { FindOptions } from '../FindOptions'
import type { ResultRow, ResultTable } from '../../entities/dynamicQuery/queryRequest'
import type { TypeContext } from '../TypeContext'
import { getTypeInfos, tryGetTypeInfos } from '../Reflection'
import type { FieldInfo } from '../../entities/reflection'
import { cleanTypeName } from '../../entities/registration'
import { EntityBaseController, type EntityBaseProps, type AsLite, type Aprox } from './EntityBase'
import { FormGroup } from './FormGroup'
import { Navigator } from '../Navigator'
import { FormControlReadonly } from './FormControlReadonly'
import { classes } from '../../entities/globals'
import { genericMemo, useController } from './LineBase'
import { useMounted } from '../Hooks'
import { DropdownList, Localization } from 'react-widgets-up'
import { getDateLocalizer, getNumberLocalizer } from './ReactWidgetsLocalizer'
import { getTimeMachineIcon } from './TimeMachineIcon'
import { TextHighlighter } from '../Components/Typeahead'

const dateLocalizer = getDateLocalizer();
const numberLocalizer = getNumberLocalizer();

// ALTEA: Signum's null-safe free `is(a, b)`; altea `.is()` is an instance method, so guard the receiver.
function isLiteEqual(a?: Entity | Lite<Entity>, b?: Entity | Lite<Entity>): boolean {
  return a == null ? b == null : a.is(b);
}

// ALTEA: Signum's `getToString(entityOrLite, toStringFunc?)`. `toStringFunc` (liteToString) takes the
// resolved Entity; apply it when we have one, else fall back to the value's own toString.
function comboToString(x: BaseEntity | Lite<Entity> | undefined | null, f?: (e: Entity) => string): string {
  if (x == null)
    return "";
  const ent = x instanceof Lite ? x.entityOrNull : (x as Entity);
  if (f && ent)
    return f(ent);
  return x.toString();
}


export interface EntityComboProps<V extends Entity | Lite<Entity> | null> extends EntityBaseProps<V> {
  data?: AsLite<V>[];
  labelTextWithData?: (data: Lite<Entity>[] | undefined | null, resultTable?: ResultTable | null) => React.ReactElement | string;
  deps?: React.DependencyList;
  initiallyFocused?: boolean;
  selectHtmlAttributes?: React.SelectHTMLAttributes<any>;
  optionHtmlAttributes?: (lite: ResultRow | undefined) => React.OptionHTMLAttributes<any> | undefined;
  onRenderItem?: (lite: ResultRow | undefined, role: "Value" | "ListItem", searchTerm?: string) => React.ReactElement | string;
  nullPlaceHolder?: string;
  delayLoadData?: boolean;
  toStringFromData?: boolean;
  overrideSelectedLite?: () => Lite<Entity> | null;
  ref?: React.Ref<EntityComboController<V>>
}



export class EntityComboController<V extends Entity | Lite<Entity> | null> extends EntityBaseController<EntityComboProps<V>, V> {

  refresh = 0;

  override getDefaultProps(p: EntityComboProps<V>): void {
    p.remove = false;
    p.create = false;
    p.view = false;
    p.viewOnCreate = true;
    p.find = false;
  }

  override overrideProps(p: EntityComboProps<V>, overridenProps: EntityComboProps<V>): void {
    super.overrideProps(p, overridenProps);
    if (p.onRenderItem === undefined && p.type && tryGetTypeInfos((p.type.getTypeName() ?? "")).some(a => a != null && Navigator.getSettings(cleanTypeName(a.ctor!))?.renderLite)) {
      p.onRenderItem = (row, role, searchTerm) => row == null ? <span className="mx-2">-</span> : (row?.entity && Navigator.renderLite(row.entity, TextHighlighter.fromString(searchTerm))) ?? "";
    }
  }

  override async doView(entity: V): Promise<Aprox<V> | undefined> {
    var val = await super.doView(entity);

    this.refresh++;

    return val;
  }

  handleOnChange = async (e: React.SyntheticEvent | undefined, lite: AsLite<V> | null): Promise<void> => {
    if (lite == null)
      this.setValue(null!);
    else {
      var v = await this.convert(lite)
      this.setValue(v, e);
    }
  }
}

export const EntityCombo: <V extends Entity | Lite<Entity> | null>(props: EntityComboProps<V>) => React.ReactNode | null
  = genericMemo(function EntityCombo<V extends Entity | Lite<Entity> | null>(props: EntityComboProps<V>) {

    const c = useController<EntityComboController<V>, EntityComboProps<V>, V>(EntityComboController, props);
    const p = c.props;
    const hasValue = !!c.props.ctx.value;
    const comboRef = React.useRef<EntityComboSelectHandle>(null);

    React.useEffect(() => {
      if (p.initiallyFocused)
        window.setTimeout(() => {
          let select = comboRef.current && comboRef.current.getSelect();
          if (select) {
            select.focus();
          }
        }, 0);
    }, []);

    if (c.isHidden)
      return null;

    const buttons = (
      <>
        {c.props.extraButtonsBefore && c.props.extraButtonsBefore(c)}
        {!hasValue && c.renderCreateButton(true)}
        {!hasValue && c.renderFindButton(true)}
        {hasValue && c.renderViewButton(true)}
        {hasValue && c.renderRemoveButton(true)}
        {c.props.extraButtons && c.props.extraButtons(c)}
      </>
    );

    function getLabelText() {

      if (p.labelTextWithData == null)
        return p.label;

      var data = c.props.data || comboRef.current && comboRef.current.getData();

      return p.labelTextWithData(data == null ? null : Array.isArray(data) ? data : data.rows.map(a => a.entity!), data && (Array.isArray(data) ? undefined : data));
    }

    const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
    const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

    return (
      <FormGroup ctx={c.props.ctx} error={p.error} label={getLabelText()} labelIcon={p.labelIcon}
        helpText={helpText}
        helpTextOnTop={helpTextOnTop}
        htmlAttributes={{ ...c.baseHtmlAttributes(), ...EntityBaseController.entityHtmlAttributes(p.ctx.value), ...p.formGroupHtmlAttributes }}
        labelHtmlAttributes={p.labelHtmlAttributes}>
        {inputId => <div className="sf-entity-combo">
          <div className={EntityBaseController.hasChildrens(buttons) ? p.ctx.inputGroupClass : undefined}>
            {getTimeMachineIcon({ ctx: p.ctx })}
            <EntityComboSelect<V>
              id={inputId}
              ref={comboRef}
              ctx={p.ctx}
              onChange={c.handleOnChange}
              type={p.type!}
              data={p.data}
              findOptions={p.findOptions}
              findOptionsDictionary={p.findOptionsDictionary}
              onDataLoaded={p.labelTextWithData == null ? undefined : () => c.forceUpdate()}
              mandatoryClass={c.mandatoryClass}
              deps={p.deps ? [c.refresh, ...p.deps] : [c.refresh]}
              delayLoadData={p.delayLoadData}
              toStringFromData={p.toStringFromData}
              selectHtmlAttributes={p.selectHtmlAttributes}
              optionHtmlAttributes={p.optionHtmlAttributes}
              liteToString={p.liteToString as (e: Entity) => string}
              nullPlaceHolder={p.nullPlaceHolder}
              onRenderItem={p.onRenderItem}
              overrideSelectedLite={p.overrideSelectedLite}
            />
            {EntityBaseController.hasChildrens(buttons) ? buttons : undefined}
          </div>
        </div>}
      </FormGroup>
    );
  }, (prev, next): boolean => EntityBaseController.propEquals(prev, next));

export interface EntityComboSelectProps<V extends BaseEntity | Lite<Entity> | null> {
  ctx: TypeContext<V>;
  onChange: (e: React.SyntheticEvent | undefined, lite: AsLite<V> | null) => void;
  type: FieldInfo;
  findOptions?: FindOptions;
  findOptionsDictionary?: { [typeName: string]: FindOptions };
  data?: AsLite<V>[];
  mandatoryClass: string | null;
  onDataLoaded?: (data: AsLite<V>[] | ResultTable | undefined) => void;
  deps?: React.DependencyList;
  selectHtmlAttributes?: React.SelectHTMLAttributes<any>;
  optionHtmlAttributes?: (lite: ResultRow | undefined) => React.OptionHTMLAttributes<any> | undefined;
  onRenderItem?: (lite: ResultRow | undefined, role: "Value" | "ListItem", searchTerm?: string) => React.ReactNode;
  liteToString?: (e: Entity) => string;
  nullPlaceHolder?: string;
  delayLoadData?: boolean;
  toStringFromData?: boolean;
  overrideSelectedLite?: () => Lite<Entity> | null;
  id: string;
  ref?: React.Ref<EntityComboSelectHandle>
}


const __normalized: Lite<Entity>[] = [];
export function normalizeEmptyArray(data: Lite<Entity>[] | undefined): Lite<Entity>[] | undefined {
  if (data == undefined)
    return undefined;

  if (data.length == 0)
    return __normalized;

  return data;
}

export interface EntityComboSelectHandle {
  getSelect(): HTMLSelectElement | null;
  getData(): Lite<Entity>[] | ResultTable | undefined;
}
//Extracted to another component
export function EntityComboSelect<V extends Entity | Lite<Entity> | null>(p: EntityComboSelectProps<V>): React.JSX.Element {

  const [data, _setData] = React.useState<Lite<Entity>[] | ResultTable | undefined>(p.data);
  const requestStarted = React.useRef(false);

  const [loadData, setLoadData] = React.useState<boolean>(!p.delayLoadData);

  const selectRef = React.useRef<HTMLSelectElement>(null);
  const mounted = useMounted();

  React.useImperativeHandle(p.ref, () => ({
    getData: () => data,
    getSelect: () => selectRef.current
  }));

  function setData(data: AsLite<V>[] | ResultTable) {
    if (mounted.current) {
      _setData(data);
      if (p.onDataLoaded)
        p.onDataLoaded(data);
    }
  }

  React.useEffect(() => {
    if (p.data) {
      if (requestStarted.current)
        console.warn(`The 'data' was set too late. Consider using [] as default value to avoid automatic query. EntityCombo: ${(p.type.getTypeName() ?? "")}`);
      setData(p.data);
    } else if (!p.ctx.readOnly && loadData) {
      requestStarted.current = true;

      if ((p.type.getTypeName() ?? "").contains(",") && !p.findOptions) {
        Promise.all(getTypeInfos((p.type.getTypeName() ?? "")).map(t => {
          const tn = cleanTypeName(t.ctor!);
          var fo = p.findOptionsDictionary?.[tn] ?? { queryName: tn };
          return Finder.getResultTable(Finder.defaultNoColumnsAllRows(fo, undefined))
        })).then(array => setData(array.flatMap(a => a.rows.map(a => a.entity! as AsLite<V>))));
      } else {
        const fo = p.findOptions ?? { queryName: (p.type.getTypeName() ?? "") };
        Finder.getResultTable(Finder.defaultNoColumnsAllRows(fo, undefined))
          .then(data => setData(data));
      }
    }
  }, [normalizeEmptyArray(p.data), (p.type.getTypeName() ?? ""), loadData, p.ctx.readOnly, p.findOptions && Finder.findOptionsPath(p.findOptions), ...(p.deps ?? [])]);

  const lite = getLite();

  const ctx = p.ctx;

  if (ctx.readOnly)
    return (
      <FormControlReadonly id={p.id} ctx={ctx} htmlAttributes={p.selectHtmlAttributes}>
        {ctx.value &&
          (p.onRenderItem ? p.onRenderItem({ entity: lite } as ResultRow, "Value", undefined) :
            p.liteToString ? comboToString(lite, p.liteToString) :
              Navigator.renderLite((p.toStringFromData ? p.data?.singleOrNull(a => isLiteEqual(a, lite)) : null) ?? lite!))
        }
      </FormControlReadonly>
    );

  if (p.onRenderItem) {
    return (
      <Localization date={dateLocalizer} number={numberLocalizer}>
        <DropdownList<ResultRow>
          className={classes(ctx.formControlClass, p.mandatoryClass)} data={getOptionRows()}
          onChange={(row, e) => p.onChange(e.originalEvent, (row?.entity as AsLite<V>) ?? null)}
          value={getResultRow(lite)}
          title={comboToString(lite)}
          filter={(e, query) => {
            var toStr = comboToString((e as ResultRow).entity).toLowerCase();
            return query.toLowerCase().split(' ').every(part => toStr.contains(part));
          }}
          renderValue={a => p.onRenderItem!(a.item?.entity == null ? undefined : a.item, "Value")}
          renderListItem={a => p.onRenderItem!(a.item?.entity == null ? undefined : a.item, "ListItem", a.searchTerm)}
        />
      </Localization>
    );
  } else {
    return (
      <select {...p.selectHtmlAttributes}
        className={classes(ctx.formSelectClass, p.mandatoryClass, p.selectHtmlAttributes?.className)}
        onChange={handleOnChange} value={lite ? lite.key() : ""}
        title={comboToString(lite)}
        id={p.id}
        onClick={() => setLoadData(true)}
        disabled={ctx.readOnly} ref={selectRef} >
        {getOptionRows().map((r, i) =>
          <option key={i} value={r?.entity ? r.entity.key() : ""} {...p.optionHtmlAttributes?.(r)}>{r?.entity ? comboToString(r.entity, p.liteToString) : (p.nullPlaceHolder ?? " - ")}</option>)}
      </select>
    );
  }

  function handleOnChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const current = event.currentTarget as HTMLSelectElement;

    const lite = getLite();

    if (current.value != (lite ? lite.key() : undefined)) {
      if (!current.value) {
        p.onChange(event, null);
      } else {
        const liteFromData = Array.isArray(data) ? data!.single(a => a.key() == current.value) :
          data?.rows.single(a => a.entity!.key() == current.value).entity!;
        p.onChange(event, liteFromData as AsLite<V>);
      }
    }
  }

  function getResultRow(lite: Lite<Entity> | undefined): ResultRow {

    if (lite == null)
      return ({ entity: undefined }) as ResultRow;

    if (Array.isArray(data))
      return ({ entity: lite }) as ResultRow;

    if (typeof data == "object")
      return data.rows.singleOrNull(a => isLiteEqual(lite, a.entity)) ?? ({ entity: lite }) as ResultRow;

    return ({ entity: lite }) as ResultRow;
  }

  function getLite() {
    const v = p.ctx.value;
    if (v == undefined) {
      if (p.overrideSelectedLite) {
        return (p.overrideSelectedLite() ?? undefined);
      }
      return undefined;
    }

    if (v instanceof Entity)
      // TODO(port): Signum passed liteToString as the lite's toString; altea's toLite can't carry it
      // alongside fat, so the custom display string is applied via comboToString instead.
      return v.toLite(v.isNew) as Lite<Entity>;

    return v as Lite<Entity>;
  }

  function getOptionRows(): ResultRow[] {

    const lite = getLite();

    var rows = Array.isArray(data) ? data.map(lite => ({ entity: lite } as ResultRow)) :
      typeof data == "object" ? data.rows :
        [];

    const elements: ResultRow[] = [{ entity: undefined } as ResultRow/*Because DropDownList*/, ...rows];

    if (lite) {
      var index = elements.findIndex(a => isLiteEqual(a?.entity, lite));
      if (index == -1)
        elements.insertAt(1, { entity: lite } as ResultRow);
      else {
        if (!p.toStringFromData)
          elements[index]!.entity = lite;
      }
    }

    return elements;
  }
}
