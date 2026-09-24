import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/client/context.browser";
import "@altea/altea/data/globals";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { parseDateFilterValue } from "@altea/altea/client/FindOptions";
import { dateValueToDate, dateToDateValue, trimDateToFormat } from "@altea/altea/client/Lines/ReactWidgetsLocalizer";

// A date field's value is a Temporal.PlainDate / PlainDateTime everywhere on the client — in an entity, and
// in a filter — and the one conversion left is to the JS Date the picker needs, through the viewer's zone.

describe("date filter values", () => {

  test("an ISO string becomes the token's Temporal type", () => {
    const dt = parseDateFilterValue("PlainDateTime", "2024-07-01T10:00:00");
    assert.ok(dt instanceof Temporal.PlainDateTime);
    assert.equal(String(dt), "2024-07-01T10:00:00");

    const d = parseDateFilterValue("PlainDate", "2024-07-01T10:00:00");
    assert.ok(d instanceof Temporal.PlainDate);
    assert.equal(String(d), "2024-07-01");

    assert.equal(String(parseDateFilterValue("PlainDateTime", "2024-07-01")), "2024-07-01T00:00:00");
    assert.equal(String(parseDateFilterValue("PlainDateTime", "2024-07-31T23:59:00Z")), "2024-07-31T23:59:00");
  });

  test("an expression is left for the server, and a Temporal value passes through", () => {
    assert.equal(parseDateFilterValue("PlainDateTime", "yyyy/mm/-1 00:00:00"), "yyyy/mm/-1 00:00:00");
    assert.equal(parseDateFilterValue("PlainDateTime", "[CurrentEntity]"), "[CurrentEntity]");
    assert.equal(parseDateFilterValue("PlainDateTime", ""), undefined);

    const value = Temporal.PlainDateTime.from("2024-07-01T10:00:00");
    assert.equal(parseDateFilterValue("PlainDateTime", value), value);
  });
});

describe("the picker boundary", () => {

  test("a UTC datetime is shown and typed in the viewer's zone", () => {
    Clock.withTimeZone("Europe/Berlin", () => {
      const stored = Temporal.PlainDateTime.from("2024-07-01T10:00:00");
      const shown = dateValueToDate(stored);
      assert.equal(shown.getHours(), 12); // CEST, +02:00
      assert.equal(String(dateToDateValue(shown, false)), "2024-07-01T10:00:00");
    });
  });

  test("a calendar day never shifts", () => {
    Clock.withTimeZone("Pacific/Kiritimati", () => {
      const day = Temporal.PlainDate.from("2024-07-01");
      assert.equal(String(dateToDateValue(dateValueToDate(day), true)), "2024-07-01");
    });
  });
});

describe("trimDateToFormat", () => {

  const at = Temporal.PlainDateTime.from("2024-07-17T10:30:00");

  test("a PlainDate token takes the day", () => {
    assert.equal(String(trimDateToFormat(at, "PlainDate", undefined)), "2024-07-17");
  });

  test("a datetime token keeps a datetime, and widens a day", () => {
    assert.equal(String(trimDateToFormat(at, "PlainDateTime", undefined)), "2024-07-17T10:30:00");
    assert.equal(String(trimDateToFormat(Temporal.PlainDate.from("2024-07-17"), "PlainDateTime", undefined)), "2024-07-17T00:00:00");
  });
});
