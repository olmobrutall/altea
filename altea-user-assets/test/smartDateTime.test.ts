import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import {
    SmartDateTimeSpan, isSmartDateTimeExpression, smartDateTimeExpression,
} from "@altea/altea-user-assets/data/FilterValueConverters/SmartDateTimeFilterValueConverter";
import { FilterValueConverter } from "@altea/altea-user-assets/data/FilterValueConverter";
import { parseFilterValue, stringifyFilterValue } from "@altea/altea-user-assets/data/FilterValueString";

// The SMART DATE grammar a user asset may store instead of an absolute date ("orders since the start of
// this month" stays that next month). Everything here runs against a FIXED clock, because the whole point
// of the feature is that the same string answers differently as the clock moves — a suite reading the real
// one would pass in September and fail in October.
//
// 2026-09-19 is a SATURDAY, and September has 30 days: the weekday and `max` cases depend on both.
const now = Temporal.PlainDateTime.from("2026-09-19T14:35:45");

beforeEach(() => { Clock.overridenNow = now; });
afterEach(() => { Clock.overridenNow = undefined; });

function resolve(expression: string): string {
    const res = SmartDateTimeSpan.tryParse(expression);
    assert.ok(res != null, `'${expression}' was not recognised as a smart date`);
    assert.ok(res.ok, `'${expression}' did not parse: ${res.ok ? "" : res.error}`);
    return res.value.toPlainDateTime(now).toString();
}

describe("resolving a smart date against a fixed clock", () => {

    const cases: [string, string, string][] = [
        ["every part is the pattern", "yyyy/mm/dd hh:mm:ss", "2026-09-19T14:35:45"],
        ["today at midnight", "yyyy/mm/dd 00:00:00", "2026-09-19T00:00:00"],
        // The two spellings Southwind's UserAssets.xml actually stores.
        ["the start of this month", "yyyy/mm/01 00:00:00", "2026-09-01T00:00:00"],
        ["a year ago", "-1/mm/dd 00:00:00", "2025-09-19T00:00:00"],
        ["a literal date", "2020/01/31 09:30:00", "2020-01-31T09:30:00"],
        ["a month back", "yyyy/-1/dd 00:00:00", "2026-08-19T00:00:00"],
        // month 13 carries into the next year, which is why the parts are mixed then normalised rather
        // than added as a Temporal duration.
        ["four months on, across the year end", "yyyy/+4/dd 00:00:00", "2027-01-19T00:00:00"],
        ["days forward, across the month end", "yyyy/mm/+15 00:00:00", "2026-10-04T00:00:00"],
        ["days back, across the month start", "yyyy/mm/-25 00:00:00", "2026-08-25T00:00:00"],
        ["the last day of this month", "yyyy/mm/max 23:59:59", "2026-09-30T23:59:59"],
        ["the last day of last month", "yyyy/-1/max 00:00:00", "2026-08-31T00:00:00"],
        // A negative second borrows a minute; `-45` seconds is 60 - 45 past the previous minute.
        ["seconds back borrow a minute", "yyyy/mm/dd hh:mm:-90", "2026-09-19T14:34:15"],
        ["hours back borrow a day", "yyyy/mm/dd -15:00:00", "2026-09-18T23:00:00"],
    ];

    for (const [name, expression, expected] of cases)
        test(name, () => assert.equal(resolve(expression), expected));
});

describe("the weekday day-part", () => {

    // altea's `weekStart` is MONDAY-based (data/globals/dateTimeExtensions), where Signum asks the current
    // culture — so the week holding Saturday 2026-09-19 runs Mon 14th … Sun 20th, and `sun` is its END.
    // Under en-US Signum would answer the 13th. Same divergence the WeekStart query token already carries.
    const cases: [string, string][] = [
        ["yyyy/mm/mon 00:00:00", "2026-09-14T00:00:00"],
        ["yyyy/mm/wed 00:00:00", "2026-09-16T00:00:00"],
        ["yyyy/mm/sat 00:00:00", "2026-09-19T00:00:00"],
        ["yyyy/mm/sun 00:00:00", "2026-09-20T00:00:00"],
        ["yyyy/mm/fri+1 00:00:00", "2026-09-19T00:00:00"],
        ["yyyy/mm/mon-3 00:00:00", "2026-09-11T00:00:00"],
    ];

    for (const [expression, expected] of cases)
        test(expression, () => assert.equal(resolve(expression), expected));

    test("the weekday is case-insensitive", () => assert.equal(resolve("yyyy/mm/MON 00:00:00"), "2026-09-14T00:00:00"));

    // The month is resolved BEFORE the week is walked, so "monday of the week holding this day of last
    // month" is a different week, not this one shifted.
    test("a weekday inside a shifted month", () => assert.equal(resolve("yyyy/-1/mon 00:00:00"), "2026-08-17T00:00:00"));
});

