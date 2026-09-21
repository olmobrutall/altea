import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import {
    ValidationMessage, timePrecisionValidator, TimePrecisionValidator, DateTimePrecision,
} from "@altea/altea/data/validators";
import { getTimePrecision } from "@altea/altea/data/globals/dateTimeExtensions";
import { getTypeInfo, defaultFormat } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";

// Signum's [TimePrecisionValidator(p)] — DateTimePrecisionValidator's sibling for a time of day. Unlike
// that one it does exactly ONE thing: it checks the value. It denormalises nothing onto the FieldInfo, it
// derives no display format (see the validator's header) and it does not size the column, which is true
// of its date sibling as well — Signum's GetSqlPrecision reads no validator at all.

@entity("Main", "Master")
class TimeSample extends Entity {
    @timePrecisionValidator(DateTimePrecision.Minutes)
    opensAt: Temporal.PlainTime | null = null;

    @timePrecisionValidator(DateTimePrecision.Seconds)
    length: Temporal.Duration | null = null;

    @timePrecisionValidator(DateTimePrecision.Milliseconds)
    exact: Temporal.PlainTime | null = null;

    undeclared: Temporal.PlainTime | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};
const time = (iso: string) => Temporal.PlainTime.from(iso);

describe("TimePrecisionValidator", () => {

    test("a value no finer than the declared precision passes; a finer one does not", () => {
        const e = new TimeSample();
        e.opensAt = time("09:30");
        assert.equal(errorsOf(e)["opensAt"], undefined, "whole minutes are fine");

        e.opensAt = time("09:30:15");
        assert.match(String(errorsOf(e)["opensAt"]), /precision/, "seconds are not");
    });

    test("a COARSER value passes, and so do null and midnight", () => {
        const e = new TimeSample();
        for (const v of [time("09:00"), time("00:00"), null]) {
            e.opensAt = v;
            assert.equal(errorsOf(e)["opensAt"], undefined, `expected ${v} to pass`);
        }
    });

    // DIVERGENCE from Signum, whose TimeOnly.GetPrecision stops at Seconds — a TimeOnly carrying
    // milliseconds reports itself as a whole minute there and passes every precision.
    test("milliseconds count, and so does a sub-millisecond remainder", () => {
        const e = new TimeSample();
        e.opensAt = time("09:30:00.500");
        assert.match(String(errorsOf(e)["opensAt"]), /precision/);

        e.exact = time("09:30:00.0000004");
        assert.equal(errorsOf(e)["exact"], undefined, "Milliseconds is the finest altea declares");
    });

    // A Duration's fields are not balanced — `PT376S` holds 376 seconds and no minutes — so it has to be
    // rounded up before its finest unit can be read.
    test("a Duration is measured after balancing", () => {
        const e = new TimeSample();
        e.length = Temporal.Duration.from({ seconds: 376 });
        assert.equal(errorsOf(e)["length"], undefined, "6m16s is whole seconds");

        e.length = Temporal.Duration.from({ milliseconds: 1500 });
        assert.match(String(errorsOf(e)["length"]), /precision/);
    });

    // Signum's `ts.Days != 0`, which it reports with a hard-coded English sentence.
    test("a Duration that runs past a day is not a time of the day", () => {
        const fi = getTypeInfo(TimeSample)!.fields["length"]!;
        const e = new TimeSample();

        e.length = Temporal.Duration.from({ hours: 23, minutes: 59 });
        assert.equal(errorsOf(e)["length"], undefined);

        e.length = Temporal.Duration.from({ hours: 25 });
        assert.equal(errorsOf(e)["length"],
            ValidationMessage._0ShouldBeATimeOfTheDay.niceToString(fi.niceToString()));
    });

    test("it REPORTS, it does not truncate", () => {
        const e = new TimeSample();
        e.opensAt = time("09:30:15");
        errorsOf(e);
        assert.equal(e.opensAt.toString(), "09:30:15");
    });

    test("both messages are localized, unlike Signum's", () => {
        const fi = getTypeInfo(TimeSample)!.fields["opensAt"]!;
        const e = new TimeSample();
        e.opensAt = time("09:30:15");

        assert.equal(errorsOf(e)["opensAt"], ValidationMessage._0HasAPrecisionOf1InsteadOf2.niceToString(
            fi.niceToString(),
            Enum.niceName(DateTimePrecision, DateTimePrecision.Seconds),
            Enum.niceName(DateTimePrecision, DateTimePrecision.Minutes)));

        const validator = fi.validators.find(v => v instanceof TimePrecisionValidator) as TimePrecisionValidator;
        assert.equal(validator.precision, DateTimePrecision.Minutes);
        assert.equal(validator.helpMessage, ValidationMessage.HaveAPrecisionOf0.niceToString(
            Enum.niceName(DateTimePrecision, DateTimePrecision.Minutes).toLowerCase()));
    });

    // The standing rule: nothing is copied onto the FieldInfo unless a reader genuinely cannot reach
    // `fi.validators`. Signum derives a display format from this validator; altea's format vocabulary has
    // no time patterns to answer with, so there is no such reader and nothing to denormalise.
    test("it declares no display format and denormalises nothing", () => {
        const fi = getTypeInfo(TimeSample)!.fields["opensAt"]!;
        assert.equal(fi.dateTimePrecision, undefined);
        assert.equal(fi.format ?? defaultFormat(fi), undefined);
    });

    test("getTimePrecision answers the finest unit a value uses, or undefined for zero", () => {
        assert.equal(getTimePrecision(time("00:00")), undefined);
        assert.equal(getTimePrecision(time("09:00")), DateTimePrecision.Hours);
        assert.equal(getTimePrecision(time("09:30")), DateTimePrecision.Minutes);
        assert.equal(getTimePrecision(time("09:30:15")), DateTimePrecision.Seconds);
        assert.equal(getTimePrecision(time("09:30:15.001")), DateTimePrecision.Milliseconds);

        assert.equal(getTimePrecision(Temporal.Duration.from({ seconds: 0 })), undefined);
        assert.equal(getTimePrecision(Temporal.Duration.from({ seconds: 376 })), DateTimePrecision.Seconds);
        // Days only when nothing finer is used — 25 hours is one day and one HOUR, which is the finest
        // unit it carries. Signum's TimeSpan.GetPrecision reads the balanced components the same way.
        assert.equal(getTimePrecision(Temporal.Duration.from({ hours: 24 })), DateTimePrecision.Days);
        assert.equal(getTimePrecision(Temporal.Duration.from({ hours: 25 })), DateTimePrecision.Hours);
    });
});
