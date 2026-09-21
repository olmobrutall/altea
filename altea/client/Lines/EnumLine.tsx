import { ariaLabelOf } from "./ariaLabel";
// Ported from Signum.React/Lines/EnumLine.tsx — copy-paste + fix. altea fixes:
//   - enum reflection: Signum read TypeInfo.kind=="Enum" + ti.members; altea enums are plain
//     registered TS enums (numeric, serialized as numbers) — getOptionsItems enumerates the enum
//     object via resolveEnum(typeName). Member LABELS come from `Enum.niceName`, the resolver behind
//     Signum's `member.niceName` (loaded translation → setNiceName → humanised PascalCase).
//   - type is a FieldInfo: .name→.typeName, .isNotNullable→!.isNullable; boolean typeName is "Boolean".
//   - DropdownList/Combobox (react-widgets) take their localizers and message strings from the
//     app-wide <ReactWidgetsLocalization> around the router. A plain <select> needs none.
import * as React from 'react'
import { DropdownList, Combobox } from 'react-widgets-up'
import { useDropdownListSearchLabel } from '../Components/DropdownListSearch'
import { Dic, classes } from '../../data/globals'
import { Enum } from '../../data/enum'
import { BooleanEnum } from '../../data/uiMessages'
import { type MemberInfo } from '../Reflection'
import { genericMemo, LineBaseController, useController } from './LineBase'
import { FormGroup } from './FormGroup'
import { FormControlReadonly } from './FormControlReadonly'
import { getTimeMachineIcon } from './TimeMachineIcon'
import { ValueBaseController, type ValueBaseProps } from './ValueBase'


export interface EnumLineProps<V extends string | number | boolean | null> extends ValueBaseProps<V> {
  lineType?:
  "DropDownList" | /*For Enums! (only values in optionItems can be selected)*/
  "ComboBoxText" | /*For Text! (with freedom to choose a different value not in optionItems)*/
  "RadioGroup";
  emptyLabel?: string;
  optionItems?: (OptionItem | MemberInfo | V)[];
  onRenderDropDownListItem?: (oi: OptionItem) => React.ReactNode;
  optionHtmlAttributes?: (oi: OptionItem) => React.OptionHTMLAttributes<HTMLOptionElement>;
  columnCount?: number;
  columnWidth?: number;
  ref?: React.Ref<EnumLineController<V>>;
}

export class EnumLineController<V extends string | number | boolean | null> extends ValueBaseController<EnumLineProps<V>, V> {

}

export interface OptionItem {
  value: any;
  label: string;
}

export const EnumLine: <V extends string | number | boolean | null>(props: EnumLineProps<V>) => React.ReactNode | null
  = genericMemo(function EnumLine<V extends string | number | boolean | null>(props: EnumLineProps<V>) {

    const c = useController(EnumLineController<V>, props);

    if (c.isHidden)
      return null;

    return props.lineType == 'ComboBoxText' ? internalComboBoxText(c) :
      props.lineType == 'RadioGroup' ? internalRadioGroup(c) :
        internalDropDownList(c);
  }, (prev, next) => {
    if (prev.optionHtmlAttributes || next.optionHtmlAttributes)
      return false;

    if (prev.onRenderDropDownListItem || next.onRenderDropDownListItem)
      return false;

    return LineBaseController.propEquals(prev, next);
  });

