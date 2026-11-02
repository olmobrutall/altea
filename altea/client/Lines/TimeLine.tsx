// Ported from Signum.React/Lines/TimeLine.tsx — copy-paste + fix. altea fixes:
//   - luxon Duration → Temporal. Signum used luxon `Duration.fromISOTime`/`toISOTime` (a single
//     "HH:MM:SS" model) for both TimeOnly and TimeSpan. altea has TWO distinct Temporal types —
//     `PlainTime` (time-of-day, typeName "PlainTime") and `Duration` (elapsed, typeName "Duration") —
//     so the stored ISO string differs per type ("HH:MM:SS" vs "PT1H30M"); the edit box shows HH:MM:SS.
//   - dropped Reflection duration-format helpers (toLuxonDurationFormat/timeToString/timePlaceholder);
//     display is a fixed HH:MM:SS for now (TODO: honor p.format).
import * as React from 'react';
import { classes } from '../../data/globals';
import { Temporal } from '../../data/basics';
import { genericMemo, LineBaseController, useController } from './LineBase';
import { FormGroup } from './FormGroup';
import { FormControlReadonly } from './FormControlReadonly';
import { ValueBaseController, type ValueBaseProps } from './ValueBase';
import { isNumberKey } from './NumberLine';
import { ariaLabelOf } from "./ariaLabel";

// An entity's PlainTime / Duration field holds the Temporal value (what the serializer materialises); a
// filter value may still be its ISO string. The line reads both and writes back the form it was given.
type TimeValue = Temporal.PlainTime | Temporal.Duration | string;

export interface TimeLineProps extends ValueBaseProps<TimeValue | null> {
  ref?: React.Ref<TimeLineController>
}

export class TimeLineController extends ValueBaseController<TimeLineProps, TimeValue | null> {
  override init(p: TimeLineProps): void {
    super.init(p);
    this.assertType("TimeLine", ["PlainTime", "Duration"]);
  }
}

type TimeKind = "PlainTime" | "Duration";

function pad(n: number): string { return n.toString().padStart(2, "0"); }

