// Ported from Signum.React/Lines/DateTimeRange.tsx — copy-and-fix. Two DateTimeLines side-by-side that
// edit the min/max of a date range (the [from, to] value of a `Between` filter), with the calendar of
// each constrained by the other and the in-range days highlighted.
//
// altea fixes vs Signum:
//   - luxon → Temporal: values are Temporal.PlainDate / PlainDateTime; range membership compares the
//     calendar days (a PlainDateTime by its day in the user's frame).
//   - DateTimeLine reads its type from `ctx.memberType` (Signum passed an explicit `type=` prop), so the
//     part ctx must already carry the date TypeReference; DateRangePartProps drops `type`.
//   - day styling flows through altea's `renderDayAndTitle` (RenderDayAndTitle) hook — we wrap the base
//     renderer and keep its holiday titles.
import * as React from 'react';
import { StyleContext, TypeContext } from '../TypeContext';
import { DateTimeLine, DateTimeLineOptions, type RenderDayAndTitle } from './DateTimeLine';
import { Temporal } from '../../data/basics';
import { Clock } from '../../data/utils/clock';
import { classes } from '../../data/globals';
import type { DateValue } from '../ui/dateFormat';
import { FormGroup } from './FormGroup';
import type { ChangeEvent } from './LineBase';

export interface DateRangePartProps {
  ctx: TypeContext<DateValue | null>;
  format?: string;
  minDate?: Temporal.PlainDate;
  maxDate?: Temporal.PlainDate;
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

const cmp = Temporal.PlainDate.compare;

function earlierDate(a: Temporal.PlainDate | undefined, b: Temporal.PlainDate | undefined): Temporal.PlainDate | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return cmp(a, b) < 0 ? a : b;
}

function laterDate(a: Temporal.PlainDate | undefined, b: Temporal.PlainDate | undefined): Temporal.PlainDate | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return cmp(a, b) > 0 ? a : b;
}

function dayOf(value: DateValue | null | undefined): Temporal.PlainDate | undefined {
  return value == null ? undefined : value instanceof Temporal.PlainDate ? value : Clock.toUserInterface(value).toPlainDate();
}

// Wrap the base RenderDayAndTitle: keep its holiday title, but mark the day cell with the range classes
// (sf-range-start / -end / -between) when it falls on/inside [min, max].
function makeRangeRenderDayAndTitle(base: RenderDayAndTitle, min: Temporal.PlainDate | undefined, max: Temporal.PlainDate | undefined): RenderDayAndTitle {
  const renderDay = (date: Temporal.PlainDate) => {
    const inner = base.renderDay(date);
    const isStart = min != null && cmp(date, min) === 0;
    const isEnd = max != null && cmp(date, max) === 0;
    const isBetween = min != null && max != null && cmp(date, min) > 0 && cmp(date, max) < 0;
    if (!isStart && !isEnd && !isBetween)
      return inner;
    return { ...inner, className: classes(inner?.className, isStart && "sf-range-start", isEnd && "sf-range-end", isBetween && "sf-range-between") };
  };

  return { renderDay, getHolidayTitle: base.getHolidayTitle };
}

export function DateTimeRange(p: DateTimeRangeProps): React.ReactElement | null {

  const base = DateTimeLineOptions.Options.useRenderDay();

  const minDay = dayOf(p.min.ctx.value);
  const maxDay = dayOf(p.max.ctx.value);

  const rangeRenderDay = makeRangeRenderDayAndTitle(base, minDay, maxDay);

  function renderPart(part: DateRangePartProps, srOnly: boolean, constraintMinDate: Temporal.PlainDate | undefined, constraintMaxDate: Temporal.PlainDate | undefined): React.ReactElement {
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
          <div className="flex gap-2">
            {renderPart(p.min, true, undefined, maxDay)}
            {renderPart(p.max, true, minDay, undefined)}
          </div>
        )}
      </FormGroup>
    );
  }

  return (
    <>
      {renderPart(p.min, false, undefined, maxDay)}
      {renderPart(p.max, false, minDay, undefined)}
    </>
  );
}

export default DateTimeRange;
