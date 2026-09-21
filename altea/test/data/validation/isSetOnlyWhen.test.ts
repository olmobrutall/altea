import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { isSetOnlyWhen, ValidationMessage } from "@altea/altea/data/validators";
import { validate } from "@altea/altea/data/validators";
import { field } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";

// Signum's `(pi, value).IsSetOnlyWhen(shouldBeSet)` (ValidationAttributes.cs). It was written out by hand
// in three altea packages before it was framework vocabulary; these cases pin the two directions and
// Signum's definition of "not set" (null, the empty string, the empty collection — NOT `false`, and not 0).

@entity("Main", "Master")
class Address extends Entity {
    usesToken: boolean = false;

    @validate<Address>((a, fi) => isSetOnlyWhen(a.token, a.usesToken, fi.niceToString()))
    token: string | null = null;
}

describe("isSetOnlyWhen", () => {

    test("reports _0IsNotSet when the condition holds and the value is absent", () => {
        assert.equal(isSetOnlyWhen(null, true, "Token"), ValidationMessage._0IsNotSet.niceToString("Token"));
        assert.equal(isSetOnlyWhen("", true, "Token"), ValidationMessage._0IsNotSet.niceToString("Token"));
        assert.equal(isSetOnlyWhen([], true, "Token"), ValidationMessage._0IsNotSet.niceToString("Token"));
    });

    test("reports _0ShouldBeNull when the condition does not hold and the value is present", () => {
        assert.equal(isSetOnlyWhen("x", false, "Token"), ValidationMessage._0ShouldBeNull.niceToString("Token"));
        assert.equal(isSetOnlyWhen([1], false, "Token"), ValidationMessage._0ShouldBeNull.niceToString("Token"));
    });

    test("says nothing when the two agree", () => {
        assert.equal(isSetOnlyWhen("x", true, "Token"), null);
        assert.equal(isSetOnlyWhen(null, false, "Token"), null);
        assert.equal(isSetOnlyWhen("", false, "Token"), null);
    });

    // `false` and `0` are VALUES, not absences — Signum's check is null / empty string / empty collection.
    test("a falsy value that is not one of the three empties counts as set", () => {
        assert.equal(isSetOnlyWhen(false, true, "Token"), null);
        assert.equal(isSetOnlyWhen(0, true, "Token"), null);
        assert.equal(isSetOnlyWhen(false, false, "Token"), ValidationMessage._0ShouldBeNull.niceToString("Token"));
    });

    test("reads as a field rule, reported on the field it is about", () => {
        const a = Address.create({});
        a.usesToken = true;
        assert.match(String(entityIntegrityCheck(a, "Saving")?.errors["token"]), /Token/);

        a.token = "Customer.Email";
        assert.equal(entityIntegrityCheck(a, "Saving"), null);

        a.usesToken = false;
        assert.match(String(entityIntegrityCheck(a, "Saving")?.errors["token"]), /Token/);
    });
});
