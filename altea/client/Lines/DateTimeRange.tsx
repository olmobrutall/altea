// Ported from Signum.React/Lines/DateTimeRange.tsx — copy-and-fix. Two DateTimeLines side-by-side that
// edit the min/max of a date range (the [from, to] value of a `Between` filter), with the calendar of
// each constrained by the other and the in-range days highlighted.
//
// altea fixes vs Signum:
//   - luxon → no date library: values are altea ISO strings; the calendar day key is the JS Date's local
//     "YYYY-MM-DD" and range membership is a plain string compare on the date part.
//   - DateTimeLine reads its type from `ctx.memberType` (Signum passed an explicit `type=` prop), so the
//     part ctx must already carry the date TypeReference; DateRangePartProps drops `type`.
//   - day styling flows through altea's `renderDayAndTitle` (RenderDayAndTitle) hook, not
//     `calendarProps.renderDay` — we wrap the base renderer and keep its holiday titles.
import * as React from 'react';
import type { CalendarProps } from 'react-widgets-up/Calendar';
import type { RenderDayProp } from 'react-widgets-up/Month';
import { StyleContext, TypeContext } from '../TypeContext';
import { DateTimeLine, DateTimeLineOptions, isoToDate, type RenderDayAndTitle } from './DateTimeLine';
import { FormGroup } from './FormGroup';
import type { ChangeEvent } from './LineBase';

export interface DateRangePartProps {
  ctx: TypeContext<string | null>;
  format?: string;
  minDate?: Date;
  maxDate?: Date;
  calendarProps?: Partial<CalendarProps>;
  calendarAlignEnd?: boolean;
  onChange?: (e: ChangeEvent) => void;
  valueHtmlAttributes?: React.AllHTMLAttributes<any>;
  labelHtmlAttributes?: React.LabelHTMLAttributes<HTMLLabelElement>;
  formGroupHtmlAttributes?: React.HTMLAttributes<any>;
  initiallyFocused?: boolean | number;
  helpText?: React.ReactNode;
  mandatory?: boolean | "warning";
}

export interface DateTimeRangeProps {
  min: DateRangePartProps;
  max: DateRangePartProps;
  mainCtx?: StyleContext;
  label?: React.ReactNode;
  labelHtmlAttributes?: React.LabelHTMLAttributes<HTMLLabelElement>;
  formGroupHtmlAttributes?: React.HTMLAttributes<any>;
}

function earlierDate(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return a < b ? a : b;
}

function laterDate(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}

// The date-part ("YYYY-MM-DD") of a JS Date in LOCAL time — the same basis isoToDate builds Dates on,
// so a calendar day compares equal to the range endpoints regardless of time component.
function jsDateToIsoDate(date: Date): string {
  const y = date.getFullYear().toString().padStart(4, "0");
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Wrap the base RenderDayAndTitle: keep its holiday title, but decorate the day cell with the range
// classes (sf-range-start / -end / -between) when it falls on/inside [minIso, maxIso].
function makeRangeRenderDayAndTitle(base: RenderDayAndTitle, minIso: string | null, maxIso: string | null): RenderDayAndTitle {
  const renderDay: RenderDayProp = ({ date, label }) => {
    const iso = jsDateToIsoDate(date);

    const isStart = minIso != null && iso === minIso;
    const isEnd = maxIso != null && iso === maxIso;
    const isBetween = minIso != null && maxIso != null && iso > minIso && iso < maxIso;

    const inner = base.renderDay({ date, label });

    if (!isStart && !isEnd && !isBetween)
      return inner;

    const cls = isStart && isEnd ? "sf-range-start sf-range-end"
      : isStart ? "sf-range-start"
        : isEnd ? "sf-range-end"
          : "sf-range-between";

    return <span className={cls}>{inner}</span>;
  };

  return { renderDay, getHolidayTitle: base.getHolidayTitle };
}

export function DateTimeRange(p: DateTimeRangeProps): React.ReactElement | null {

  const base = DateTimeLineOptions.Options.useRenderDay();

  const minIso = p.min.ctx.value ? jsDateToIsoDate(isoToDate(p.min.ctx.value)) : null;
  const maxIso = p.max.ctx.value ? jsDateToIsoDate(isoToDate(p.max.ctx.value)) : null;

  const minAsDate = p.min.ctx.value ? isoToDate(p.min.ctx.value) : undefined;
  const maxAsDate = p.max.ctx.value ? isoToDate(p.max.ctx.value) : undefined;

  const rangeRenderDay = makeRangeRenderDayAndTitle(base, minIso, maxIso);

  function renderPart(part: DateRangePartProps, srOnly: boolean, constraintMinDate: Date | undefined, constraintMaxDate: Date | undefined): React.ReactElement {
    const ctx = srOnly ? part.ctx.subCtx({ formGroupStyle: "SrOnly" }) : part.ctx;

    // merge caller constraints with range constraints — be maximally restrictive
    const effectiveMinDate = laterDate(part.minDate, constraintMinDate);
    const effectiveMaxDate = earlierDate(part.maxDate, constraintMaxDate);

    return (
      <DateTimeLine
        ctx={ctx}
        format={part.format}
        minDate={effectiveMinDate}
        maxDate={effectiveMaxDate}
        calendarProps={part.calendarProps}
        renderDayAndTitle={rangeRenderDay}
        calendarAlignEnd={part.calendarAlignEnd}
        onChange={part.onChange}
        valueHtmlAttributes={part.valueHtmlAttributes}
        labelHtmlAttributes={part.labelHtmlAttributes}
        formGroupHtmlAttributes={part.formGroupHtmlAttributes}
        initiallyFocused={part.initiallyFocused}
        helpText={part.helpText}
        mandatory={part.mandatory}
      />
    );
  }

  if (p.mainCtx) {
    return (
      <FormGroup ctx={p.mainCtx} label={p.label} labelHtmlAttributes={p.labelHtmlAttributes} htmlAttributes={p.formGroupHtmlAttributes}>
        {() => (
          <div className="d-flex gap-2">
            {renderPart(p.min, true, undefined, maxAsDate)}
            {renderPart(p.max, true, minAsDate, undefined)}
          </div>
        )}
      </FormGroup>
    );
  }

  return (
    <>
      {renderPart(p.min, false, undefined, maxAsDate)}
      {renderPart(p.max, false, minAsDate, undefined)}
    </>
  );
}

export default DateTimeRange;
