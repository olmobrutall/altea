import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import {
    ValidationMessage, numberBetweenValidator, NumberBetweenValidator, numberPowerOfTwoValidator,
} from "@altea/altea/data/validators";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";

// Signum's [NumberBetweenValidator(min, max)] and [NumberPowerOfTwoValidator]. Both bound a number's
// VALUE, both report only, and neither touches the column — SchemaSettings derives a size from
// StringLengthValidator and a scale from DecimalsValidator, and reads no other validator.

@entity("Main", "Master")
class BoundsSample extends Entity {
    @numberBetweenValidator(0, 11)
    startColumn: number | null = null;

    @numberBetweenValidator(-1.5, 1.5)
    ratio: number | null = null;

    @numberPowerOfTwoValidator()
    blockSize: number | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};

describe("NumberBetweenValidator", () => {

    // "Not using C intervals to please user!", as Signum's source puts it.
    test("both bounds are INCLUSIVE", () => {
        const e = new BoundsSample();
        for (const v of [0, 1, 11]) {
            e.startColumn = v;
            assert.equal(errorsOf(e)["startColumn"], undefined, `expected ${v} to pass`);
        }
        for (const v of [-1, 12, 11.5]) {
            e.startColumn = v;
            assert.notEqual(errorsOf(e)["startColumn"], undefined, `expected ${v} to fail`);
        }
    });

    test("a fractional range works the same way", () => {
        const e = new BoundsSample();
        e.ratio = -1.5;
        assert.equal(errorsOf(e)["ratio"], undefined);
        e.ratio = -1.6;
        assert.notEqual(errorsOf(e)["ratio"], undefined);
    });

    // A bound is about the value that IS there. Requiring one is the NotNull validator's job, which a
    // non-nullable declaration already adds.
    test("null passes", () => {
        const e = new BoundsSample();
        e.startColumn = null;
        assert.equal(errorsOf(e)["startColumn"], undefined);
    });

    // Signum returns a message and nothing else. Clamping to the range would silently store a number
    // nobody entered and would make the entity dirty behind the user's back.
    test("it REPORTS, it does not clamp", () => {
        const e = new BoundsSample();
        e.startColumn = 42;
        errorsOf(e);
        assert.equal(e.startColumn, 42);
    });

    test("the error names the property and both bounds; the help message is the range alone", () => {
        const fi = getTypeInfo(BoundsSample)!.fields["startColumn"]!;
        const e = new BoundsSample();
        e.startColumn = 42;

        assert.equal(errorsOf(e)["startColumn"],
            ValidationMessage._0HasToBeBetween1And2.niceToString(fi.niceToString(), 0, 11));

        const validator = fi.validators.find(v => v instanceof NumberBetweenValidator) as NumberBetweenValidator;
        assert.equal(validator.min, 0);
        assert.equal(validator.max, 11);
        assert.equal(validator.helpMessage, ValidationMessage.BeBetween0And1.niceToString(0, 11));
    });
});

describe("NumberPowerOfTwoValidator", () => {

    test("powers of two pass, and nothing else does", () => {
        const e = new BoundsSample();
        for (const v of [1, 2, 4, 1024, 2 ** 40]) {
            e.blockSize = v;
            assert.equal(errorsOf(e)["blockSize"], undefined, `expected ${v} to pass`);
        }
        for (const v of [0, 3, 6, 1023, -4, 2.5]) {
            e.blockSize = v;
            assert.notEqual(errorsOf(e)["blockSize"], undefined, `expected ${v} to fail`);
        }
    });

    // `n & (n - 1)` would be the usual test and would be WRONG here: a JS bitwise operator truncates its
    // operands to 32 bits, so 2^40 would be read as 0.
    test("a power of two beyond 32 bits is still one", () => {
        const e = new BoundsSample();
        e.blockSize = 2 ** 40;
        assert.equal(errorsOf(e)["blockSize"], undefined);
        e.blockSize = 2 ** 40 + 1;
        assert.notEqual(errorsOf(e)["blockSize"], undefined);
    });

    test("null passes, and the messages read as sentences", () => {
        const fi = getTypeInfo(BoundsSample)!.fields["blockSize"]!;
        const e = new BoundsSample();
        e.blockSize = null;
        assert.equal(errorsOf(e)["blockSize"], undefined);

        e.blockSize = 3;
        assert.equal(errorsOf(e)["blockSize"],
            ValidationMessage._0HasToBe12.niceToString(fi.niceToString(), ValidationMessage.PowerOf.niceToString(), 2));
        assert.equal(fi.validators.find(v => v.helpMessage.includes("2"))!.helpMessage,
            ValidationMessage.BeA01.niceToString(ValidationMessage.PowerOf.niceToString(), 2));
    });
});
