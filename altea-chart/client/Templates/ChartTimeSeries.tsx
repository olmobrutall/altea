import * as React from 'react'
import { FormCheck } from 'react-bootstrap'
import { Temporal } from '@altea/altea/data/basics'
import { toInt } from '@altea/altea/data/basics'
import type { int } from '@altea/altea/data/basics'
import { NumberBox, isNumberKey } from '@altea/altea/client/Lines/NumberLine'
import { toNumberFormat } from '@altea/altea/client/numberFormat'
import { classes } from '@altea/altea/data/globals/index'
import '@altea/altea/data/globals/arrayExtensions'
import '@altea/altea/data/globals/stringExtensions'
import { Enum } from '@altea/altea/data/enum'
import { TimeSeriesUnitEnum, QueryTokenDateMessage } from '@altea/altea/data/dynamicQueries'
import type { TimeSeriesUnit } from '@altea/altea/data/dynamicQueries'
import { AggregateToken } from '@altea/altea/data/dynamicQuery/tokens/aggregateToken'
import { ChartClient } from '../ChartClient'
import { ChartTimeSeriesEmbedded } from '../../data/ChartRequest'
import type { IChartBase } from '../../data/ChartRequest'

// Copy-and-fix of Signum.Chart/Templates/ChartTimeSeries.tsx. altea divergences:
//  - luxon → Temporal (see the parse/steps helpers below).
//  - Signum splits the date editor into a react-widgets DateTimePicker (ChartRequestModel) and a plain
//    <input type="text"> (UserChart, whose dates are unresolved expressions). altea drops the picker and
//    the UserAssetClient.API.parseDate branch entirely: in this editor the dates are always plain ISO
//    strings, edited as raw text and written back verbatim. `type="text"` (not datetime-local) keeps it
//    robust across date-only (Year/Month/Day) and date-time (Hour/Minute/…) granularities.
//  - `.formatHtml` string extension does not exist in altea; the placeholder templates are split and the
//    React nodes interleaved manually (see formatParts).
//  - AggregateFunction.niceToString("Min"/"Max") → literal "Min"/"Max" labels (matches ChartBuilder.Scala).
//  - Signum's `QueryTokenString.timeSeries.token` / `queryTokenType == "Aggregate"` isOneValue clause has
//    no altea equivalent (the TimeSeries token kind is not ported): simplified to hasAggregates + every
//    column empty or an AggregateToken.
//  - MList `.element.token` → plain array `.token`.

// Interleave React nodes into a "…{0}…{1}…" template (altea has no String.formatHtml). Text runs and the
// {n} placeholders are emitted as keyed fragments, so it renders inline like Signum's formatHtml.
function formatParts(template: string, ...nodes: React.ReactNode[]): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const regex = /\{(\d+)\}/g;
  let lastIndex = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(template)) !== null) {
    if (m.index > lastIndex)
      result.push(<React.Fragment key={key++}>{template.slice(lastIndex, m.index)}</React.Fragment>);
    result.push(<React.Fragment key={key++}>{nodes[Number(m[1])]}</React.Fragment>);
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < template.length)
    result.push(<React.Fragment key={key++}>{template.slice(lastIndex)}</React.Fragment>);
  return result;
}

// Map a TimeSeriesUnit to the Temporal Duration unit used to count steps (+ a divisor for units Temporal
// has no direct name for, e.g. Quarter → 3 months). `.firstLower()` alone would not yield a valid unit.
type TemporalCountUnit = "years" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds" | "milliseconds";
function toTemporalUnit(unit: TimeSeriesUnit): { unit: TemporalCountUnit, divisor: number } {
  switch (unit) {
    case "Year": return { unit: "years", divisor: 1 };
    case "Quarter": return { unit: "months", divisor: 3 };
    case "Month": return { unit: "months", divisor: 1 };
    case "Week": return { unit: "weeks", divisor: 1 };
    case "Day": return { unit: "days", divisor: 1 };
    case "Hour": return { unit: "hours", divisor: 1 };
    case "Minute": return { unit: "minutes", divisor: 1 };
    case "Second": return { unit: "seconds", divisor: 1 };
    case "Millisecond": return { unit: "milliseconds", divisor: 1 };
  }
}

// Parse an ISO string as a PlainDateTime (date-only strings default to midnight). Invalid/empty → null.
function parsePlainDateTime(iso: string | null | undefined): Temporal.PlainDateTime | null {
  if (!iso)
    return null;
  try {
    return Temporal.PlainDateTime.from(iso);
  } catch {
    return null;
  }
}

