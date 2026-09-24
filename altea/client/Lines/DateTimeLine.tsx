// Ported from Signum.React/Lines/DateTimeLine.tsx — copy-paste + fix. altea fixes:
//   - luxon → Temporal: the value is a Temporal.PlainDate / PlainDateTime; the Temporal ⇄ Date boundary the
//     picker needs, its Intl localizer and trimDateToFormat are in ReactWidgetsLocalizer. Format is
//     Intl.DateTimeFormatOptions (was luxon token strings).
//   - dropped dead imports (Exceptions/Exception, TypeContext); JavascriptMessage.Date button label
//     inlined (message container not ported).
import * as React from 'react';
import type { CalendarProps } from 'react-widgets-up/Calendar'
import { DatePicker } from 'react-widgets-up';
import type { RenderDayProp } from 'react-widgets-up/Month';
import { classes } from '../../data/globals';
import { toDateFormatOptions, dateTimePlaceholder, formatDateValue, dateValueToDate, dateToDateValue, type DateValue } from './ReactWidgetsLocalizer';
import { genericMemo, LineBaseController, useController } from './LineBase';
import { FormGroup } from './FormGroup';
import { FormControlReadonly } from './FormControlReadonly';
import { ValueBaseController, type ValueBaseProps } from './ValueBase';
import { ariaLabelOf } from "./ariaLabel";


export interface DateTimeLineProps extends ValueBaseProps<DateValue | null> {
  showTimeBox?: boolean;
  minDate?: Date;
  maxDate?: Date;
  calendarProps?: Partial<CalendarProps>;
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

  const jsDate = p.ctx.value ? dateValueToDate(p.ctx.value) : undefined;
  const showTime = p.showTimeBox != null ? p.showTimeBox : type != "PlainDate" && (options.timeStyle != null || options.hour != null);
  const monthOnly = options.year != null && options.month != null && options.day == null && options.dateStyle == null;

  const isLabelVisible = p.ctx.formGroupStyle !== "SrOnly";
  var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
  if (!isLabelVisible) {
    ariaAtts = { ...ariaAtts, "aria-label": ariaLabelOf(p.label, p.ctx) };
  }
  var htmlAtts = c.props.valueHtmlAttributes;
  var mergedHtmlReadOnly = { ...htmlAtts, ...ariaAtts };

  const helpText = p.helpText && (typeof p.helpText == "function" ? p.helpText(c) : p.helpText);
  const helpTextOnTop = p.helpTextOnTop && (typeof p.helpTextOnTop == "function" ? p.helpTextOnTop(c) : p.helpTextOnTop);

  var ht = jsDate && rdat.getHolidayTitle(jsDate);
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

  const handleDatePickerOnChange = (date: Date | null | undefined, str: string) => {
    c.setValue(date == null ? null : dateToDateValue(date, type == "PlainDate", showTime));
  };

  const htmlAttributes = {
    placeholder: c.getPlaceholder(),
    title: ht?.text,
    className: holidayClass,
    ...c.props.valueHtmlAttributes,
  } as React.AllHTMLAttributes<any>;

  if (htmlAttributes.placeholder === undefined)
    htmlAttributes.placeholder = dateTimePlaceholder(options);

  return (
    <FormGroup ctx={p.ctx} error={p.error} label={p.label} labelIcon={p.labelIcon} helpText={helpText} helpTextOnTop={helpTextOnTop} htmlAttributes={{ ...c.baseHtmlAttributes(), ...p.formGroupHtmlAttributes }} labelHtmlAttributes={p.labelHtmlAttributes} ariaAttributes={ariaAtts}>
      {inputId => c.withItemGroup(
        <div className={classes(p.ctx.rwWidgetClass, c.mandatoryClass ? c.mandatoryClass + "-widget" : undefined, p.calendarAlignEnd && "sf-calendar-end")}>
          <DatePicker
            id={inputId}
            value={jsDate} onChange={handleDatePickerOnChange} autoFocus={Boolean(c.props.initiallyFocused)}
            valueEditFormat={options}
            valueDisplayFormat={options}
            includeTime={showTime}
            // The ARIA attributes belong on the INPUT, not on the DatePicker. react-widgets puts props it
            // does not recognise on its root <div class="rw-date-picker">, which carries no role, so
            // aria-label there was ignored and the field had no accessible name at all. It cannot fall
            // back on the visible label either: react-widgets renames the id it is given to "<id>_input",
            // so the <label for> FormGroup rendered points at nothing.
            inputProps={{ ...htmlAttributes, ...ariaAtts } as any}
            placeholder={htmlAttributes.placeholder}
            min={p.minDate}
            max={p.maxDate}
            calendarProps={{
              renderDay: rdat.renderDay,
              views: monthOnly ? ["year", "decade", "century"] : undefined,
              ...p.calendarProps
            }} />
        </div>
      )}
    </FormGroup>
  );
}, (prev, next) => {
  return LineBaseController.propEquals(prev, next);
});

export interface RenderDayAndTitle {
  renderDay: RenderDayProp,
  getHolidayTitle: (date: Date) => { type: "holiday" | "weekend", text: string } | null | undefined;
};

function isWeekendDate(date: Date): boolean {
  const d = date.getDay(); // 0=Sun .. 6=Sat
  return d == 0 || d == 6;
}

export namespace DateTimeLineOptions {

  export const Options = {
    useRenderDay: (() => ({
      renderDay: defaultRenderDay,
      getHolidayTitle: (d: Date) => isWeekendDate(d) ? {
        type: "weekend" as const,
        text: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(d)
      } : undefined,
    })) as () => RenderDayAndTitle,
  };

  export function isWeekend(date: Date): boolean {
    return isWeekendDate(date);
  }
}

export function defaultRenderDay({ date, label }: { date: Date; label: string }): React.ReactElement {

  var today = isSameDay(date, new Date());

  return <span className={today ? "sf-today" : isWeekendDate(date) ? "sf-weekend" : undefined}> {label}</span >;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() == b.getFullYear() && a.getMonth() == b.getMonth() && a.getDate() == b.getDate();
}
