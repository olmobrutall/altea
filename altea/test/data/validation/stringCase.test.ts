import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { stringCaseValidator, StringCase, StringCaseValidator } from "@altea/altea/data/validators";
import { reflect, getTypeInfo, defaultFormat } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";
import { Enum } from "@altea/altea/data/enum";
import { enumNameOf } from "@altea/altea/data/registration";

// Signum's [StringCaseValidator(StringCase.Uppercase)]. Unlike DateTimePrecisionValidator, its sibling in
// shape, it has exactly ONE job: it REPORTS a value in the wrong case and never rewrites it, it puts
// nothing on the FieldInfo and it does not touch the column. The "does not correct" case below is the one
// worth pinning — a validator that silently upper-cased the value would pass every other test here.

@reflect
@entity("Main", "Master")
class StringCaseSample extends Entity {
    @stringCaseValidator(StringCase.Uppercase)
    code: string | null = null;

    @stringCaseValidator(StringCase.Lowercase)
    slug: string | null = null;

    undeclared: string | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};

describe("StringCaseValidator", () => {

    test("Uppercase accepts an upper-cased value and rejects anything else", () => {
        const e = new StringCaseSample();
        e.code = "ABC-1";
        assert.equal(errorsOf(e)["code"], undefined);

        e.code = "Abc-1";
        assert.match(String(errorsOf(e)["code"]), /uppercase/i);

        e.code = "abc-1";
        assert.match(String(errorsOf(e)["code"]), /uppercase/i);
    });

    test("Lowercase is the mirror image", () => {
        const e = new StringCaseSample();
        e.slug = "abc-1";
        assert.equal(errorsOf(e)["slug"], undefined);

        e.slug = "Abc-1";
        assert.match(String(errorsOf(e)["slug"]), /lowercase/i);
    });

    test("null, empty and a string with no cased letters pass either way", () => {
        const e = new StringCaseSample();
        for (const v of [null, "", "123-45", "€ 9"]) {
            e.code = v;
            e.slug = v;
            assert.equal(errorsOf(e)["code"], undefined, `expected ${JSON.stringify(v)} to pass Uppercase`);
            assert.equal(errorsOf(e)["slug"], undefined, `expected ${JSON.stringify(v)} to pass Lowercase`);
        }
    });

    // Signum's OverrideError returns a message and nothing else — it never assigns the corrected string
    // back to the property, and neither does this. Rewriting what was typed would dirty the entity behind
    // the user's back and hide a paste of the wrong text instead of surfacing it.
    test("it REPORTS, it does not correct", () => {
        const e = new StringCaseSample();
        e.code = "Abc";
        e.slug = "ABC";
        errorsOf(e);
        assert.equal(e.code, "Abc");
        assert.equal(e.slug, "ABC");
    });

    test("the error names the property, and the help message names the case", () => {
        const fi = getTypeInfo(StringCaseSample)!.fields["code"]!;
        const e = new StringCaseSample();
        e.code = "Abc";
        assert.ok(String(errorsOf(e)["code"]).startsWith(fi.niceToString()), "{0} is the property nice name");

        const validator = fi.validators.find(v => v instanceof StringCaseValidator) as StringCaseValidator;
        assert.equal(validator.textCase, StringCase.Uppercase);
        assert.equal(validator.helpMessage, `be ${Enum.niceName(StringCase, StringCase.Uppercase)}`);
    });

    // The enum backs no entity FIELD, so only the hand-written registerEnum gives it a name — and without
    // a name `Enum.niceName` has no translation key and the translation sync would drop its block.
    test("StringCase is a registered enum", () => {
        assert.equal(enumNameOf(StringCase), "StringCase");
        assert.deepEqual(Enum.values(StringCase), ["Uppercase", "Lowercase"]);
    });

    // DIVERGENCE, deliberate: Signum's Reflector.GetFormatString answers "U" / "L" for such a property,
    // and nothing in Signum ever reads either specifier back, so altea derives no format at all. Nothing
    // is copied onto the FieldInfo for the same reason — there is no reader that cannot see the validator.
    test("it declares no display format and denormalises nothing", () => {
        const fi = getTypeInfo(StringCaseSample)!.fields["code"]!;
        assert.equal(fi.format ?? defaultFormat(fi), undefined);
        assert.equal(fi.format, undefined);
    });
});
