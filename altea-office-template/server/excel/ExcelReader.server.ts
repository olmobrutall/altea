import { Temporal, Decimal } from "@altea/altea/data/basics";
import { OxmlPackage, RelationshipTypes } from "../oxml/OxmlPackage.server";
import type { OxmlElement } from "../oxml/OxmlElement.server";
import { columnIndex, columnLetters, rowDigits } from "../spreadsheet/FormulaRewriter.server";

// The READ half of Signum.Excel's ExcelExtensions.cs (GetCellValue / GetExcelColumnIndex / FromExcel*),
// which only the importer needs: walk a worksheet's rows and read each cell as text, then convert that
// text back to a typed value.
//
// altea divergences:
//  - `SpreadsheetDocument` + the SDK's typed graph → the package's own OOXML substrate (../oxml).
//  - A shared-string cell resolves against `sharedStrings.xml` exactly as Signum does; an `inlineStr`
//    cell (what altea's own exporter writes — see PlainExcelGenerator) reads its `<is><t>` text, which
//    Signum's GetCellValue got for free from `InnerText`.
//  - Dates come back as Temporal (PlainDate / PlainDateTime / PlainTime), decimals as decimal.js.

/** One row of the sheet: its 1-based index and its cells by 0-based COLUMN index. */
export interface ExcelRow {
    readonly rowIndex: number;
    readonly cells: Map<number, string | undefined>;
}

/**
 * Open a workbook and read its FIRST worksheet as rows of text.
 *
 * Signum navigated to the sheet named "Sheet1" (`GetWorksheetPartBySheetName`); the first worksheet
 * relationship is the same part in every file the exporter produces, and does not break when the sheet has
 * been renamed by whoever edited the file.
 */
export function readSheet(bytes: Uint8Array): ExcelRow[] {
    const pkg = OxmlPackage.load(bytes);

    const worksheet = pkg.mainPart.partsOfType(RelationshipTypes.worksheet)[0]?.rootElement;
    if (worksheet == undefined)
        throw new Error("The file is not a spreadsheet (no worksheet part)");

    const sharedStrings = readSharedStrings(pkg);

    const rows: ExcelRow[] = [];
    const sheetData = worksheet.element("sheetData");
    if (sheetData == undefined)
        return rows;

    let implicitRowIndex = 0;
    for (const row of sheetData.elements("row")) {
        implicitRowIndex++;
        const rowIndex = parseInt(row.getAttribute("r") ?? String(implicitRowIndex), 10);

        const cells = new Map<number, string | undefined>();
        let implicitColumn = 0;
        for (const cell of row.elements("c")) {
            const reference = cell.getAttribute("r");
            // A cell may omit its reference; then it is simply the next column (Signum's fallback path).
            const index = reference != undefined ? columnIndex(columnLetters(reference)) - 1 : implicitColumn;
            implicitColumn = index + 1;
            cells.set(index, cellText(cell, sharedStrings));
        }

        rows.push({ rowIndex, cells });
    }

    return rows;
}

/** Signum's GetCellValue: the cell's text, resolving the shared-string pool and boolean cells. */
function cellText(cell: OxmlElement, sharedStrings: string[]): string | undefined {
    const type = cell.getAttribute("t");

    if (type === "inlineStr")
        return cell.element("is")?.innerText ?? "";

    const v = cell.element("v");
    const text = v?.innerText ?? cell.innerText;

    if (type === "s") {
        const index = parseInt(text, 10);
        return isNaN(index) || index < 0 || index >= sharedStrings.length ? text : sharedStrings[index];
    }

    if (type === "b")
        return text === "0" ? "FALSE" : "TRUE";

    return text === "" ? undefined : text;
}

function readSharedStrings(pkg: OxmlPackage): string[] {
    const part = pkg.mainPart.partsOfType(RelationshipTypes.sharedStrings)[0];
    const root = part?.rootElement;
    if (root == undefined)
        return [];
    return [...root.elements("si")].map(si => si.innerText);
}

// ---- text → value (Signum's FromExcel* half) ------------------------------------------------------------

const OA_EPOCH = Temporal.PlainDate.from("1899-12-30");

/** Signum's FromExcelNumber: the invariant decimal representation (never the UI culture's). */
export function fromExcelNumber(text: string): Decimal {
    return new Decimal(text.trim());
}

/** Signum's FromExcelDate: Excel's serial number back to a date (+ time, from the fraction). */
export function fromExcelDate(text: string, withTime: boolean): Temporal.PlainDate | Temporal.PlainDateTime {
    // A cell an author typed into may hold an ISO string rather than a serial number.
    if (isNaN(Number(text)))
        return withTime ? Temporal.PlainDateTime.from(text.replace(" ", "T")) : Temporal.PlainDate.from(text);

    const serial = Number(text);
    const days = Math.floor(serial);
    const date = OA_EPOCH.add({ days });
    if (!withTime)
        return date;

    const millis = Math.round((serial - days) * 24 * 60 * 60 * 1000);
    return date.toPlainDateTime(Temporal.PlainTime.from("00:00").add({ milliseconds: millis }));
}

/** Signum's FromExcelTime: the fraction of a day back to a time. */
export function fromExcelTime(text: string): Temporal.PlainTime {
    if (isNaN(Number(text)))
        return Temporal.PlainTime.from(text);
    const millis = Math.round(Number(text) * 24 * 60 * 60 * 1000);
    return Temporal.PlainTime.from("00:00").add({ milliseconds: millis });
}

/** Signum's `ExcelExtensions.GetExcelColumnName` — re-exported so the importer can name a cell in an error. */
export function cellReference(row: ExcelRow, colIndex: number): string {
    return columnNameOf(colIndex + 1) + row.rowIndex;
}

function columnNameOf(index: number): string {
    let n = index;
    let name = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

export { columnIndex, columnLetters, rowDigits };
