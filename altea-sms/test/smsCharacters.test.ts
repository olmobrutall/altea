import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    SMSCharacters, SMS_MAX_TEXT_LENGTH, SMS_UCS2_MAX_TEXT_LENGTH,
} from "../data/SMSCharacters";

// The GSM 03.38 length rules are the one piece of this port that is pure arithmetic over a character table,
// and the one place a wrong answer silently TRUNCATES a message (a template with
// `messageLengthExceeded: TextPruning` cuts to whatever this returns). Needs no database.

describe("SMSCharacters — the basic alphabet", () => {

    test("an all-basic message spends one septet per character", () => {
        assert.equal(SMSCharacters.remainingLength(""), SMS_MAX_TEXT_LENGTH);
        assert.equal(SMSCharacters.remainingLength("hello"), SMS_MAX_TEXT_LENGTH - 5);
        assert.equal(SMSCharacters.remainingLength("A".repeat(SMS_MAX_TEXT_LENGTH)), 0);
    });

    test("over the limit reports a NEGATIVE remainder — that is what pruning subtracts", () => {
        assert.equal(SMSCharacters.remainingLength("A".repeat(SMS_MAX_TEXT_LENGTH + 7)), -7);
    });

    test("the alphabet's odd members are basic: space, newline, ñ, ç, ß, £, ¿", () => {
        for (const c of [" ", "\n", "\r", "_", "ñ", "Ç", "ß", "£", "¿", "Ä", "Ö", "Ü", "é", "à", "ù", "ò", "ì"])
            assert.ok(SMSCharacters.isNormal(c), `${c} should be a basic GSM character`);
    });

    test("a character NOT in the alphabet is neither basic nor escaped", () => {
        for (const c of ["ĉ", "ł", "я", "字", "😀"])
            assert.ok(!SMSCharacters.isNormal(c) && !SMSCharacters.isDouble(c), `${c} should be off-alphabet`);
    });
});

describe("SMSCharacters — the extension table costs two septets", () => {

    test("the seven escaped characters", () => {
        for (const c of ["[", "\\", "]", "^", "{", "|", "}", "~", "€"])
            assert.ok(SMSCharacters.isDouble(c), `${c} should be an escaped GSM character`);
    });

    test("each escaped character spends TWO of the 160", () => {
        assert.equal(SMSCharacters.remainingLength("€"), SMS_MAX_TEXT_LENGTH - 2);
        assert.equal(SMSCharacters.remainingLength("{}"), SMS_MAX_TEXT_LENGTH - 4);
        // 80 escaped characters exactly fill one SMS.
        assert.equal(SMSCharacters.remainingLength("€".repeat(80)), 0);
    });
});

describe("SMSCharacters — one off-alphabet character re-prices the WHOLE message", () => {

    test("a single non-GSM character drops the budget to the UCS-2 payload", () => {
        // 10 basic characters would leave 150 in GSM-7; with one Cyrillic letter the message is UCS-2, so
        // the budget is 70 and the count is the plain character count (no double-charging).
        assert.equal(SMSCharacters.remainingLength("hello wor" + "я"), SMS_UCS2_MAX_TEXT_LENGTH - 10);
    });

    test("an escaped character is NOT double-charged once the message is UCS-2", () => {
        // "€я" — in GSM-7 the € would cost 2, but the я already forced UCS-2, where both cost one unit.
        assert.equal(SMSCharacters.remainingLength("€я"), SMS_UCS2_MAX_TEXT_LENGTH - 2);
    });

    test("an emoji counts ONCE, not as its two UTF-16 code units", () => {
        // The naive `text.length` would say 2. Iterating by code point is what makes this 1.
        assert.equal(SMSCharacters.remainingLength("😀"), SMS_UCS2_MAX_TEXT_LENGTH - 1);
    });
});

describe("SMSCharacters — removeNoSMSCharacters", () => {

    test("de-accents what NFD can decompose", () => {
        // ż → z, ó → o, ć → c: each is base + a combining mark, so stripping the mark rescues it.
        // ł is NOT — U+0142 is a single letter with a stroke, with no canonical decomposition — so it is
        // dropped rather than turned into "l". .NET's `RemoveDiacritics` (which strips NonSpacingMark) does
        // exactly the same, so Signum's output is identical.
        assert.equal(SMSCharacters.removeNoSMSCharacters("Zażółć"), "Zazoc");
        // é IS in the alphabet, but NFD + strip normalises it anyway — Signum's same behaviour.
        assert.equal(SMSCharacters.removeNoSMSCharacters("café"), "cafe");
    });

    test("drops what de-accenting cannot rescue", () => {
        assert.equal(SMSCharacters.removeNoSMSCharacters("hi 字 there"), "hi  there");
        assert.equal(SMSCharacters.removeNoSMSCharacters("ok 😀"), "ok ");
    });

    test("keeps the escaped characters (they are sendable, just costly)", () => {
        assert.equal(SMSCharacters.removeNoSMSCharacters("a{b}c€"), "a{b}c€");
    });

    test("the result always fits the GSM alphabet", () => {
        const cleaned = SMSCharacters.removeNoSMSCharacters("Zażółć gęślą jaźń — 字 😀 €");
        for (const c of cleaned)
            assert.ok(SMSCharacters.isNormal(c) || SMSCharacters.isDouble(c), `${c} survived but is off-alphabet`);
    });
});
