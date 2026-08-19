// Port of Signum.Word's Spreedsheet/FormulaRewriter.cs — parsing and rewriting A1 cell references inside
// Excel formula strings.
//
// Pure and template-agnostic: it only knows how to FIND references in a formula (skipping string literals
// and function names) and how to convert between column letters and indexes. Everything about @foreach
// blocks lives in SpreadsheetBlockPlan; everything about the document lives in SpreadsheetUtils.
//
// The scanning is hand-written rather than a single regex because a formula is not a flat list of
// references: `"A1"` inside a quoted literal is text, and `LOG10(x)` starts with letters+digits that look
// exactly like a reference. Both are cases where a naive replace silently corrupts the workbook.

/** A parsed A1 reference: `$B$7` is `{ colAbs: true, col: "B", rowAbs: true, row: 7 }`. */
export interface A1Ref {
    colAbs: boolean;
    col: string;
    rowAbs: boolean;
    row: number;
}

export function refToString(r: A1Ref): string {
    return (r.colAbs ? "$" : "") + r.col + (r.rowAbs ? "$" : "") + r.row;
}

// Optional $, 1-3 column letters, optional $, row digits — anchored at the scan position (C#'s \G).
const refRegex = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)/;

/**
 * Rewrite every A1 cell reference in `formula`, applying `transform` to each.
 *
 * Skips quoted string literals (honouring `""` escapes) and identifiers such as function names, so
 * `SUM(A1:A5)` rewrites both references while `LOG10(A1)` leaves `LOG10` alone.
 */
export function rewriteRefs(formula: string, transform: (r: A1Ref) => A1Ref): string {
    const sb: string[] = [];
    let i = 0;
    let prev = "\0";

    while (i < formula.length) {
        const c = formula[i];

        if (c === "\"") { // copy a string literal verbatim, honouring "" escapes
            sb.push(c);
            i++;
            while (i < formula.length) {
                sb.push(formula[i]);
                if (formula[i] === "\"") {
                    if (i + 1 < formula.length && formula[i + 1] === "\"") { sb.push("\""); i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            prev = "\"";
            continue;
        }

        // Only start a reference at a BOUNDARY, so we never match inside a function / defined name.
        const boundary = !(isLetterOrDigit(prev) || prev === "_" || prev === ".");
        if (boundary && (isLetter(c) || c === "$")) {
            const m = refRegex.exec(formula.slice(i));
            if (m != null) {
                const after = i + m[0].length;
                const next = after < formula.length ? formula[after] : "\0";
                // `A1(` is a call and `A1B` is a longer identifier — neither is a reference.
                if (!(next === "(" || isLetter(next))) {
                    const text = refToString(transform({
                        colAbs: m[1] === "$",
                        col: m[2],
                        rowAbs: m[3] === "$",
                        row: parseInt(m[4], 10),
                    }));
                    sb.push(text);
                    i = after;
                    prev = text[text.length - 1];
                    continue;
                }
            }
        }

        sb.push(c);
        prev = c;
        i++;
    }

    return sb.join("");
}

function isLetter(c: string): boolean {
    return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
}

function isLetterOrDigit(c: string): boolean {
    return isLetter(c) || (c >= "0" && c <= "9");
}

// ---- column letters <-> index ---------------------------------------------------------------------------

/** "A" -> 1, "Z" -> 26, "AA" -> 27 (Signum's ExcelExtensions.GetExcelColumnIndex). */
export function columnIndex(col: string): number {
    let index = 0;
    for (const ch of col.toUpperCase())
        index = index * 26 + (ch.charCodeAt(0) - 64);
    return index;
}

/** 1 -> "A", 26 -> "Z", 27 -> "AA" (Signum's ExcelExtensions.GetExcelColumnName). */
export function columnName(index: number): string {
    let n = index;
    let name = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

/** The digits of an A1 string: "B7" -> 7. */
export function rowDigits(a1: string): number {
    return parseInt(a1.replace(/[^0-9]/g, ""), 10);
}

/** The letters of an A1 string: "B7" -> "B". */
export function columnLetters(a1: string): string {
    return a1.replace(/[^A-Za-z]/g, "");
}
