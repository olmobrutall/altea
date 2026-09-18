import { test, describe, afterEach } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import {
    ValidationMessage, ComparisonType,
    dateInPastValidator, dateInFutureValidator, yearGreaterThanValidator, YearGreaterThanValidator,
} from "@altea/altea/data/validators";
import { reflect, getTypeInfo } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { Enum } from "@altea/altea/data/enum";

// Signum's [DateInPastValidator] / [DateInFutureValidator] / [YearGreaterThanValidator]. The first two
// are the only validators in the set whose answer depends on WHEN they run, and they read `Clock` rather
// than the wall clock — so an application's UTC/local choice applies and a test can pin the value.

@reflect
@entity("Main", "Master")
class WhenSample extends Entity {
    @dateInPastValidator()
    signedOn: Temporal.PlainDateTime | null = null;

    @dateInPastValidator()
    bornOn: Temporal.PlainDate | null = null;

    @dateInFutureValidator()
    expiresOn: Temporal.PlainDateTime | null = null;

    @yearGreaterThanValidator(1900)
    year: Temporal.PlainDate | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};
const at = (iso: string) => Temporal.PlainDateTime.from(iso);
const on = (iso: string) => Temporal.PlainDate.from(iso);

const now = at("2026-05-04T12:00:00");
afterEach(() => { Clock.overridenNow = undefined; });

describe("DateInPastValidator / DateInFutureValidator", () => {

    test("past and future are read off the Clock, not the wall clock", () => {
        Clock.overridenNow = now;
        const e = new WhenSample();

        e.signedOn = at("2026-05-04T11:59:59");
        assert.equal(errorsOf(e)["signedOn"], undefined);
        e.signedOn = at("2026-05-04T12:00:01");
        assert.match(String(errorsOf(e)["signedOn"]), /past/i);

        e.expiresOn = at("2026-05-04T12:00:01");
        assert.equal(errorsOf(e)["expiresOn"], undefined);
        e.expiresOn = at("2026-05-04T11:59:59");
        assert.match(String(errorsOf(e)["expiresOn"]), /future/i);
    });

    // A DATE has no time to compare, so today is neither past nor future and passes either way — which is
    // the answer Signum reaches by widening the date to midnight.
    test("a PlainDate compares against today", () => {
        Clock.overridenNow = now;
        const e = new WhenSample();

        for (const v of [on("2026-05-04"), on("2026-05-03"), on("1980-01-01")]) {
            e.bornOn = v;
            assert.equal(errorsOf(e)["bornOn"], undefined, `expected ${v} to pass`);
        }
        e.bornOn = on("2026-05-05");
        assert.notEqual(errorsOf(e)["bornOn"], undefined);
    });

    test("null passes, and the messages name the property", () => {
        Clock.overridenNow = now;
        const fi = getTypeInfo(WhenSample)!.fields["signedOn"]!;
        const e = new WhenSample();

        e.signedOn = null;
        assert.equal(errorsOf(e)["signedOn"], undefined);

        e.signedOn = at("2027-01-01T00:00:00");
        assert.equal(errorsOf(e)["signedOn"],
            ValidationMessage._0ShouldBeADateInThePast.niceToString(fi.niceToString()));
        assert.equal(fi.validators[0]!.helpMessage, ValidationMessage.BeInThePast.niceToString());

        const future = getTypeInfo(WhenSample)!.fields["expiresOn"]!;
        assert.equal(future.validators[0]!.helpMessage, ValidationMessage.BeInTheFuture.niceToString());
    });
});

describe("YearGreaterThanValidator", () => {

    test("only the YEAR is bounded — the day and month are free", () => {
        const e = new WhenSample();
        e.year = on("1900-01-01");
        assert.equal(errorsOf(e)["year"], undefined, "the floor itself passes");
        e.year = on("1899-12-31");
        assert.notEqual(errorsOf(e)["year"], undefined, "the year before does not");
        e.year = on("2026-05-04");
        assert.equal(errorsOf(e)["year"], undefined);
    });

    test("the messages spell the comparison in the reader's language", () => {
        const fi = getTypeInfo(WhenSample)!.fields["year"]!;
        const validator = fi.validators.find(v => v instanceof YearGreaterThanValidator) as YearGreaterThanValidator;
        assert.equal(validator.minYear, 1900);

        const comparison = Enum.niceName(ComparisonType, ComparisonType.GreaterThanOrEqualTo);
        const firstLower = comparison.charAt(0).toLowerCase() + comparison.slice(1);

        const e = new WhenSample();
        e.year = on("1800-01-01");
        assert.equal(errorsOf(e)["year"],
            ValidationMessage._0HasToBe12.niceToString(fi.niceToString(), firstLower, 1900));
        assert.equal(validator.helpMessage, ValidationMessage.BeA01.niceToString(firstLower, 1900));
    });
});
