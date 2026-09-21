import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import {
    ValidationMessage, RegexValidator,
    urlValidator, UrlValidator, telephoneValidator, TelephoneValidator, multipleTelephoneValidator,
    emailValidator, alphanumericOnlyValidator, numericTextValidator, ipValidator,
    fileNameValidator, removeInvalidFileNameChars, identifierValidator, IdentifierType, IdentifierValidator,
} from "@altea/altea/data/validators";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";

// Signum's abstract [RegexValidatorAttribute] and the eight validators that derive from it. What the base
// buys is that a concrete one is a REGEX and a FORMAT NAME: both messages — the error "{0} does not have
// a valid {1} format" and the help "have a valid {1} format" — are written once, here.

@entity("Main", "Master")
class RegexSample extends Entity {
    @urlValidator()
    url: string | null = null;

    @telephoneValidator()
    phone: string | null = null;

    @multipleTelephoneValidator()
    phones: string | null = null;

    @emailValidator()
    email: string | null = null;

    @alphanumericOnlyValidator()
    code: string | null = null;

    @numericTextValidator()
    postCode: string | null = null;

    @ipValidator()
    ip: string | null = null;

    @fileNameValidator()
    fileName: string | null = null;

    @identifierValidator(IdentifierType.PascalAscii)
    typeName: string | null = null;

    @identifierValidator(IdentifierType.Ascii)
    fieldName: string | null = null;

    @identifierValidator(IdentifierType.International)
    label: string | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};

/** Checks one field against the values that must pass and the values that must not. */
function accepts(field: keyof RegexSample & string, good: string[], bad: string[]): void {
    const e = new RegexSample();
    for (const v of good) {
        (e as any)[field] = v;
        assert.equal(errorsOf(e)[field], undefined, `expected ${field} to accept ${JSON.stringify(v)}`);
    }
    for (const v of bad) {
        (e as any)[field] = v;
        assert.notEqual(errorsOf(e)[field], undefined, `expected ${field} to reject ${JSON.stringify(v)}`);
    }
    (e as any)[field] = null;
}