describe("round trip: parse → resolve → write back", () => {

    // `subtract` is the inverse: a part equal to now's becomes its pattern, a part one off becomes +1/-1,
    // the last day of a month becomes `max`. Anything it can express must come back unchanged.
    const roundTrips = [
        "yyyy/mm/dd hh:mm:ss",
        "yyyy/mm/dd 00:00:00",
        "yyyy/mm/01 00:00:00",
        "-1/mm/dd 00:00:00",
        "yyyy/mm/max 23:59:59",
        "2020/01/15 09:30:00",
        "yyyy/-1/dd 00:00:00",
        "yyyy/mm/-1 00:00:00",
    ];

    for (const expression of roundTrips)
        test(expression, () => {
            const resolved = SmartDateTimeSpan.tryParse(expression);
            assert.ok(resolved?.ok);
            const date = resolved.value.toPlainDateTime(now);
            assert.equal(SmartDateTimeSpan.subtract(date, now).toString(), expression);
        });

    // A WEEKDAY has no inverse — `subtract` never writes one — so it comes back as the literal day it
    // resolved to. Pinned so the asymmetry is a decision rather than a surprise.
    test("a weekday comes back as a literal day", () => {
        const date = Temporal.PlainDateTime.from(resolve("yyyy/mm/mon 00:00:00"));
        assert.equal(SmartDateTimeSpan.subtract(date, now).toString(), "yyyy/mm/14 00:00:00");
    });

    test("simple() writes every part out", () => {
        assert.equal(SmartDateTimeSpan.simple(now).toString(), "2026/09/19 14:35:45");
    });

    test("smartDateTimeExpression reads the clock and takes an ISO string", () => {
        assert.equal(smartDateTimeExpression("2026-09-19T14:35:45"), "yyyy/mm/dd hh:mm:ss");
        assert.equal(smartDateTimeExpression("2026-09-01"), "yyyy/mm/01 00:00:00");
        assert.equal(smartDateTimeExpression(Temporal.PlainDate.from("2025-09-19")), "-1/mm/dd 00:00:00");
    });
});

describe("what is and is not a smart date", () => {

    test("a string without the shape is nobody's", () => {
        for (const s of ["2026-09-19", "2026-09-19T00:00:00", "yyyy/mm/dd 00:00", "", "Ordered", "Order;42"])
            assert.equal(SmartDateTimeSpan.tryParse(s), null, s);
    });

    test("isSmartDateTimeExpression is shape only", () => {
        assert.equal(isSmartDateTimeExpression("yyyy/mm/01 00:00:00"), true);
        assert.equal(isSmartDateTimeExpression("yyyy/99/01 00:00:00"), true); // shaped, but invalid
        assert.equal(isSmartDateTimeExpression("2026-09-19"), false);
        assert.equal(isSmartDateTimeExpression(null), false);
    });

    test("an out-of-range literal names the part", () => {
        const res = SmartDateTimeSpan.tryParse("yyyy/13/dd 00:00:00");
        assert.ok(res != null && !res.ok);
        assert.match(res.error, /Month must be between 1 and 12/);
    });

    test("nonsense in the day part lists what the day accepts", () => {
        const res = SmartDateTimeSpan.tryParse("yyyy/mm/xyz 00:00:00");
        assert.ok(res != null && !res.ok);
        assert.match(res.error, /is not a valid Day/);
        assert.match(res.error, /max\|sun\|mon\|tue\|wed\|thu\|fri\|sat/);
    });

    test("a weekday is only allowed in the day part", () => {
        const res = SmartDateTimeSpan.tryParse("yyyy/mon/dd 00:00:00");
        assert.ok(res != null && !res.ok);
        assert.match(res.error, /is not a valid Month/);
    });
});

describe("through the filter-value façade", () => {

    test("a PlainDateTime token keeps the time", () => {
        assert.equal(parseFilterValue("yyyy/mm/01 00:00:00", "DateTime", "PlainDateTime"), "2026-09-01T00:00:00");
    });

    test("a PlainDate token gets the date half", () => {
        assert.equal(parseFilterValue("yyyy/mm/01 00:00:00", "DateTime", "PlainDate"), "2026-09-01");
    });

    test("a stored ISO date still passes through untouched", () => {
        assert.equal(parseFilterValue("2020-01-31", "DateTime", "PlainDate"), "2020-01-31");
        assert.equal(parseFilterValue("2020-01-31T09:30:00", "DateTime", "PlainDateTime"), "2020-01-31T09:30:00");
    });

    test("only a DATE token is claimed", () => {
        assert.equal(parseFilterValue("yyyy/mm/01 00:00:00", "String"), "yyyy/mm/01 00:00:00");
        assert.equal(parseFilterValue("yyyy/mm/01 00:00:00", undefined), "yyyy/mm/01 00:00:00");
    });

    test("a malformed smart date is an error, not a silently different filter", () => {
        assert.throws(() => parseFilterValue("yyyy/13/dd 00:00:00", "DateTime", "PlainDateTime"), /Month must be between/);
    });

    test("saving keeps the value absolute — the relative form is the user's own choice", () => {
        assert.equal(stringifyFilterValue("2026-09-01T00:00:00", "DateTime", "PlainDateTime"), "2026-09-01T00:00:00");
    });

    test("validationError answers for the editor", () => {
        const target = { filterType: "DateTime", typeName: "PlainDateTime" } as const;
        assert.equal(FilterValueConverter.validationError("yyyy/mm/01 00:00:00", target), null);
        assert.equal(FilterValueConverter.validationError("2020-01-31T00:00:00", target), null);
        assert.match(FilterValueConverter.validationError("yyyy/mm/xyz 00:00:00", target)!, /is not a valid Day/);
    });

    test("the lite converter still owns entity references", () => {
        assert.equal(stringifyFilterValue("plain text", "Lite"), "plain text");
        assert.equal(parseFilterValue("not a key", "Lite"), "not a key");
    });
});
