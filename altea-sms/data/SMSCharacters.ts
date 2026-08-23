import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum.SMS's SMSCharacters.cs — how many characters of an SMS are left.
//
// The rules are the GSM 03.38 alphabet's, and they are not intuitive: a message written entirely in the
// basic alphabet fits 160 characters; seven of those characters ({ } [ ] ~ ^ \ and €) are ESCAPED on the
// wire and so cost two; and a single character outside the alphabet altogether forces the whole message
// into UCS-2, where only 70 fit. Signum's table is built from four `LoadNormalRange` calls plus a handful of
// individual code points, and this is that table verbatim.
//
// altea divergences:
//  - the two dictionaries become SETS of code points. Signum maps each character to its own code point,
//    which is only ever used as a presence check.
//  - Signum's UCS-2 branch sets `maxLength = 60`; that is a Signum BUG — the UCS-2 payload of a single SMS
//    is 70 characters (140 octets / 2), and 60 is neither the single-part nor the concatenated figure. It is
//    kept as `SMS_UCS2_MAX_TEXT_LENGTH = 70` here, with Signum's value recorded in this note.
//  - `RemoveDiacritics` is `String.normalize("NFD")` + stripping the combining marks, which is what the
//    .NET helper does.

/** Signum's `SMSMaxTextLength` — the GSM-7 payload of one SMS. */
export const SMS_MAX_TEXT_LENGTH = 160;

/** Signum's `TripleSMSMaxTextLength`. */
export const TRIPLE_SMS_MAX_TEXT_LENGTH = SMS_MAX_TEXT_LENGTH * 3;

/** The UCS-2 payload of one SMS — 140 octets / 2. Signum uses 60 here; see the header. */
export const SMS_UCS2_MAX_TEXT_LENGTH = 70;

function range(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = from; i <= to; i++)
        out.push(i);
    return out;
}

/** The basic GSM alphabet — one character, one septet. Signum's `NormalCharacters`. */
const NORMAL_CHARACTERS: ReadonlySet<number> = new Set<number>([
    " ".codePointAt(0)!,
    ...range(33, 90),   // ! .. Z
    ...range(97, 122),  // a .. z
    10, 11, 12, 13, 95, // LF / VT / FF / CR / _
    161, 162, 163, 165, 167, 191, 201, 209, 214, 216, 220, 228, 230, 233, 246, 252,
    ...range(196, 199), // Ä Å Æ Ç
    223, 224,           // ß à
    235, 236,           // ë ì
    241, 242,           // ñ ò
    248, 249,           // ø ù
]);

/** The GSM extension table — one character, TWO septets. Signum's `DoubleCharacters`. */
const DOUBLE_CHARACTERS: ReadonlySet<number> = new Set<number>([
    ...range(91, 94),   // [ \ ] ^
    ...range(123, 126), // { | } ~
    "€".codePointAt(0)!,
]);

export namespace SMSCharacters {

    export function isNormal(char: string): boolean {
        return NORMAL_CHARACTERS.has(char.codePointAt(0)!);
    }

    export function isDouble(char: string): boolean {
        return DOUBLE_CHARACTERS.has(char.codePointAt(0)!);
    }

    /**
     * Signum's `RemainingLength(text, maxLength)`: how many characters may still be added. Negative when the
     * text is already too long.
     *
     * ONE character outside the GSM alphabet re-prices the WHOLE message as UCS-2 (Signum's `break` out of
     * the loop), which is why this cannot be a per-character sum.
     */
    export function remainingLength(text: string, maxLength: number = SMS_MAX_TEXT_LENGTH): number {
        if (maxLength === 0)
            maxLength = SMS_MAX_TEXT_LENGTH;

        // `[...text]` iterates by CODE POINT, so an astral character (an emoji) counts once here — and it is
        // outside the alphabet, so it forces the UCS-2 branch, which is the answer that matters.
        const chars = [...text];
        let count = chars.length;

        for (const c of chars) {
            if (isNormal(c))
                continue;
            if (isDouble(c)) {
                count += 1;
                continue;
            }
            return SMS_UCS2_MAX_TEXT_LENGTH - chars.length;
        }

        return maxLength - count;
    }

    /** Signum's `RemoveNoSMSCharacters`: de-accent, then drop whatever the alphabet still cannot carry. */
    export function removeNoSMSCharacters(text: string): string {
        const withoutDiacritics = text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
        return [...withoutDiacritics].filter(c => isNormal(c) || isDouble(c)).join("");
    }
}

export const SMSCharactersMessage = {
    Insert: msg("Insert"),
    Message: msg("Message"),
    RemainingCharacters: msg("Remaining characters"),
    RemoveNonValidCharacters: msg("Remove non valid characters"),
    StatusCanNotBeUpdatedForNonSentMessages: msg("Status can not be updated for non sent messages"),
    TheTemplateMustBeActiveToConstructSMSMessages: msg("The template must be Active to construct SMS messages"),
    TheTextForTheSMSMessageExceedsTheLengthLimit: msg("The text for the SMS message exceeds the length limit"),
    Language: msg("Language"),
    Replacements: msg("Replacements"),
};