describe("RegexValidator", () => {

    test("null and the empty string always pass — a regex says what a value LOOKS like, not that there is one", () => {
        const e = new RegexSample();
        for (const field of ["url", "phone", "email", "ip", "fileName", "typeName"] as const) {
            for (const v of [null, ""]) {
                (e as any)[field] = v;
                assert.equal(errorsOf(e)[field], undefined, `expected ${field} to pass ${JSON.stringify(v)}`);
            }
        }
    });

    test("the error names the property and the format, and the help message is the same format localized", () => {
        const fi = getTypeInfo(RegexSample)!.fields["url"]!;
        const e = new RegexSample();
        e.url = "not a url";

        assert.equal(errorsOf(e)["url"],
            ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), "URL"));

        const validator = fi.validators.find(v => v instanceof RegexValidator) as UrlValidator;
        assert.equal(validator.formatName, "URL");
        assert.equal(validator.helpMessage, ValidationMessage.HaveValid0Format.niceToString("URL"));
    });

    // Three of the eight name a CONCEPT rather than a spelling, and those read from ValidationMessage;
    // "URL", "IP", "e-Mail" and the IdentifierType member name are literals, as they are in Signum.
    test("the format name is translated only where it is a word", () => {
        const fields = getTypeInfo(RegexSample)!.fields;
        const formatNameOf = (f: string) => (fields[f]!.validators.find(v => v instanceof RegexValidator) as RegexValidator).formatName;

        assert.equal(formatNameOf("phone"), ValidationMessage.Telephone.niceToString());
        assert.equal(formatNameOf("phones"), ValidationMessage.Telephone.niceToString());
        assert.equal(formatNameOf("postCode"), ValidationMessage.Numeric.niceToString());
        assert.equal(formatNameOf("fileName"), ValidationMessage.FileName.niceToString());

        assert.equal(formatNameOf("url"), "URL");
        assert.equal(formatNameOf("ip"), "IP");
        assert.equal(formatNameOf("email"), "e-Mail");
        assert.equal(formatNameOf("typeName"), "PascalAscii");
    });

    // Signum's ABSOLUTE shape, the only one ported — see the validator's header.
    test("URL", () => {
        accepts("url",
            ["https://example.com", "http://example.com/orders/42?id=7", "https://user:pass@example.com/x"],
            ["not a url", "example.com", "ftp://example.com/x", "/orders/42"]);
    });

    test("Telephone: digits and the punctuation a number is written with", () => {
        accepts("phone",
            ["+34 600 123 456", "(91) 555-12-34", "555/1234"],
            ["555 ext. 12", "call me"]);
    });

    // DIVERGES from Signum, whose regex matches a SINGLE character per number and is unanchored, so it
    // accepts any string that starts with a digit.
    test("MultipleTelephone: a comma-separated list of those", () => {
        accepts("phones",
            ["+34 600 123 456", "555-1234, 555-9876", "555-1234,555-9876"],
            ["555-1234, call me", "555-1234,,555-9876", "5 fine numbers"]);
    });

    test("e-Mail", () => {
        accepts("email",
            ["someone@example.com", "some.one+tag@mail.example.co.uk"],
            ["someone@example", "someone", "some one@example.com"]);
    });

    // DIVERGES from Signum's unanchored `[A-Za-z0-9]`, which asks for an alphanumeric somewhere and so
    // accepts every one of the "bad" values below — for a validator named AlphanumericOnly.
    test("AlphanumericOnly: letters and digits, nothing else", () => {
        accepts("code", ["ABC123", "abc", "42"], ["ABC-123", "ABC 123", "a#b", "ñ"]);
    });

    test("NumericText: digits held as text, leading zeros intact", () => {
        accepts("postCode", ["00123", "28001"], ["28001-A", "1 2", "twelve"]);
    });

    // DIVERGES from Signum's unanchored regex, which passes any string with an address somewhere inside.
    // Neither bounds an octet to 255.
    test("Ip", () => {
        accepts("ip", ["192.168.0.1", "10.0.0.255", "999.1.1.1"], ["192.168.0", "localhost", "from 192.168.0.1 today"]);
    });

    test("FileName: no separator and no character Windows reserves", () => {
        accepts("fileName",
            ["report.pdf", "Q4 report (final).xlsx", "ünïcode.txt"],
            ["folder/report.pdf", "folder\\report.pdf", "a:b.txt", 'quote".txt', "bell.txt"]);
    });

    // It REPORTS. The corrected value is available as a FUNCTION (Signum's RemoveInvalidCharts) so a
    // caller that wants to sanitise a name does so where it builds one, not behind a save.
    test("FileName reports; removing the characters is a separate, explicit step", () => {
        const e = new RegexSample();
        e.fileName = "in/valid?.txt";
        assert.notEqual(errorsOf(e)["fileName"], undefined);
        assert.equal(e.fileName, "in/valid?.txt");

        assert.equal(removeInvalidFileNameChars("in/valid?.txt"), "invalid.txt");
    });

    // DIVERGENCE: Signum's PascalAscii regex carries a stray '[' that makes it identical to its Ascii one,
    // so "orderEntity" passes there.
    test("Identifier: the three spelling rules", () => {
        accepts("typeName", ["OrderEntity", "Order_1", "O"], ["orderEntity", "_order", "1Order", "Órder", "Order-1"]);
        accepts("fieldName", ["orderNumber", "_private", "Order1"], ["1order", "order-number", "órden"]);
        accepts("label", ["órden", "Ñandú", "_x1"], ["1orden", "or den", "or-den"]);
    });

    test("IdentifierValidator keeps the type it was declared with", () => {
        const v = getTypeInfo(RegexSample)!.fields["label"]!.validators.find(v => v instanceof IdentifierValidator) as IdentifierValidator;
        assert.equal(v.type, IdentifierType.International);
    });

    // A `g` flag would make RegExp.test stateful (it advances lastIndex), so the same validator would
    // answer differently on consecutive calls.
    test("no regex carries the g flag", () => {
        const fields = getTypeInfo(RegexSample)!.fields;
        for (const fi of Object.values(fields))
            for (const v of fi.validators)
                if (v instanceof RegexValidator)
                    for (const r of v.regexList)
                        assert.equal(r.global, false, `${fi.name}: ${r} is global`);
    });

    test("the same value validates the same way twice", () => {
        const e = new RegexSample();
        e.phone = "+34 600 123 456";
        assert.equal(errorsOf(e)["phone"], undefined);
        assert.equal(errorsOf(e)["phone"], undefined);
    });

    test("TelephoneValidator accepts any Unicode decimal digit, as Signum's \\p{Nd} does", () => {
        const e = new RegexSample();
        e.phone = "٥٥٥-١٢٣٤"; // Arabic-Indic digits
        assert.equal(errorsOf(e)["phone"], undefined);
        assert.ok(getTypeInfo(RegexSample)!.fields["phone"]!.validators.some(v => v instanceof TelephoneValidator));
    });
});