function internalDropDownList<V extends string | number | boolean | null>(c: EnumLineController<V>) {

  var optionItems = getOptionsItems(c);
  const p = c.props;

  // The aria-label in valueHtmlAttributes never arrives: DropdownListInput destructures the props it knows
  // and drops the rest. This is what actually names the widget and the typeahead input it builds itself.
  const searchLabel = useDropdownListSearchLabel(typeof p.label == "string" ? p.label : p.ctx.propertyRoute?.fieldInfo?.niceToString());
  if (p.ctx.memberType!.isNullable || p.ctx.value == undefined)
    optionItems = [{ value: null, label: p.emptyLabel ?? " - " }].concat(optionItems);

  const isLabelVisible = p.ctx.formGroupStyle !== "SrOnly";
  var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
  if (!isLabelVisible) {
    ariaAtts = { ...ariaAtts, "aria-label": ariaLabelOf(p.label, p.ctx) };
  }

  var htmlAtts = c.props.valueHtmlAttributes;
  var mergedHtml = { ...htmlAtts, ...ariaAtts };

  const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
  const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

  let niceValue: string | undefined = undefined;
  if (p.ctx.value != undefined) {

    var item = optionItems.filter(a => a.value == p.ctx.value).singleOrNull();

    niceValue = item ? item.label : p.ctx.value.toString();
  }

  if (p.ctx.readOnly) {

    return (
      <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
        {inputId =>
          c.withItemGroup(
            <FormControlReadonly
              id={inputId}
              htmlAttributes={{
                ...mergedHtml,
                ...({ 'data-value': p.ctx.value } as any), /*Testing*/
              }} ctx={p.ctx} innerRef={c.setRefs}>
              {c.props.onRenderDropDownListItem ? (p.ctx.value == undefined ? undefined : c.props.onRenderDropDownListItem({ label: niceValue!, value: p.ctx.value })) : niceValue}
            </FormControlReadonly>)
        }
      </FormGroup>
    );
  }

  if (c.props.onRenderDropDownListItem) {
    var oi = optionItems.singleOrNull(a => a.value == p.ctx.value) ?? {
      value: p.ctx.value,
      label: p.ctx.value,
    };

    function renderElement({ item }: any) {
      var result = c.props.onRenderDropDownListItem!(item) as React.ReactElement;
      return React.cloneElement(result, { 'data-value': item.value } as any);
    }

    return (
      <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
        {inputId => c.withItemGroup(
          <DropdownList<OptionItem> {...searchLabel} className={classes(c.props.valueHtmlAttributes?.className, p.ctx.formControlClass, c.mandatoryClass, "p-0")} data={optionItems}
            id={inputId}
            onChange={(oe, md) => c.setValue(oe.value, md.originalEvent)}
            value={oi}
            autoComplete="off"
            dataKey="value"
            textField="label"
            renderValue={renderElement}
            renderListItem={renderElement}
            title={niceValue}
            inputProps={{
              value: oi?.label ?? "",
              role: "combobox",
              "aria-haspopup": "listbox",
              "aria-expanded": false,
              "aria-controls": `${inputId}_listbox`,
              // `ariaLabelOf`, like the two sibling branches: a `label` prop may be a React ELEMENT, and
              // `String(element)` reaches the DOM as "[object Object]" (see ariaLabel.ts). It also
              // replaces a hardcoded German "Auswahl" that was the fallback here — the property's own
              // nice name is both localized and more specific.
              "aria-label": ariaLabelOf(p.label, p.ctx)
            }}
            listProps={{
              role: "listbox",
              id: `${inputId}_listbox`,
            }}
            {...(p.valueHtmlAttributes as any)}
          />
          )
        }
      </FormGroup>
    );
  } else {

    const handleEnumOnChange = (e: React.SyntheticEvent<any>) => {
      const input = e.currentTarget as HTMLInputElement;
      const option = optionItems.filter(a => toStr(a.value) == input.value).single();
      c.setValue(option.value, e);
    };

    return (
      <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
        {inputId => c.withItemGroup(
          // ariaAtts, like every sibling renderer: this branch passed them to the FormGroup only, so the
          // select itself carried no aria-required, aria-invalid or aria-describedby.
          <select id={inputId} title={niceValue} {...ariaAtts} {...c.props.valueHtmlAttributes} value={toStr(p.ctx.value)} className={classes(c.props.valueHtmlAttributes?.className, p.ctx.formSelectClass, c.mandatoryClass)} onChange={handleEnumOnChange} >
            {!optionItems.some(a => toStr(a.value) == toStr(p.ctx.value)) && <option key={-1} value={toStr(p.ctx.value)}>{toStr(p.ctx.value)}</option>}
            {optionItems.map((oi, i) => <option key={i} value={toStr(oi.value)} {...p.optionHtmlAttributes?.(oi)}>{oi.label}</option>)}
          </select>)
        }
      </FormGroup>
    );
  }
}

function toStr(val: any) {
  return val == null ? "" :
    val === true ? "True" :
      val === false ? "False" :
        val.toString();
}

function internalComboBoxText<V extends string | number | boolean | null>(c: EnumLineController<V>) {

  var optionItems = getOptionsItems(c);

  const p = c.props;
  if (p.ctx.memberType!.isNullable || p.ctx.value == undefined)
    optionItems = [{ value: null, label: " - " }].concat(optionItems);

  const isLabelVisible = p.ctx.formGroupStyle !== "SrOnly";
  var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
  if (!isLabelVisible) {
    ariaAtts = { ...ariaAtts, "aria-label": ariaLabelOf(p.label, p.ctx) };
  }

  var htmlAtts = c.props.valueHtmlAttributes;
  var mergedHtmlReadOnly = { ...htmlAtts, ...ariaAtts };

  if (p.ctx.readOnly) {

    var label: string | null = null;
    if (p.ctx.value != undefined) {

      var item = optionItems.filter(a => a.value == p.ctx.value).singleOrNull();

      label = item ? item.label : p.ctx.value.toString();
    }

    const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
    const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

    return (
      <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
        {inputId => c.withItemGroup(
          <FormControlReadonly id={inputId} htmlAttributes={{
            ...mergedHtmlReadOnly,
            ...({ 'data-value': p.ctx.value } as any) /*Testing*/
          }} ctx={p.ctx} innerRef={c.setRefs}>
            {label}
          </FormControlReadonly>)}
      </FormGroup>
    );
  }

  const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
  const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

  var renderItem = c.props.onRenderDropDownListItem ? (a: any) => c.props.onRenderDropDownListItem!(a.item) : undefined;

  return (
    <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
      {inputId => c.withItemGroup(
        <Combobox<OptionItem>
          id={inputId}
          className={classes(c.props.valueHtmlAttributes?.className, p.ctx.formControlClass, c.mandatoryClass)} data={optionItems}
          onChange={(e: string | OptionItem, md) => {
            c.setValue((e == null ? null : typeof e == "string" ? e : e.value) as V, md.originalEvent);
          }}
          value={p.ctx.value}
          dataKey="value"
          textField="label"
          focusFirstItem
          autoSelectMatches
          renderListItem={renderItem}
          {...(p.valueHtmlAttributes as any)}
        />
      )
      }
    </FormGroup>
  );
}

