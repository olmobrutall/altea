// Ported from Signum.React/Lines/NumberLine.tsx — copy-paste + fix. altea fixes:
//   - dropped dead imports (luxon DateTime/Duration, unused Reflection date/enum helpers,
//     BooleanEnum/JavascriptMessage, Components/TextArea) that the ported code never used.
//   - KeyNames from altea ../Components; toNumberFormat/numberLimits from ../Reflection;
//     ValidationMessage from ../../entities/validators.
//   - decimal-key detection: altea's decimal type name is "Decimal" (was Signum's lowercase "decimal").
import * as React from 'react'
import { classes } from '../../data/globals'
import { toNumberFormat, numberLimits } from '../numberFormat'
import { Decimal } from '../../data/basics'

// A NumberLine value is a plain `number`, except a `Decimal` (decimal.js) field holds a Decimal object.
// These bridge the two: `decToNum` for the number-based display/increment mechanics, `wrapDecimal` to
// store the edited value back as a Decimal (so a decimal column keeps exact decimal semantics).
function decToNum(v: number | Decimal | null | undefined): number | null | undefined {
  return v instanceof Decimal ? v.toNumber() : v;
}
function numbersEqual(a: number | Decimal | null | undefined, b: number | Decimal | null | undefined): boolean {
  if (a == null || b == null) return a == b;
  return (a instanceof Decimal || b instanceof Decimal) ? new Decimal(a as Decimal.Value).eq(b as Decimal.Value) : a === b;
}
import { genericMemo, LineBaseController, useController } from './LineBase'
import { FormGroup } from './FormGroup'
import { FormControlReadonly } from './FormControlReadonly'
import { KeyNames } from '../Components'
import { ValueBaseController, type ValueBaseProps } from './ValueBase'
import { ValidationMessage } from '../../data/validators'

export interface NumberLineProps extends ValueBaseProps<number | null> {
  incrementWithArrow?: boolean | number;
  minValue?: number | null;
  maxValue?: number | null;
  datalist?: number[];
  ref?: React.Ref<NumberLineController>;
}

export class NumberLineController extends ValueBaseController<NumberLineProps, number | null>{
}

export const NumberLine: (props: NumberLineProps) => React.ReactNode | null =
  genericMemo(function NumberLine(props: NumberLineProps) {

  const c = useController(NumberLineController, props);

  if (c.isHidden)
    return null;

  return numericTextBox(c, c.props.ctx.memberType!.typeName == "Decimal" ? isDecimalKey : isNumberKey);
}, (prev, next) => {
  if (next.extraButtons || prev.extraButtons)
    return false;

  return LineBaseController.propEquals(prev, next);
});


