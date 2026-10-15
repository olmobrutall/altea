// Ported from Signum.React/Lines/DateTimeLine.tsx — copy-paste + fix. altea fixes:
//   - luxon → Temporal: the value is a Temporal.PlainDate / PlainDateTime, and so are the calendar hooks
//     (min / max, renderDay, holiday titles). The picker is the ui DateTimePicker; formats are
//     Intl.DateTimeFormatOptions (was luxon token strings), mapped in ui/dateFormat.
//   - dropped dead imports (Exceptions/Exception, TypeContext); JavascriptMessage.Date button label
//     inlined (message container not ported).
import * as React from 'react';
import { classes } from '../../data/globals';
import { Temporal } from '../../data/basics';
import { Clock } from '../../data/utils/clock';
import { toDateFormatOptions, formatDateValue, weekInfo, type DateValue } from '../ui/dateFormat';
import { DateTimePicker } from '../ui/DateTimePicker';
import type { DayRender } from '../ui/Calendar';
import { genericMemo, LineBaseController, useController } from './LineBase';
import { FormGroup } from './FormGroup';
import { FormControlReadonly } from './FormControlReadonly';
import { ValueBaseController, type ValueBaseProps } from './ValueBase';
import { ariaLabelOf } from "./ariaLabel";


export interface DateTimeLineProps extends ValueBaseProps<DateValue | null> {
  showTimeBox?: boolean;
  minDate?: Temporal.PlainDate;
  maxDate?: Temporal.PlainDate;
  calendarAlignEnd?: boolean;
  renderDayAndTitle?: RenderDayAndTitle;
  ref?: React.Ref<DateTimeLineController>
}

export class DateTimeLineController extends ValueBaseController<DateTimeLineProps, DateValue | null>{
  override init(p: DateTimeLineProps): void {
    super.init(p);
    this.assertType("DateTimeLine", ["PlainDate", "PlainDateTime"]);
  }
}

export const DateTimeLine: (props: DateTimeLineProps) => React.ReactNode | null =
  genericMemo(function DateTimeLine(props: DateTimeLineProps) {

  const c = useController(DateTimeLineController, props);

  let rdat = DateTimeLineOptions.Options.useRenderDay();

  rdat = props.renderDayAndTitle ?? rdat;

  if (c.isHidden)
    return null;

  const p = c.props;
  const type = c.props.ctx.memberType!.typeName as "PlainDate" | "PlainDateTime";
  const options = toDateFormatOptions(p.format, type);

  const day = p.ctx.value == null ? undefined
    : p.ctx.value instanceof Temporal.PlainDate ? p.ctx.value : Clock.toUserInterface(p.ctx.value).toPlainDate();
  const showTime = p.showTimeBox != null ? p.showTimeBox : type != "PlainDate" && (options.timeStyle != null || options.hour != null);
  const monthOnly = options.year != null && options.month != null && options.day == null && options.dateStyle == null;

  const isLabelVisible = p.ctx.formGroupStyle !== "SrOnly";
  var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
  var htmlAtts = c.props.valueHtmlAttributes;
  // An aria-label the CALL SITE spelled out wins over the label: a visible label such as a bare "to" says
  // nothing about which range it ends, and ariaAtts is spread after valueHtmlAttributes.
  const explicitAriaLabel = htmlAtts?.["aria-label"];
  if (explicitAriaLabel)
    ariaAtts = { ...ariaAtts, "aria-label": explicitAriaLabel };
  else if (!isLabelVisible) {
    ariaAtts = { ...ariaAtts, "aria-label": ariaLabelOf(p.label, p.ctx) };
  }
  var mergedHtmlReadOnly = { ...htmlAtts, ...ariaAtts };

  const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
  const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

  var ht = day && rdat.getHolidayTitle(day);
  var holidayClass =
    ht?.type == "holiday" ? "sf-holiday" :
      ht?.type == "weekend" ? "sf-weekend" : undefined;

  if (p.ctx.readOnly)
    return (
      <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
        {inputId => c.withItemGroup(<FormControlReadonly id={inputId} htmlAttributes={{
          title: ht?.text,
          ...mergedHtmlReadOnly,
        }} className={classes(c.props.valueHtmlAttributes?.className, holidayClass, "sf-readonly-date", c.mandatoryClass)} ctx={p.ctx} innerRef={c.setRefs}>
          {p.ctx.value && formatDateValue(p.ctx.value, options)}
        </FormControlReadonly>)}
      </FormGroup>
    );

  const htmlAttributes = {
    placeholder: c.getPlaceholder(),
    ...c.props.valueHtmlAttributes,
  } as React.AllHTMLAttributes<any>;

  return (
    <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
      {inputId => c.withItemGroup(
        <DateTimePicker
          id={inputId}
          size={p.ctx.formSize}
          className={classes(c.mandatoryClass ? c.mandatoryClass + "-widget" : undefined)}
          inputClassName={classes(holidayClass, htmlAttributes.className, c.mandatoryClass)}
          value={p.ctx.value}
          onChange={v => c.setValue(v)}
          type={type}
          format={options}
          showTime={showTime}
          minView={monthOnly ? "year" : undefined}
          min={p.minDate}
          max={p.maxDate}
          renderDay={rdat.renderDay}
          align={p.calendarAlignEnd ? "end" : "start"}
          title={ht?.text}
          autoFocus={Boolean(c.props.initiallyFocused)}
          placeholder={htmlAttributes.placeholder as string | undefined}
          aria-label={ariaAtts["aria-label"]}
          aria-labelledby={(htmlAttributes as React.AriaAttributes)["aria-labelledby"]}
          aria-describedby={ariaAtts["aria-describedby"]}
          aria-invalid={ariaAtts["aria-invalid"] === true || ariaAtts["aria-invalid"] === "true"}
          aria-required={ariaAtts["aria-required"] === true || ariaAtts["aria-required"] === "true"} />
      )}
    </FormGroup>
  );
}, (prev, next) => {
  return LineBaseController.propEquals(prev, next);
});

export interface RenderDayAndTitle {
  renderDay: (date: Temporal.PlainDate) => DayRender | undefined,
  getHolidayTitle: (date: Temporal.PlainDate) => { type: "holiday" | "weekend", text: string } | null | undefined;
};

export namespace DateTimeLineOptions {

  export const Options = {
    useRenderDay: (() => ({
      renderDay: defaultRenderDay,
      getHolidayTitle: (d: Temporal.PlainDate) => isWeekend(d) ? {
        type: "weekend" as const,
        text: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(d.year, d.month - 1, d.day))
      } : undefined,
    })) as () => RenderDayAndTitle,
  };

  export function isWeekend(date: Temporal.PlainDate): boolean {
    return weekInfo().weekend.includes(date.dayOfWeek);
  }
}

/** The calendar already marks today and the weekend; an application's hook adds holidays. */
export function defaultRenderDay(_date: Temporal.PlainDate): DayRender | undefined {
  return undefined;
}
