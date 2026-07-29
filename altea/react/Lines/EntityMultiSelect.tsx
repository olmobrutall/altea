// Ported from Signum.React/Lines/EntityMultiSelect.tsx onto altea's EntityListBase. A VALUE line
// (super(true)): a react-widgets Multiselect over the @valueField's option lites; the stored list is
// R[] of rows, each wrapping one selected value. altea fixes: no MList/isMListElement — the widget's
// `value` items are ROWS (BaseEntity) and its `data` items are option ResultRows, disambiguated by
// `instanceof BaseEntity`; select maps each to its value lite and diffs against the current rows
// (`addValue` for new, `removeElement` for deselected). showType keys off the @valueField's type.
import * as React from 'react'
import type { ResultRow, ResultTable } from '../../entities/dynamicQuery/queryRequest'
import { BaseEntity, Entity } from '../../entities/entity'
import { Lite } from '../../entities/lite'
import { EntityListBaseController, type EntityListBaseProps, tryGetValueField } from './EntityListBase'
import { fieldTypeName } from '../../entities/reflection'
import { Navigator } from '../Navigator'
import { Multiselect } from 'react-widgets-up'
import { useController } from './LineBase'
import type { FindOptions } from '../FindOptions'
import { Finder } from '../Finder'
import { normalizeEmptyArray } from './EntityCombo'
import { useMounted } from '../Hooks'
import { FormGroup } from './FormGroup'
import { classes } from '../../entities/globals'

// null-safe entity/lite equality (BaseEntity has no `.is`).
function isLiteEqual(a?: Entity | Lite<Entity>, b?: Entity | Lite<Entity>): boolean {
  return a == null ? b == null : a.is(b);
}

// The lite for a value (Signum's getLite): a Lite passes through, an Entity is lite-ified.
function getLite(value: unknown): Lite<Entity> {
  if (value instanceof Lite)
    return value;
  if (value instanceof Entity)
    return value.toLite();
  throw new Error("EntityMultiSelect: unexpected value " + JSON.stringify(value));
}

export interface EntityMultiSelectProps<R extends BaseEntity> extends EntityListBaseProps<R> {
  onRenderItem?: (item: ResultRow) => React.ReactNode;
  showType?: boolean;
  data?: Lite<Entity>[];
  toStringFromData?: boolean;
  delayLoadData?: boolean;
  deps?: React.DependencyList;
  ref?: React.Ref<EntityMultiSelectController<R>>
}

export class EntityMultiSelectController<R extends BaseEntity> extends EntityListBaseController<EntityMultiSelectProps<R>, R> {

  // Value line: each selected option is stored as a row wrapping the value on its @valueField.
  constructor() {
    super(true);
  }

  override overrideProps(p: EntityMultiSelectProps<R>, overridenProps: EntityMultiSelectProps<R>): void {
    super.overrideProps(p, overridenProps);

    if (p.type) {
      if (p.showType == undefined) {
        const vf = tryGetValueField(fieldTypeName(p.type) ?? "");
        p.showType = (fieldTypeName(vf ?? p.type) ?? "").contains(",");
      }
    }
  }

  handleOnSelect = (lites: (Lite<Entity> | Entity)[]): void => {
    var current = this.props.ctx.value;

    lites.filter(lite => !current.some(row => isLiteEqual(this.getElementValue(row) as Entity | Lite<Entity>, lite)))
      .forEach(lite => this.addValue(lite));

    current.filter(row => !lites.some(lite => isLiteEqual(lite, this.getElementValue(row) as Entity | Lite<Entity>)))
      .forEach(row => this.removeElement(row));

    this.forceUpdate();
  }
}

export function EntityMultiSelect<R extends BaseEntity>(props: EntityMultiSelectProps<R>): React.JSX.Element | null {
  const c = useController<EntityMultiSelectController<R>, EntityMultiSelectProps<R>, R[]>(EntityMultiSelectController, props);
  const p = c.props;

  if (c.isHidden)
    return null;

  const [data, _setData] = React.useState<Lite<Entity>[] | ResultTable | undefined>(p.data);
  const [loadData] = React.useState<boolean>(!p.delayLoadData);
  const requestStarted = React.useRef(false);
  const mounted = useMounted();

  function setData(data: Lite<Entity>[] | ResultTable) {
    if (mounted.current)
      _setData(data);
  }

  React.useEffect(() => {
    if (p.data) {
      if (requestStarted.current)
        console.warn(`The 'data' was set too late. Consider using [] as default value to avoid automatic query. EntityMultiSelect: ${fieldTypeName(p.type!)}`);
      setData(p.data);
    } else if (loadData) {
      requestStarted.current = true;
      const fo = p.findOptions;
      if (fo) {
        Finder.getResultTable(Finder.defaultNoColumnsAllRows(fo, undefined))
          .then(data => setData(data));
      }
      else
        // ALTEA: options come from the @valueField's type (Signum used p.type directly).
        Finder.API.fetchAllLites({ types: fieldTypeName(c.getValueField()!) ?? "" })
          .then(data => setData(data.orderBy(a => a.toString())));
    }
  }, [normalizeEmptyArray(p.data), fieldTypeName(p.type!), p.deps, loadData, p.findOptions && Finder.findOptionsPath(p.findOptions)]);

  var optionsRows = getOptionRows();

  const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
  const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

  // TODO(port): TimeMachineIcon.
  return (
    <FormGroup ctx={p.ctx!} error={p.error} label={p.label} labelIcon={p.labelIcon}
      labelHtmlAttributes={p.labelHtmlAttributes}
      helpText={helpText}
      helpTextOnTop={helpTextOnTop}
      htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }}>
      {inputId => <div className={classes(p.ctx.rwWidgetClass, c.mandatoryClass ? c.mandatoryClass + "-widget" : undefined)}>
        <Multiselect<any>
          id={inputId}
          readOnly={p.ctx.readOnly}
          dataKey={(item: any) => item instanceof BaseEntity ? getLite(c.getElementValue(item as R)).key() : (item as ResultRow).entity!.key()}
          textField="name"
          value={p.ctx.value}
          data={optionsRows as any}
          onChange={(value: any[]) => c.handleOnSelect(value.map(e => e instanceof BaseEntity ? (c.getElementValue(e as R) as Lite<Entity> | Entity) : (e as ResultRow).entity!))}
          renderListItem={({ item }: { item: any }) => p.onRenderItem ? p.onRenderItem(item as ResultRow) : Navigator.renderLite((item as ResultRow).entity!)}
          renderTagValue={({ item }: { item: any }) => item instanceof BaseEntity ? Navigator.renderLite(getLite(c.getElementValue(item as R))) :
            p.onRenderItem ? p.onRenderItem(item as ResultRow) : Navigator.renderLite((item as ResultRow).entity!)
          }
        />
      </div>}
    </FormGroup>
  );

  function getOptionRows() {

    var rows = Array.isArray(data) ? data.map(lite => ({ entity: lite } as ResultRow)) :
      typeof data == "object" ? data.rows :
        [];

    const elements: ResultRow[] = [...rows];

    p.ctx.value.forEach(row => {
      const lite = getLite(c.getElementValue(row));

      var index = elements.findIndex(a => isLiteEqual(a?.entity, lite));
      if (index == -1)
        elements.insertAt(1, { entity: lite } as ResultRow);
      else {
        if (!p.toStringFromData)
          elements[index]!.entity = lite;
      }
    });

    return elements;
  }
}