function numericTextBox(c: NumberLineController, validateKey: (e: React.KeyboardEvent<any>) => boolean) {
  const p = c.props

  const numberFormat = toNumberFormat(p.format);
  const isDecimal = p.ctx.memberType?.typeName === "Decimal";

  const isLabelVisible = !(p.ctx.formGroupStyle === "SrOnly" || "visually-hidden");
  var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
  if (!isLabelVisible && p.label) {
    ariaAtts = { ...ariaAtts, "aria-label": typeof p.label === "string" ? p.label : String(p.label) };
  }

  var htmlAtts = c.props.valueHtmlAttributes;
  var mergedHtmlReadOnly = { ...htmlAtts, ...ariaAtts };

  const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
  const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

  if (p.ctx.readOnly)
    return (
      <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
        {inputId => c.withItemGroup(
          <FormControlReadonly id={inputId} htmlAttributes={mergedHtmlReadOnly} ctx={p.ctx} className={classes("numeric", c.mandatoryClass)} innerRef={c.setRefs}>
            {p.ctx.value == null ? "" : numberFormat.format(decToNum(p.ctx.value)!)}
          </FormControlReadonly>)}
      </FormGroup>
    );

  const handleOnChange = (newValue: number | Decimal | null) => {
    c.setValue(newValue as any); // a Decimal field stores a Decimal; NumberLineController is typed number|null
  };

  var incNumber = typeof c.props.incrementWithArrow == "number" ? c.props.incrementWithArrow : 1;

  const wrap = (n: number): number | Decimal => isDecimal ? new Decimal(n) : n;
  const handleKeyDown = (e: React.KeyboardEvent<any>) => {
    const cur = decToNum(p.ctx.value) ?? 0;
    if (e.key == KeyNames.arrowDown) {
      e.preventDefault();
      c.setValue(wrap(cur - incNumber) as any, e);
    } else if (e.key == KeyNames.arrowUp) {
      e.preventDefault();
      c.setValue(wrap(cur + incNumber) as any, e);
    }
  }

  const htmlAttributes = {
    placeholder: c.getPlaceholder(),
    onKeyDown: (c.props.incrementWithArrow || c.props.incrementWithArrow == undefined ) ? handleKeyDown : undefined,
    ...c.props.valueHtmlAttributes
  } as React.AllHTMLAttributes<any>;
  var mergedHtml = { ...htmlAttributes, ...ariaAtts };

  const limits = numberLimits[p.ctx.memberType?.subTypeName!];

  return (
    <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
      {inputId => <>
        {c.withItemGroup(
          <NumberBox
            id={inputId}
            minValue={p.minValue != undefined ? p.minValue : limits?.min}
            maxValue={p.maxValue != undefined ? p.maxValue : limits?.max}
            htmlAttributes={mergedHtml}
            value={p.ctx.value}
            isDecimal={isDecimal}
            onChange={handleOnChange}
            formControlClass={classes(p.ctx.formControlClass, c.mandatoryClass)}
            validateKey={validateKey}
            format={numberFormat}
            innerRef={c.setRefs}
            datalist={p.datalist}
            datalistId={p.datalist ? p.ctx.getUniqueId("dataList") : undefined}
          />
        )}
        {p.datalist &&
          <datalist id={p.ctx.getUniqueId("dataList")}>
            {p.datalist.map((item, i) => <option key={i} value={item} />)}
          </datalist>
        }
      </>}
    </FormGroup>
  );
}

export interface NumberBoxProps {
  value: number | Decimal | null | undefined;
  readonly?: boolean;
  // A Decimal field parses input back into a Decimal (exact, from the typed string) rather than a number.
  isDecimal?: boolean;
  onChange: (newValue: number | Decimal | null) => void;
  validateKey: (e: React.KeyboardEvent<any>) => boolean;
  minValue?: number | null;
  maxValue?: number | null;
  format: Intl.NumberFormat;
  formControlClass?: string;
  htmlAttributes?: React.InputHTMLAttributes<HTMLInputElement>;
  innerRef?: ((ta: HTMLInputElement | null) => void) | React.RefObject<HTMLInputElement>;
  id?: string;
  datalist?: number[];
  datalistId?: string;
}

const cachedLocaleSeparators: {
  [locale: string]: { group: string, decimal: string }
} = {};

function getLocaleSeparators(locale: string) {
  var result = cachedLocaleSeparators[locale];
  if (result)
    return result;

  var format = new Intl.NumberFormat(locale, { minimumFractionDigits: 0 });
  result = {
    group: format.format(1111).replace(/1/g, ''),
    decimal: format.format(1.1).replace(/1/g, ''),
  };
  return cachedLocaleSeparators[locale] = result;
}