// Stored value → "HH:MM:SS" display. Never `value == ""` on a Temporal: a loose comparison calls valueOf,
// which Temporal throws on.
function timeToHHMMSS(value: TimeValue | null, kind: TimeKind): string {
  if (value == null || (typeof value == "string" && value == "")) return "";
  try {
    if (kind == "PlainTime") {
      const t = Temporal.PlainTime.from(value as Temporal.PlainTime | string);
      return `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
    }
    const d = Temporal.Duration.from(value as Temporal.Duration | string);
    return `${pad(d.hours)}:${pad(d.minutes)}:${pad(d.seconds)}`;
  } catch { return ""; }
}

// "HH:MM:SS" (already casual-fixed) → the Temporal value, or its ISO string when the line was given one.
function hhmmssToStored(str: string, kind: TimeKind, asString: boolean): TimeValue | null {
  const parts = str.split(":").map(s => parseInt(s, 10));
  if (parts.some(isNaN)) return null;
  const [h = 0, m = 0, s = 0] = parts;
  try {
    const value = kind == "PlainTime"
      ? Temporal.PlainTime.from({ hour: h, minute: m, second: s })
      : Temporal.Duration.from({ hours: h, minutes: m, seconds: s });
    return asString ? value.toString() : value;
  } catch { return null; }
}


export const TimeLine: (props: TimeLineProps) => React.ReactNode | null =
  genericMemo(function TimeLine(props: TimeLineProps) {

    const c = useController(TimeLineController, props);

    if (c.isHidden)
      return null;

    const p = c.props;
    const kind = (p.ctx.memberType!.typeName == "PlainTime" ? "PlainTime" : "Duration") as TimeKind;

    const isLabelVisible = p.ctx.formGroupStyle !== "SrOnly";
    var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
    if (!isLabelVisible) {
      ariaAtts = { ...ariaAtts, "aria-label": ariaLabelOf(p.label, p.ctx) };
    }

    var htmlAtts = c.props.valueHtmlAttributes;
    var mergedHtmlReadOnly = { ...htmlAtts, ...ariaAtts };

    const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
    const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

    if (p.ctx.readOnly) {
      return (
        <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
          {inputId => c.withItemGroup(
            <FormControlReadonly id={inputId} htmlAttributes={mergedHtmlReadOnly} ctx={p.ctx} className={classes(c.props.valueHtmlAttributes?.className, "numeric")} innerRef={c.setRefs}>
              {timeToHHMMSS(p.ctx.value, kind)}
            </FormControlReadonly>
          )}
        </FormGroup>
      );
    }

    const handleOnChange = (newValue: TimeValue | null) => {
      c.setValue(newValue);
    };

    const htmlAttributes = {
      placeholder: c.getPlaceholder(),
      ...c.props.valueHtmlAttributes
    } as React.AllHTMLAttributes<any>;
    var mergedHtml = { ...htmlAttributes, ...ariaAtts };

    if (htmlAttributes.placeholder == undefined)
      htmlAttributes.placeholder = "hh:mm:ss";

    return (
      <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
        {inputId => c.withItemGroup(
          <TimeTextBox htmlAttributes={mergedHtml}
            id={inputId}
            value={p.ctx.value}
            onChange={handleOnChange}
            validateKey={isDurationKey}
            kind={kind}
            formControlClass={classes(p.ctx.formControlClass, c.mandatoryClass)}
            innerRef={c.setRefs} />
        )}
      </FormGroup>
    );
  }, (prev, next) => {
    return LineBaseController.propEquals(prev, next);
  });



export interface TimeTextBoxProps {
  value: TimeValue | null;
  onChange: (newValue: TimeValue | null) => void;
  validateKey: (e: React.KeyboardEvent<any>) => boolean;
  formControlClass?: string;
  kind: TimeKind;
  htmlAttributes?: React.InputHTMLAttributes<HTMLInputElement>;
  innerRef?: React.Ref<HTMLInputElement>;
  id?: string;
}

export function TimeTextBox(p: TimeTextBoxProps): React.ReactElement {

  const [text, setText] = React.useState<string | undefined>(undefined);

  const value = text != undefined ? text :
    p.value != undefined ? timeToHHMMSS(p.value, p.kind) :
      "";

  return <input
    id={p.id}
    ref={p.innerRef}
    autoComplete="off"
    {...p.htmlAttributes}
    type="text"
    className={classes(p.htmlAttributes?.className, p.formControlClass, "numeric")}
    value={value}
    onBlur={handleOnBlur}
    onChange={handleOnChange}
    onKeyDown={handleKeyDown}
    onFocus={handleOnFocus} />


  function handleOnFocus(e: React.FocusEvent<any>) {
    const input = e.currentTarget as HTMLInputElement;

    input.setSelectionRange(0, input.value != null ? input.value.length : 0);

    if (p.htmlAttributes && p.htmlAttributes.onFocus)
      p.htmlAttributes.onFocus(e);
  };


  function handleOnBlur(e: React.FocusEvent<any>) {

    const input = e.currentTarget as HTMLInputElement;

    const result = input.value == undefined || input.value.length == 0 ? null
      : hhmmssToStored(fixCasual(input.value), p.kind, typeof p.value == "string");
    setText(undefined);
    if (timeToHHMMSS(p.value, p.kind) != timeToHHMMSS(result, p.kind))
      p.onChange(result);
    if (p.htmlAttributes && p.htmlAttributes.onBlur)
      p.htmlAttributes.onBlur(e);
  }

  function handleOnChange(e: React.SyntheticEvent<any>) {
    const input = e.currentTarget as HTMLInputElement;
    setText(input.value);
  }

  function handleKeyDown(e: React.KeyboardEvent<any>) {
    if (!p.validateKey(e))
      e.preventDefault();
  }

  function fixCasual(val: string) {

    if (val.includes(":"))
      return val.split(":").map(a => a.padStart(2, "0")).join(":");

    if (val.length == 1)
      return "0" + val + "00";

    if (val.length == 2)
      return val + "00";

    if (val.length == 3)
      return "0" + val;

    return val;
  }

}

export function isDurationKey(e: React.KeyboardEvent<any>): boolean {
  return isNumberKey(e) || e.key == ":";
}