export default function ChartTimeSeries(p: { chartTimeSeries: ChartTimeSeriesEmbedded, chartBase: IChartBase, onChange: () => void }): React.JSX.Element {

  var ts = p.chartTimeSeries;

  function renderTimeSeriesUnit() {

    function handleTimeSeriesUnit(e: React.ChangeEvent<HTMLSelectElement>) {
      ts.timeSeriesUnit = e.currentTarget.value as TimeSeriesUnit;
      ts.timeSeriesStep = toInt(1);
      p.onChange();
    }

    return (
      <select value={ts.timeSeriesUnit!} className="form-select form-select-xs ms-1" style={{ width: "auto" }} onChange={handleTimeSeriesUnit}>
        {Enum.values(TimeSeriesUnitEnum).map((stm, i) => <option key={i} value={stm}>{Enum.niceName(TimeSeriesUnitEnum, stm)}</option>)}
      </select>
    );
  }

  function renderTimeSerieStep() {

    function handleTimeSerieStep(e: number | null) {
      ts.timeSeriesStep = e == null ? toInt(1) : toInt(Number(e));
      p.onChange();
    }

    var numberFormat = toNumberFormat("0");

    return (
      <NumberBox value={ts.timeSeriesStep} validateKey={isNumberKey} format={numberFormat}
        htmlAttributes={{ className: "form-control form-control-xs ms-1", style: { width: "40px" } }}
        onChange={e => handleTimeSerieStep(e == null ? null : Number(e))} />
    );
  }

  function renderDateTime(field: "startDate" | "endDate") {

    // altea divergence: dates are plain ISO strings, edited as raw text and written back verbatim (no
    // DateTimePicker / UserAssetClient.API.parseDate branch — see the file-header note).
    return (
      <div className="d-flex ms-1">
        {field == "startDate" ? "Min" : "Max"}
        <div className="rw-widget-xs ms-1">
          <input type="text" defaultValue={ts[field] ?? ""}
            style={{ width: 170 }}
            onChange={e => {
              ts[field] = e.target.value;
              p.onChange();
            }} />
        </div>
      </div>
    );
  }

  return (
    <div className={classes("sf-system-time-editor", "alert alert-primary")}>
      <span>Time series</span>
      <span className="ms-2 d-flex">{formatParts(QueryTokenDateMessage.Every01.niceToString(), renderTimeSerieStep(), renderTimeSeriesUnit())}</span>
      {renderDateTime("startDate")}
      {renderDateTime("endDate")}
      <TotalNumStepsAndRows chartTimeSeries={ts} chartBase={p.chartBase} onChange={p.onChange} />

      <FormCheck
        className="ms-2"
        checked={ts.splitQueries}
        onChange={e => { ts.splitQueries = e.currentTarget.checked; p.onChange(); }}
        label={QueryTokenDateMessage.SplitQueries.niceToString()}
        id={`split-queries`}
      />
    </div>
  );
}

function TotalNumStepsAndRows(p: { chartTimeSeries: ChartTimeSeriesEmbedded, chartBase: IChartBase, onChange: () => void }) {

  // Signum: hasAggregates && every column is empty / the time-series column / an aggregate. altea has no
  // ported TimeSeries token, so the time-series-column clause is dropped (see the file-header note).
  const isOneValue = ChartClient.hasAggregates(p.chartBase) && p.chartBase.columns.every(a => a.token?.token == null || a.token.token instanceof AggregateToken);

  var st = p.chartTimeSeries;

  // altea divergence: dates are plain ISO strings (no async parseDate), parsed synchronously with Temporal.
  const min = parsePlainDateTime(st.startDate);
  const max = parsePlainDateTime(st.endDate);

  React.useEffect(() => {
    if (isOneValue) {
      if (st.timeSeriesMaxRowsPerStep != 1) {
        st.timeSeriesMaxRowsPerStep = toInt(1);
        p.onChange();
      }
    } else {
      if (st.timeSeriesMaxRowsPerStep == 1) {
        st.timeSeriesMaxRowsPerStep = toInt(10);
        p.onChange();
      }
    }
  }, [isOneValue])

  if (min == null || max == null || st.timeSeriesStep == null || st.timeSeriesUnit == null)
    return null;

  // luxon `Math.ceil(max.diff(min, unit).as(unit))` → Temporal until + Duration.total (relativeTo required
  // for calendar units); Quarter has no Temporal unit so it counts months / 3.
  const { unit, divisor } = toTemporalUnit(st.timeSeriesUnit);
  const total = min.until(max, { largestUnit: unit }).total({ unit, relativeTo: min.toPlainDate() });
  const steps = Math.ceil(total / divisor);

  const formatter = toNumberFormat("C0");

  return (
    <span className="ms-1">
      {formatParts(QueryTokenDateMessage._0Steps1Rows2TotalRowsAprox.niceToString(),
        <strong className={steps > 1000 ? "text-danger" : undefined}>{formatter.format(steps)}</strong>,
        <NumberBox validateKey={isNumberKey} value={st.timeSeriesMaxRowsPerStep} format={formatter} onChange={e => { st.timeSeriesMaxRowsPerStep = e == null ? toInt(10) : toInt(Number(e)); p.onChange(); }}
          htmlAttributes={{
            className: classes("form-control form-control-xs ms-1", st.timeSeriesMaxRowsPerStep == null && "sf-mandatory"),
            style: { width: "40px", display: "inline-block" }
          }}
        />,
        <strong className={st.timeSeriesMaxRowsPerStep != null && steps * st.timeSeriesMaxRowsPerStep > 1000 ? "text-danger" : undefined}>
          {st.timeSeriesMaxRowsPerStep == null ? "" : formatter.format(steps * st.timeSeriesMaxRowsPerStep)}
        </strong>
      )}
    </span>
  );
}