export function NumberBox(p: NumberBoxProps): React.ReactElement {

  const [text, setText] = React.useState<string | undefined>(undefined);


  const numValue = decToNum(p.value); // Decimal → number for display + range checks (see below)

  const value = text != undefined ? text :
    numValue != undefined ? p.format?.format(numValue) :
      "";

  const warning =
    numValue != null && p.minValue != null && numValue < p.minValue ? ValidationMessage.NumberIsTooSmall.niceToString() :
      numValue != null && p.maxValue != null && p.maxValue < numValue ? ValidationMessage.NumberIsTooBig.niceToString() :
        undefined;

  return <input ref={p.innerRef}
    autoComplete="off"
    {...p.htmlAttributes}
    id={p.id}
    readOnly={p.readonly}
    type="text"
    className={classes(p.htmlAttributes?.className, p.formControlClass, "numeric", warning && "border-warning")} value={value}
    title={warning}
    onBlur={handleOnBlur}
    onChange={handleOnChange}
    onKeyDown={handleKeyDown}
    onFocus={handleOnFocus}
    list={p.datalistId} />


  function handleOnFocus(e: React.FocusEvent<any>) {
    const input = e.currentTarget as HTMLInputElement;

    input.setSelectionRange(0, input.value != null ? input.value.length : 0);

    if (p.htmlAttributes && p.htmlAttributes.onFocus)
      p.htmlAttributes.onFocus(e);
  };

  function triggetOnBlur() {
    if (text != null) {
      let value = NumberLineController.autoFixString(text, false, false);

      const result = value == undefined || value.length == 0 ? null : unformat(p.format, value);
      setText(undefined);
      if (!numbersEqual(result, p.value))
        p.onChange(result);
    }
  }


  function handleOnBlur(e: React.FocusEvent<any>) {
    if (!p.readonly) {
      triggetOnBlur();
    }

    if (p.htmlAttributes && p.htmlAttributes.onBlur)
      p.htmlAttributes.onBlur(e);
  }


  function unformat(format: Intl.NumberFormat, str: string): number | Decimal {

    var options = format.resolvedOptions();

    var isPercentage = options.style == "percent";

    var separators = getLocaleSeparators(options.locale);

    if (separators.group)
      str = str.replace(new RegExp('\\' + separators.group, 'g'), '');

    if (separators.decimal)
      str = str.replace(new RegExp('\\' + separators.decimal), '.');

    // A Decimal field parses the cleaned string DIRECTLY into a Decimal (exact — no float round-trip);
    // a percent divides by 100 in decimal too.
    if (p.isDecimal) {
      const d = new Decimal(str);
      return isPercentage ? d.div(100) : d;
    }

    var result = parseFloat(str);

    if (isPercentage)
      return result / 100;

    return result;
  }

  function handleOnChange(e: React.SyntheticEvent<any>) {
    if (!p.readonly) {
      const input = e.currentTarget as HTMLInputElement;
      setText(input.value);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<any>) {

    if (!p.validateKey(e)) {
      if (e.ctrlKey || e.altKey) //possible shortcut
        triggetOnBlur();
      e.preventDefault();
    }
    else {
      var atts = p.htmlAttributes;
      atts?.onKeyDown && atts.onKeyDown(e);
    }
  }
}

export function isNumberKey(e: React.KeyboardEvent<any>): boolean {
  const c = e.key;
  return ((c >= '0' && c <= '9' && !e.shiftKey) /*0-9*/ ||
    (c == KeyNames.enter) ||
    (c == KeyNames.backspace) ||
    (c == KeyNames.tab) ||
    (c == KeyNames.esc) ||
    (c == KeyNames.arrowLeft) ||
    (c == KeyNames.arrowRight) ||
    (c == KeyNames.arrowUp) ||
    (c == KeyNames.arrowDown) ||
    (c == KeyNames.delete) ||
    (c == KeyNames.home) ||
    (c == KeyNames.end) ||
    (c == KeyNames.numpadMinus) /*NumPad -*/ ||
    (c == KeyNames.minus) /*-*/ ||
    (e.ctrlKey && c == 'v') /*Ctrl + v*/ ||
    (e.ctrlKey && c == 'x') /*Ctrl + x*/ ||
    (e.ctrlKey && c == 'c') /*Ctrl + c*/);
}

export function isDecimalKey(e: React.KeyboardEvent<any>): boolean {
  return (isNumberKey(e) ||
    (e.key == "Separator") /*NumPad Decimal*/ ||
    (e.key == ".") /*.*/ ||
    (e.key == ",") /*,*/);
}
