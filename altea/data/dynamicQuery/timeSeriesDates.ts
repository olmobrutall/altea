import { Temporal } from "../basics";
import type { TimeSeriesUnitKeys } from "../dynamicQueries";
import type { SystemTime } from "./queryRequest";

// The dates of a TIME SERIES request: one `AsOf` instant per step from `startDate` to `endDate`.
//
// Signum computes this inside `Finder.executeQuerySplitTimeSeries` with luxon. It lives in its own DATA
// module here for the reason `client/Basics/changeLogMerge` does: Finder imports the ajax layer (which
// touches `document` at load) and now the Notify component, while this is pure arithmetic worth
// unit-testing headless — and it must agree with a SQL function, which is exactly the kind of agreement a
// test should hold down rather than a reader.
//
// The counterpart it must agree with is `server/queryTimeSeries`'s `GetDatesInRange` UDF, whose series is
// INCLUSIVE of `endDate` on both dialects (`WHILE @currentDate <= @endDate`, and `generate_series`) and is
// pinned by `test/server/schema/systemTime.test.ts` — a 2-second window stepping by 1 second is 3 rows.
// **Signum's own client walk is `while (dt < endDate)`**, so it and its own SQL disagree by one point at
// the endpoint; this follows the SQL. See docs/port/OpenQuestions.md.

/**
 * One step of a series, as a Temporal duration.
 *
 * `Quarter` is 3 MONTHS: `Temporal.Duration` has no quarters (luxon does), so the unit is mapped
 * explicitly rather than lower-cased into a duration key the way Signum's `{ [unit.toLowerCase()]: step }`
 * does.
 */
export function timeSeriesDuration(unit: TimeSeriesUnitKeys | undefined, step: number): Temporal.DurationLike {
    switch (unit) {
        case "Year": return { years: step };
        case "Quarter": return { months: 3 * step };
        case "Month": return { months: step };
        case "Week": return { weeks: step };
        case "Day": return { days: step };
        case "Hour": return { hours: step };
        case "Minute": return { minutes: step };
        case "Second": return { seconds: step };
        case "Millisecond": return { milliseconds: step };
        default: throw new Error(`SystemTime.timeSeriesUnit '${String(unit)}' is not a known TimeSeriesUnit`);
    }
}

/**
 * The series as the ISO strings each `AsOf` step is asked for, inclusive of `endDate` (see the header).
 *
 * Throws rather than answering an empty or endless series: every one of these is a malformed request, and
 * the caller's next move would be N queries against it.
 */
export function timeSeriesDates(st: SystemTime): string[] {
    if (st.startDate == undefined || st.startDate === "")
        throw new Error("SystemTime.startDate is required for a TimeSeries query");
    if (st.endDate == undefined || st.endDate === "")
        throw new Error("SystemTime.endDate is required for a TimeSeries query");

    const step = st.timeSeriesStep ?? 1;
    if (!Number.isFinite(step) || step <= 0)
        throw new Error("SystemTime.timeSeriesStep must be a number greater than zero");

    const start = Temporal.PlainDateTime.from(st.startDate);
    const end = Temporal.PlainDateTime.from(st.endDate);

    if (Temporal.PlainDateTime.compare(start, end) > 0)
        throw new Error("SystemTime.startDate is after .endDate");

    // ANCHORED to the start (`start + n·step`), not accumulated (`dt = dt.add(step)`) as Signum's client
    // and the SQL Server UDF both are. For the calendar units the two differ, because a clamped date
    // carries forward: from Jan 31 by the quarter, accumulating gives Apr 30 → Jul 30 → Oct 30 — each
    // step re-anchored on the previous clamp — where anchoring gives Apr 30 → Jul 31 → Oct 31. A series
    // that drifts backwards through the month the longer it runs is not a series of evenly spaced points,
    // and the Nth point should not depend on the path taken to it.
    const dates: string[] = [];
    for (let i = 0; ; i++) {
        const dt = start.add(timeSeriesDuration(st.timeSeriesUnit, step * i));
        if (Temporal.PlainDateTime.compare(dt, end) > 0)
            return dates;
        dates.push(dt.toString());
    }
}