function internalRadioGroup<V extends string | number | boolean | null>(c: EnumLineController<V>) {

  var optionItems = getOptionsItems(c);
  const baseId = React.useId();

  const p = c.props;
  var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();

  const handleEnumOnChange = (e: React.SyntheticEvent<any>) => {
    const input = e.currentTarget as HTMLInputElement;
    const option = optionItems.filter(a => toStr(a.value).toLowerCase() == input.value.toLowerCase()).single();
    c.setValue(option.value, e);
  };

  const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
  const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

  return (
    <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
      {inputId => <>
        {getTimeMachineIcon({ ctx: p.ctx })}
        <div style={getColumnStyle()}>
          {optionItems.map((oi, i) =>
            <label key={i} htmlFor={baseId + "-" + i} {...c.props.valueHtmlAttributes} className={classes("sf-radio-element", c.getErrorClass())}>
              <input id={baseId + "-" + i} type="radio" value={oi.value} checked={p.ctx.value == oi.value} onChange={handleEnumOnChange} disabled={p.ctx.readOnly} />
              {c.props.onRenderDropDownListItem ? <>{" "}{c.props.onRenderDropDownListItem(oi)}</> : (" " + oi.label)}
            </label>)}
        </div>
      </>}
    </FormGroup>
  );

  function getColumnStyle(): React.CSSProperties | undefined {

    const p = c.props;

    if (p.columnCount && p.columnWidth)
      return {
        columns: `${p.columnCount} ${p.columnWidth}px`,
      };

    if (p.columnCount)
      return {
        columnCount: p.columnCount,
      };

    if (p.columnWidth)
      return {
        columnWidth: p.columnWidth,
      };

    return undefined;
  }
}


// ALTEA: enumerate the registered enum object (Signum used TypeInfo.members). Numeric TS enums carry
// reverse-mapping numeric keys, so keep only the string member names; value is the enum's stored
// value (number for a numeric enum). The LABEL is the member's localized nice name — `Enum.niceName`
// (data/enum) is the resolver Signum's `member.niceName` is, falling back to the humanised PascalCase
// name, so a dropdown reads "First node" rather than "FirstNode".
function enumMemberNames(enumObj: object): string[] {
  return Object.keys(enumObj).filter(k => isNaN(Number(k)));
}

function getOptionsItems(el: EnumLineController<any>): OptionItem[] {

  // ALTEA: enum fields are thunked (`field({ type: () => Sex, enum: true })`) so `typeName` is undefined;
  // resolve the enum object via the thunk (fieldEnum). `typeName` stays for the nullable-Boolean branch.
  const typeName = el.props.ctx.memberType!.typeName;
  const enumObj = el.props.ctx.memberType!.getEnum();

  if (el.props.optionItems) {
    return el.props.optionItems
      .map(a => typeof a == "string" && enumObj != null ? { value: (enumObj as any)[a], label: Enum.niceName(enumObj as never, a as never) } : toOptionItem(a))
      .filter(a => !!a);
  }

  // The nullable-Boolean dropdown: labelled from BooleanEnum (data/uiMessages), so it reads No/Yes —
  // Nein/Ja, No/Sí — rather than the raw member names.
  if (typeName == "Boolean")
    return ([
      { label: Enum.niceName(BooleanEnum, "False"), value: false },
      { label: Enum.niceName(BooleanEnum, "True"), value: true }
    ]);

  if (enumObj != null)
    return enumMemberNames(enumObj).map(name => ({ value: (enumObj as any)[name], label: Enum.niceName(enumObj as never, name as never) }));

  throw new Error("Unable to get Options from " + typeName);
}

function toOptionItem(m: MemberInfo | OptionItem | string): OptionItem {

  if (typeof m == "string" || typeof m == "number")
    return {
      value: m,
      label: String(m),
    };

  if ((m as MemberInfo).name)
    return {
      value: (m as MemberInfo).name,
      label: (m as MemberInfo).niceToString(),
    };

  return m as OptionItem;
}
