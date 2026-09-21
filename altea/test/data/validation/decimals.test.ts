import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { decimalsValidator } from "@altea/altea/data/validators";
import { getTypeInfo, defaultFormat } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, format } from "@altea/altea/data/decorators";
import { Decimal } from "@altea/altea/data/basics";

// Signum's [DecimalsValidator(n)] does three things from one declaration, and this pins all three: it
// VALIDATES the value, it is where the column's SCALE comes from (that half is in the schema suite —
// server/schema/valueTypes.test.ts), and it is where the display FORMAT comes from.

@entity("Main", "Master")
class DvSample extends Entity {
    // Signum's parameterless ctor defaults to 2.
    @decimalsValidator()
    twoByDefault: Decimal | null = null;

    @decimalsValidator(4)
    price: Decimal | null = null;

    // A plain `number` is the other shape the validator accepts (Signum restricts it to `decimal`;
    // altea has one number type, so the check has to work there too).
    @decimalsValidator(2)
    plainNumber: number | null = null;

    // An explicit @format wins, as Signum's GetFormatString checks [Format] before the validators.
    @format("0.000000")
    @decimalsValidator(4)
    formatted: Decimal | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};

describe("DecimalsValidator", () => {

    test("a value within the declared places passes; one beyond it does not", () => {
        const e = new DvSample();
        e.price = new Decimal("1.2345");
        assert.equal(errorsOf(e)["price"], undefined, "exactly four decimals is fine");

        e.price = new Decimal("1.23456");
        assert.match(String(errorsOf(e)["price"]), /decimal places/, "five is not");
    });

    test("fewer decimals, a whole number and null all pass", () => {
        const e = new DvSample();
        for (const v of [new Decimal("1.5"), new Decimal("7"), null]) {
            e.price = v;
            assert.equal(errorsOf(e)["price"], undefined, `expected ${v} to pass`);
        }
    });

    test("the default is two places, as Signum's parameterless ctor is", () => {
        const e = new DvSample();
        e.twoByDefault = new Decimal("1.23");
        assert.equal(errorsOf(e)["twoByDefault"], undefined);
        e.twoByDefault = new Decimal("1.234");
        assert.match(String(errorsOf(e)["twoByDefault"]), /decimal places/);
    });

    // On a plain number, rounding cannot be compared without reintroducing the binary-float error the
    // check exists to catch (Math.round(1.145 * 100) / 100 is 1.15, and 1.145 is really
    // 1.14499999999999999...), so the decimal DIGITS are counted instead.
    test("a plain number is checked too, without float noise", () => {
        const e = new DvSample();
        e.plainNumber = 1.14;
        assert.equal(errorsOf(e)["plainNumber"], undefined, "1.14 has two decimals");
        e.plainNumber = 1.145;
        assert.match(String(errorsOf(e)["plainNumber"]), /decimal places/, "1.145 has three");
        e.plainNumber = 1e-7;
        assert.match(String(errorsOf(e)["plainNumber"]), /decimal places/, "exponent form counts too");
    });

    test("the declared places become the display format", () => {
        const fields = getTypeInfo(DvSample)!.fields;
        assert.equal(fields["price"]!.decimalPlaces, 4);
        assert.equal(fields["price"]!.format ?? defaultFormat(fields["price"]), "N4");
        assert.equal(fields["twoByDefault"]!.format ?? defaultFormat(fields["twoByDefault"]), "N2");
    });

    test("an explicit @format wins over the validator's", () => {
        const fi = getTypeInfo(DvSample)!.fields["formatted"]!;
        assert.equal(fi.decimalPlaces, 4, "the validator still fixes the column scale");
        assert.equal(fi.format ?? defaultFormat(fi), "0.000000", "but not the display");
    });
});
