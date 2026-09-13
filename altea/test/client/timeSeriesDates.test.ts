import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { timeSeriesDates, timeSeriesDuration } from "@altea/altea/data/dynamicQuery/timeSeriesDates";
import type { SystemTime } from "@altea/altea/data/dynamicQuery/queryRequest";

// The series a SPLIT TimeSeries query runs one `AsOf` step against
// (`Finder.executeQuerySplitTimeSeries`).
//
// Worth its own suite for the reason altea-tree's TreeRoute is: it stands in for something a database
// does. `server/queryTimeSeries`'s `GetDatesInRange` UDF generates the same series in SQL, and the two
// must agree or toggling the "split queries" checkbox would change how many points a chart has. The
// endpoint case is where they can silently differ, so it is asserted from both directions.

const st = (o: Partial<SystemTime>): SystemTime => ({ mode: "TimeSeries", ...o });

describe("timeSeriesDates", () => {

    // THE agreement test. `test/server/schema/systemTime.test.ts` asserts the SQL side of exactly this
    // window: "0s, 1s, 2s", 3 rows. Signum's own client walk (`while (dt < endDate)`) answers 2.
    test("includes endDate — the same 3 points the GetDatesInRange SQL yields", () => {
        const dates = timeSeriesDates(st({
            startDate: "2020-01-01T00:00:00",
            endDate: "2020-01-01T00:00:02",
            timeSeriesUnit: "Second",
            timeSeriesStep: 1,
        }));

        assert.deepEqual(dates, [
            "2020-01-01T00:00:00",
            "2020-01-01T00:00:01",
            "2020-01-01T00:00:02",
        ]);
    });

    // An endDate that does NOT land on a step boundary is not reached, and the last point before it is
    // the last point — the loop tests the date, not the count.
    test("a partial final step is dropped", () => {
        const dates = timeSeriesDates(st({
            startDate: "2020-01-01T00:00:00",
            endDate: "2020-01-01T00:00:02.500",
            timeSeriesUnit: "Second",
            timeSeriesStep: 1,
        }));

        assert.equal(dates.length, 3);
        assert.equal(dates.at(-1), "2020-01-01T00:00:02");
    });

    test("startDate == endDate is one point, not zero", () => {
        const dates = timeSeriesDates(st({
            startDate: "2020-01-01T00:00:00",
            endDate: "2020-01-01T00:00:00",
            timeSeriesUnit: "Day",
            timeSeriesStep: 1,
        }));

        assert.deepEqual(dates, ["2020-01-01T00:00:00"]);
    });

    test("a step greater than one advances by that many units", () => {
        const dates = timeSeriesDates(st({
            startDate: "2020-01-01T00:00:00",
            endDate: "2020-01-11T00:00:00",
            timeSeriesUnit: "Day",
            timeSeriesStep: 5,
        }));

        assert.deepEqual(dates, [
            "2020-01-01T00:00:00",
            "2020-01-06T00:00:00",
            "2020-01-11T00:00:00",
        ]);
    });

    // Quarter has no Temporal unit, so it is the one mapped by hand — and getting it wrong is silent.
    test("Quarter steps by three months", () => {
        const dates = timeSeriesDates(st({
            startDate: "2020-01-31T00:00:00",
            endDate: "2020-12-31T00:00:00",
            timeSeriesUnit: "Quarter",
            timeSeriesStep: 1,
        }));

        assert.deepEqual(dates, [
            "2020-01-31T00:00:00",
            "2020-04-30T00:00:00", // clamped: April has 30 days
            "2020-07-31T00:00:00", // ...and the clamp does NOT carry forward — see below
            "2020-10-31T00:00:00",
        ]);
    });

    // The reason the series is ANCHORED (`start + n·step`) rather than accumulated. Accumulating
    // re-anchors each step on the previous CLAMP, so a month-end series walks backwards the longer it
    // runs — Jan 31 by the quarter would give Apr 30, Jul 30, Oct 30, and by the month over two years it
    // would slide to the 28th and stay there. Signum's client accumulates; this does not.
    test("a month-end series does not DRIFT", () => {
        const dates = timeSeriesDates(st({
            startDate: "2020-01-31T00:00:00",
            endDate: "2020-06-30T00:00:00",
            timeSeriesUnit: "Month",
            timeSeriesStep: 1,
        }));

        assert.deepEqual(dates, [
            "2020-01-31T00:00:00",
            "2020-02-29T00:00:00", // clamped
            "2020-03-31T00:00:00", // back to the 31st, because the step is measured from January
            "2020-04-30T00:00:00",
            "2020-05-31T00:00:00",
            "2020-06-30T00:00:00",
        ]);
    });

    // Calendar arithmetic, not a fixed number of days: 2020 is a leap year, so a Year step over Feb 29
    // has to be the calendar's answer.
    test("Year and Month are CALENDAR steps", () => {
        assert.deepEqual(
            timeSeriesDates(st({
                startDate: "2020-02-29T00:00:00",
                endDate: "2021-02-28T00:00:00",
                timeSeriesUnit: "Year",
                timeSeriesStep: 1,
            })),
            ["2020-02-29T00:00:00", "2021-02-28T00:00:00"]); // clamped, February 2021 having 28 days

        assert.deepEqual(
            timeSeriesDates(st({
                startDate: "2020-01-31T00:00:00",
                endDate: "2020-03-31T00:00:00",
                timeSeriesUnit: "Month",
                timeSeriesStep: 1,
            })),
            ["2020-01-31T00:00:00", "2020-02-29T00:00:00", "2020-03-31T00:00:00"]);
    });

    test("every TimeSeriesUnit member yields a duration", () => {
        const units = ["Year", "Quarter", "Month", "Week", "Day", "Hour", "Minute", "Second", "Millisecond"] as const;
        for (const u of units)
            assert.ok(Object.values(timeSeriesDuration(u, 1)).some(v => v === 1 || v === 3), u);
    });

    // A malformed request throws rather than answering an empty or endless series, because the caller's
    // next move is N queries against whatever comes back.
    test("a malformed request throws, naming the member", () => {
        const cases: [Partial<SystemTime>, RegExp][] = [
            [{ endDate: "2020-01-02T00:00:00", timeSeriesUnit: "Day", timeSeriesStep: 1 }, /startDate is required/],
            [{ startDate: "2020-01-01T00:00:00", timeSeriesUnit: "Day", timeSeriesStep: 1 }, /endDate is required/],
            [{ startDate: "2020-01-01T00:00:00", endDate: "2020-01-02T00:00:00", timeSeriesStep: 1 }, /timeSeriesUnit/],
            [{ startDate: "2020-01-01T00:00:00", endDate: "2020-01-02T00:00:00", timeSeriesUnit: "Day", timeSeriesStep: 0 }, /timeSeriesStep/],
            [{ startDate: "2020-01-01T00:00:00", endDate: "2020-01-02T00:00:00", timeSeriesUnit: "Day", timeSeriesStep: -1 }, /timeSeriesStep/],
            [{ startDate: "2020-01-02T00:00:00", endDate: "2020-01-01T00:00:00", timeSeriesUnit: "Day", timeSeriesStep: 1 }, /after/],
        ];

        for (const [partial, message] of cases)
            assert.throws(() => timeSeriesDates(st(partial)), message, JSON.stringify(partial));
    });

    // `timeSeriesStep` is optional on the wire; a missing one is 1, not zero (which would not terminate).
    test("a missing step defaults to one", () => {
        const dates = timeSeriesDates(st({
            startDate: "2020-01-01T00:00:00",
            endDate: "2020-01-03T00:00:00",
            timeSeriesUnit: "Day",
        }));

        assert.equal(dates.length, 3);
    });
});
