import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import "@altea/altea/data/dynamicQuery/tokens/factories"; // register metadata factories → local subtoken gen
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { dateTimePrecisionValidator, DateTimePrecision } from "@altea/altea/data/validators";
import { getTypeInfo, defaultFormat } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, format } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";

// Signum's [DateTimePrecisionValidator(p)] does four things from one declaration, and this pins all
// four: it VALIDATES the value, it is where the display FORMAT comes from, it TRIMS the date sub-tokens
// a query offers, and `Days` is what makes a DateTime groupable. What it does NOT do is size the column
// — Signum's GetSqlPrecision has that lookup commented out — so there is nothing to pin in the schema
// suite, unlike DecimalsValidator's scale.

@entity("Main", "Master")
class DtpSample extends Entity {
    @dateTimePrecisionValidator(DateTimePrecision.Seconds)
    toTheSecond: Temporal.PlainDateTime | null = null;

    @dateTimePrecisionValidator(DateTimePrecision.Days)
    toTheDay: Temporal.PlainDateTime | null = null;

    @dateTimePrecisionValidator(DateTimePrecision.Milliseconds)
    toTheMillisecond: Temporal.PlainDateTime | null = null;

    // Nothing declared: the property may use the whole range.
    undeclared: Temporal.PlainDateTime | null = null;

    // An explicit @format wins, as Signum's GetFormatString checks [Format] before the validators.
    @format("yyyy-MM-dd")
    @dateTimePrecisionValidator(DateTimePrecision.Seconds)
    formatted: Temporal.PlainDateTime | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};
const at = (iso: string) => Temporal.PlainDateTime.from(iso);
const O = SubTokensOptionsAll;
const subTokenKeys = (field: string) => new RootToken(DtpSample).subToken(field, O)!.subTokens(O).map(t => t.key);

describe("DateTimePrecisionValidator", () => {

    test("a value no finer than the declared precision passes; a finer one does not", () => {
        const e = new DtpSample();
        e.toTheSecond = at("2026-05-04T10:20:30");
        assert.equal(errorsOf(e)["toTheSecond"], undefined, "whole seconds are fine");

        e.toTheSecond = at("2026-05-04T10:20:30.123");
        assert.match(String(errorsOf(e)["toTheSecond"]), /precision/, "milliseconds are not");
    });

    test("a COARSER value passes, and so does null", () => {
        const e = new DtpSample();
        for (const v of [at("2026-05-04T10:20:00"), at("2026-05-04T00:00:00"), null]) {
            e.toTheSecond = v;
            assert.equal(errorsOf(e)["toTheSecond"], undefined, `expected ${v} to pass`);
        }
    });

    test("Days means no time at all", () => {
        const e = new DtpSample();
        e.toTheDay = at("2026-05-04T00:00:00");
        assert.equal(errorsOf(e)["toTheDay"], undefined);
        e.toTheDay = at("2026-05-04T09:00:00");
        assert.match(String(errorsOf(e)["toTheDay"]), /precision/, "an hour is already too much");
    });

    // DIVERGENCE from Signum, which tests `Millisecond != 0` alone: Temporal counts to the nanosecond,
    // so a sub-millisecond remainder reports Milliseconds rather than reporting the value as a bare date.
    test("a sub-millisecond remainder is not mistaken for no time at all", () => {
        const e = new DtpSample();
        e.toTheSecond = at("2026-05-04T00:00:00.0000004");
        assert.match(String(errorsOf(e)["toTheSecond"]), /precision/);
        e.toTheMillisecond = at("2026-05-04T00:00:00.0000004");
        assert.equal(errorsOf(e)["toTheMillisecond"], undefined, "Milliseconds is the finest altea declares");
    });

    test("the declared precision becomes the display format", () => {
        const fields = getTypeInfo(DtpSample)!.fields;
        assert.equal(fields["toTheSecond"]!.dateTimePrecision, "Seconds");
        assert.equal(fields["toTheSecond"]!.format ?? defaultFormat(fields["toTheSecond"]), "G");
        assert.equal(fields["toTheDay"]!.format ?? defaultFormat(fields["toTheDay"]), "d");
        assert.equal(fields["undeclared"]!.format ?? defaultFormat(fields["undeclared"]), undefined);
    });

    test("an explicit @format wins over the validator's", () => {
        const fi = getTypeInfo(DtpSample)!.fields["formatted"]!;
        assert.equal(fi.dateTimePrecision, "Seconds", "the validator still holds");
        assert.equal(fi.format ?? defaultFormat(fi), "yyyy-MM-dd", "but not the display");
    });

    test("the date sub-tokens stop at the declared precision", () => {
        const second = subTokenKeys("toTheSecond");
        assert.ok(second.includes("Second"), "a date to the second offers Second");
        assert.ok(!second.includes("Millisecond"), "but not Millisecond");

        const day = subTokenKeys("toTheDay");
        for (const k of ["Hour", "Minute", "Second", "Millisecond", "HourStart"])
            assert.ok(!day.includes(k), `a date to the day should not offer ${k}`);
        assert.ok(day.includes("Day"), "the date parts stay");

        const undeclared = subTokenKeys("undeclared");
        for (const k of ["Hour", "Minute", "Second", "Millisecond"])
            assert.ok(undeclared.includes(k), `an undeclared date keeps ${k}`);
    });

    test("only a Days DateTime is groupable", () => {
        const groupable = (field: string) => new RootToken(DtpSample).subToken(field, O)!.isGroupable;
        assert.equal(groupable("toTheDay"), true);
        assert.equal(groupable("toTheSecond"), false);
        assert.equal(groupable("undeclared"), false);
    });
});
