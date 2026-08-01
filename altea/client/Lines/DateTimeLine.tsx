// Ported from Signum.React/Lines/DateTimeLine.tsx — copy-paste + fix. altea fixes:
//   - luxon → Temporal: the ISO string ⇄ Date boundary, weekend/holiday detection, and
//     trimDateToFormat use Temporal (temporal-polyfill); the picker's display/parse uses the
//     react-widgets Intl localizer (see ReactWidgetsLocalizer). Format is Intl.DateTimeFormatOptions
//     (was luxon token strings).
//   - dropped dead imports (Exceptions/Exception, TypeContext); JavascriptMessage.Date button label
//     inlined (message container not ported).
import * as React from 'react';
import type { CalendarProps } from 'react-widgets-up/Calendar'
import { DatePicker, Localization } from 'react-widgets-up';
import type { RenderDayProp } from 'react-widgets-up/Month';
import { Temporal } from '../../entities/basics';
import { classes } from '../../entities/globals';
import { getDateLocalizer, getNumberLocalizer, toDateFormatOptions, dateTimePlaceholder, formatDateValue } from './ReactWidgetsLocalizer';
import { genericMemo, LineBaseController, useController } from './LineBase';
import { FormGroup } from './FormGroup';
import { FormControlReadonly } from './FormControlReadonly';
import { ValueBaseController, type ValueBaseProps } from './ValueBase';

const dateLocalizer = getDateLocalizer();
const numberLocalizer = getNumberLocalizer();

export interface DateTimeLineProps extends ValueBaseProps<string | null> {
  showTimeBox?: boolean;
  minDate?: Date;
  maxDate?: Date;
  calendarProps?: Partial<CalendarProps>;
  calendarAlignEnd?: boolean;
  renderDayAndTitle?: RenderDayAndTitle;
  ref?: React.Ref<DateTimeLineController>
}

export class DateTimeLineController extends ValueBaseController<DateTimeLineProps, string | null>{
  override init(p: DateTimeLineProps): void {
    super.init(p);
    this.assertType("DateTimeLine", ["PlainDate", "PlainDateTime"]);
  }
}

// ISO string → JS Date at local wall-clock time (react-widgets works with JS Date). Accepts a Temporal
// value too: a deserialized entity carries its date fields as Temporal.PlainDate/PlainDateTime objects
// (the Serializer type-decodes them), while a wire/search value arrives as a string — toString() gives
// the ISO form in both cases.
export function isoToDate(value: string | { toString(): string }): Date {
  const iso = typeof value === "string" ? value : value.toString();
  if (iso.length <= 10) { // date-only "YYYY-MM-DD"
    const pd = Temporal.PlainDate.from(iso);
    return new Date(pd.year, pd.month - 1, pd.day);
  }
  const pdt = Temporal.PlainDateTime.from(iso.replace(/(Z|[+-]\d{2}:?\d{2})$/, "")); // wall time, drop tz
  return new Date(pdt.year, pdt.month - 1, pdt.day, pdt.hour, pdt.minute, pdt.second);
}

// JS Date → altea ISO string ("YYYY-MM-DD" for DateOnly, "YYYY-MM-DDTHH:mm:ss" otherwise).
function dateToIso(date: Date, dateOnly: boolean, withTime: boolean): string {
  if (dateOnly)
    return Temporal.PlainDate.from({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }).toString();
  return Temporal.PlainDateTime.from({
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    hour: withTime ? date.getHours() : 0, minute: withTime ? date.getMinutes() : 0, second: withTime ? date.getSeconds() : 0,
  }).toString();
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

  const jsDate = p.ctx.value ? isoToDate(p.ctx.value) : undefined;
  const showTime = p.showTimeBox != null ? p.showTimeBox : type != "PlainDate" && (options.timeStyle != null || options.hour != null);
  const monthOnly = options.year != null && options.month != null && options.day == null && options.dateStyle == null;

  const isLabelVisible = !(p.ctx.formGroupStyle === "SrOnly" || "visually-hidden");
  var ariaAtts = p.ctx.readOnly ? c.baseAriaAttributes() : c.extendedAriaAttributes();
  if (!isLabelVisible && p.label) {
    ariaAtts = { ...ariaAtts, "aria-label": typeof p.label === "string" ? p.label : String(p.label) };
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
    c.setValue(date == null ? null : dateToIso(date, type == "PlainDate", showTime));
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
          <Localization date={dateLocalizer} number={numberLocalizer}>
            <DatePicker
              id={inputId}
              value={jsDate} onChange={handleDatePickerOnChange} autoFocus={Boolean(c.props.initiallyFocused)}
              valueEditFormat={options}
              {...ariaAtts}
              valueDisplayFormat={options}
              includeTime={showTime}
              inputProps={htmlAttributes as any}
              placeholder={htmlAttributes.placeholder}
              min={p.minDate}
              max={p.maxDate}
              calendarProps={{
                renderDay: rdat.renderDay,
                views: monthOnly ? ["year", "decade", "century"] : undefined,
                ...p.calendarProps
              }} />
          </Localization>
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

// Trim an ISO date value to the precision implied by its format/type (Signum's trimDateToFormat,
// Temporal-based). DateOnly ⇒ strip any time; month/year-only format ⇒ first of the month.
// TODO(port): richer custom-format precision trimming if needed.
export function trimDateToFormat(iso: string, type: "PlainDate" | "PlainDateTime", format: string | undefined): string {
  const options = toDateFormatOptions(format, type);
  const monthOnly = options.year != null && options.month != null && options.day == null && options.dateStyle == null;

  if (type == "PlainDate" || monthOnly) {
    let pd = Temporal.PlainDate.from(iso.slice(0, 10));
    if (monthOnly)
      pd = pd.with({ day: 1 });
    return pd.toString();
  }
  return iso;
}
