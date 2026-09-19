import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { stringLengthValidator, decimalsValidator } from "@altea/altea/data/validators";
import { reflect, MAX_SIZE } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";

// Signum's `PropertyValidator.AssertCompatible`. Every validator declares `isCompatibleWith`, and until
// this landed NOTHING asked — so a validator on a field it cannot handle was accepted in silence and
// simply never fired, which is the failure mode that hides longest.
//
// The check is LAZY, as Signum's is (it asserts while BUILDING the PropertyValidator, not while applying
// the attribute). altea has a sharper reason to defer: `TypeReference.type` is a thunk, so resolving it
// during class declaration can hit a binding that is not initialised yet.
//
// The two samples are separate types on purpose: `entityIntegrityCheck` visits every field, so a single
// entity carrying the bad declaration would throw in the compatible case too.

@reflect
@entity("Main", "Master")
class CompatOk extends Entity {
    @stringLengthValidator({ max: 10 })
    name: string | null = null;
}

@reflect
@entity("Main", "Master")
class CompatBad extends Entity {
    // Wrong on purpose: DecimalsValidator answers `type === Decimal || type === Number`, never String.
    @decimalsValidator(2)
    mismatched: string | null = null;
}

describe("validator compatibility", () => {

    test("a COMPATIBLE validator runs as usual", () => {
        const e = new CompatOk();
        e.name = "12345678901"; // 11 > max 10
        assert.match(String(entityIntegrityCheck(e, "Saving")?.errors["name"]), /10/);

        e.name = "short";
        assert.equal(entityIntegrityCheck(e, "Saving"), null);
    });

    test("an INCOMPATIBLE one throws, naming the validator, the field and the type", () => {
        const e = new CompatBad();
        e.mismatched = "x";
        assert.throws(
            () => entityIntegrityCheck(e, "Saving"),
            /DecimalsValidator is not compatible with the field 'mismatched' of type String/);
    });

    test("the assert is memoised, so a second pass reports the same thing", () => {
        const e = new CompatBad();
        e.mismatched = "x";
        assert.throws(() => entityIntegrityCheck(e, "Saving"), /not compatible/);
        assert.throws(() => entityIntegrityCheck(e, "Saving"), /not compatible/);
    });
});

// `MAX_SIZE` (-1) is what an entity writes to say "this column has no size limit" — Signum's
// `StringLengthValidatorAttribute.Max = -1`. The sizing half honoured it; the VALIDATOR did not, so
// `s.length > -1` was true for every non-empty string and the field could never be saved. The message
// even read "must have at most -1 characters". Found by regenerating the database from scratch.
@reflect
@entity("Main", "Master")
class UnboundedText extends Entity {
    @stringLengthValidator({ max: MAX_SIZE })
    body: string | null = null;

    @stringLengthValidator({ min: 3, max: MAX_SIZE })
    withMin: string | null = null;
}

describe("StringLengthValidator with MAX_SIZE", () => {

    test("an unbounded max accepts any length", () => {
        const e = UnboundedText.create({});
        e.body = "x".repeat(10_000);
        assert.equal(entityIntegrityCheck(e, "Saving"), null);
    });

    test("a min is still enforced beside an unbounded max", () => {
        const e = UnboundedText.create({});
        e.withMin = "ab";
        assert.match(String(entityIntegrityCheck(e, "Saving")?.errors["withMin"]), /3/);

        e.withMin = "abcd";
        assert.equal(entityIntegrityCheck(e, "Saving"), null);
    });

    test("no message ever offers '-1' as a maximum", () => {
        const e = UnboundedText.create({});
        e.withMin = "ab";                       // violates the min, beside an unbounded max
        const errors = String(entityIntegrityCheck(e, "Saving")?.errors["withMin"]);
        assert.equal(errors.includes("-1"), false, errors);
    });
});
