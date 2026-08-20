import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QueryRequest, Column } from "@altea/altea/server/dynamicQuery/requests";
import type { ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { CollectionToArrayToken } from "@altea/altea/data/dynamicQuery/tokens/collectionToArrayToken";
import { OxmlPackage, RelationshipTypes } from "../oxml/OxmlPackage.server";
import { OxmlElement, OxmlText } from "../oxml/OxmlElement.server";
import { columnName } from "../spreadsheet/FormulaRewriter.server";
import { ExcelMessage } from "../../data/Excel";
import { CellBuilder, DefaultStyle, enumText, getColumnWidth, getCustomFormatExpression } from "./CellBuilder.server";

// Port of Signum.Excel's PlainExcelGenerator.cs — a query's ResultTable straight to .xlsx, with no
// template authoring: the title row, the header row, one row per result row.
//
// Like Signum, the output is BUILT FROM a small .xlsx resource (`Resources/plainExcelTemplate.xlsx`, copied
// byte-for-byte from Signum.Excel) that carries the styles: its cells A1 / A2 / B3…K3 are formatted as the
// title / header / date / … styles, and their `s=` indexes ARE the DefaultStyle map. Only the worksheet's
// `<cols>` + `<sheetData>` are replaced, so the theme, fonts, number formats and column widths of Signum's
// exports are reproduced exactly.
//
// altea divergences:
//  - `SpreadsheetDocument` → the package's own OOXML substrate (../oxml), so the worksheet is rebuilt as
//    plain elements rather than through the SDK's typed graph.
//  - Signum's WRAP-TEXT handling appended a NEW cell format per multi-line cell (`ApplyWrapTextStyle`,
//    once per cell — thousands of formats for a large export). One wrap-text format is minted per FILE
//    here and shared by every such cell.
//  - Signum's `WritePlainExcel<T>(IEnumerable<T>)` overload (an arbitrary object list, columns from
//    reflection) is not ported: nothing in altea exports a plain object list, and the members/format
//    reflection it needs has no counterpart.
//  - `ReadPlainExcel` is not here either — reading is the importer's job (see ExcelImportLogic).

const SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** The .xlsx whose styles every plain export inherits (Signum's embedded `plainExcelTemplate.xlsx`). */
// (the emitted JS sits in dist/server/excel/, so three levels up is the package root — the same trick
// ChartScriptLogic.loadIcon uses for its PNGs)
function templateBytes(): Uint8Array {
    return readFileSync(fileURLToPath(new URL("../../../server/Resources/plainExcelTemplate.xlsx", import.meta.url)));
}

/**
 * Signum's static PlainExcelGenerator ctor / SetTemplate: read the style indexes off the template's own
 * cells, so re-authoring the template (adding a style, reordering formats) needs no code change.
 */
function readCellBuilder(): CellBuilder {
    const pkg = OxmlPackage.load(templateBytes());
    const sheet = worksheetRootOf(pkg);

    const cellStyle = (reference: string): number => {
        const cell = [...sheet.descendantsNamed("c")].find(c => c.getAttribute("r") === reference);
        if (cell == undefined)
            throw new Error(`plainExcelTemplate.xlsx has no cell ${reference}`);
        return parseInt(cell.getAttribute("s") ?? "0", 10);
    };

    const cb = new CellBuilder();
    cb.defaultStyles = new Map<DefaultStyle, number>([
        [DefaultStyle.Title, cellStyle("A1")],
        [DefaultStyle.Header, cellStyle("A2")],
        [DefaultStyle.Date, cellStyle("B3")],
        [DefaultStyle.DateTime, cellStyle("C3")],
        [DefaultStyle.Text, cellStyle("D3")],
        [DefaultStyle.General, cellStyle("E3")],
        [DefaultStyle.Boolean, cellStyle("J3")],
        [DefaultStyle.Enum, cellStyle("E3")],
        [DefaultStyle.Number, cellStyle("F3")],
        [DefaultStyle.Decimal, cellStyle("G3")],
        [DefaultStyle.Percentage, cellStyle("H3")],
        [DefaultStyle.Time, cellStyle("I3")],
        [DefaultStyle.Multiline, cellStyle("K3")],
    ]);
    cb.cellFormatCount = parseInt(cellFormats(pkg).getAttribute("count") ?? "0", 10);
    return cb;
}

export namespace PlainExcelGenerator {

    /**
     * Signum's WritePlainExcel(results, request, title, forImport) — the whole workbook as bytes.
     *
     * `forImport` produces a file the IMPORTER can read back: enum members and lite keys instead of their
     * localized / display text (Signum's `forImport` flag, threaded down to every cell).
     */
    export function writePlainExcel(results: ResultTable | null, request: QueryRequest, title: string, forImport = false): Uint8Array {
        if (results == null)
            throw new Error(ExcelMessage.ThereAreNoResultsToWrite.niceToString());

        // A fresh CellBuilder per file: `customDecimalStyles` mints per-column formats into THIS workbook's
        // stylesheet (Signum shared one builder and leaked those indexes between exports).
        const cellBuilder = readCellBuilder();
        const pkg = OxmlPackage.load(templateBytes());
        const worksheet = worksheetOf(pkg);

        // GOTCHA: the engine PREPENDS the row-identity column to `request.columns` while executing
        // (DynamicQueryCore.addEntityColumn), and ResultTable splits it back out as `entityColumn`. The
        // export writes the VISIBLE columns only, so it has to drop it here too — otherwise every sheet
        // starts with an unasked-for ToString column (and a re-import would see a column the query has not).
        const columns = request.columns.filter(c => !c.token.isEntity());
        const styles = columns.map(c => cellBuilder.getDefaultStyleAndIndex(c));

        // ---- the rows ------------------------------------------------------------------------------
        const rows: OxmlElement[] = [];
        rows.push(rowOf([cellBuilder.cell(title, DefaultStyle.Title, cellBuilder.styleIndex(DefaultStyle.Title), forImport)]));
        rows.push(rowOf(columns.map(c =>
            cellBuilder.cell(c.displayName ?? c.token.niceName(), DefaultStyle.Header, cellBuilder.styleIndex(DefaultStyle.Header), forImport))));

        let wrapTextStyle: number | undefined;
        for (const row of results.rows) {
            rows.push(rowOf(columns.map((c, i) => {
                const { defaultStyle, styleIndex } = styles[i];
                const raw = row.getValue(c.token);

                // A collection-to-array column holds an ARRAY: Signum joins it with the separator its
                // token asked for, and wraps the cell when that separator is a line break.
                const toArray = c.token instanceof CollectionToArrayToken ? c.token : undefined;
                const commaSeparated = toArray?.toArrayType === "SeparatedByComma"
                    || toArray?.toArrayType === "SeparatedByCommaDistinct";
                const value = toArray != undefined && Array.isArray(raw)
                    ? raw.map(v => textOf(v)).join(commaSeparated ? ", " : "\n")
                    : defaultStyle === DefaultStyle.Enum ? enumText(raw, c.token, forImport)
                        : raw;

                if (toArray != undefined && !commaSeparated) {
                    wrapTextStyle ??= cellBuilder.cellFormatCount++;
                    return cellBuilder.cell(value, DefaultStyle.Multiline, wrapTextStyle, forImport);
                }

                return cellBuilder.cell(value, defaultStyle, styleIndex, forImport);
            })));
        }

        stampReferences(rows);

        // ---- the worksheet -------------------------------------------------------------------------
        // Signum replaces the whole Worksheet (`worksheetPart.Worksheet = new Worksheet()`), which is what
        // keeps a re-export from inheriting the template's own sample cells.
        const newSheet = new OxmlElement("worksheet");
        newSheet.setAttribute("xmlns", SPREADSHEET_NS);

        const cols = newSheet.appendChild(new OxmlElement("cols"));
        columns.forEach((c, i) => {
            const col = cols.appendChild(new OxmlElement("col"));
            col.setAttribute("min", String(i + 1));
            col.setAttribute("max", String(i + 1));
            col.setAttribute("width", String(getColumnWidth(c.token)));
            col.setAttribute("bestFit", "1");
            col.setAttribute("customWidth", "1");
        });

        const sheetData = newSheet.appendChild(new OxmlElement("sheetData"));
        for (const r of rows)
            sheetData.appendChild(r);

        worksheet.document.root = newSheet;

        appendCustomFormats(pkg, cellBuilder, wrapTextStyle);

        return pkg.save();
    }
}

// ---- stylesheet -----------------------------------------------------------------------------------------

/**
 * Append the number formats minted for this file (Signum does the same before writing rows) plus the one
 * wrap-text format. Every appended `<xf>` must land at exactly the index CellBuilder handed out, so they
 * are written in index order and the count is asserted.
 */
function appendCustomFormats(pkg: OxmlPackage, cellBuilder: CellBuilder, wrapTextStyle: number | undefined): void {
    if (cellBuilder.customDecimalStyles.size === 0 && wrapTextStyle == undefined)
        return;

    const styleSheet = stylesRoot(pkg);
    const xfs = cellFormats(pkg);
    const decimalXf = xfs.childElements.filter(e => e instanceof OxmlElement)[cellBuilder.styleIndex(DefaultStyle.Decimal)] as OxmlElement;

    const numFmts = styleSheet.element("numFmts") ?? styleSheet.prependChild(new OxmlElement("numFmts"));
    let nextFormatId = Math.max(0, ...[...numFmts.elements("numFmt")]
        .map(f => parseInt(f.getAttribute("numFmtId") ?? "0", 10))) + 1;

    const byIndex = [...cellBuilder.customDecimalStyles].sort((a, b) => a[1] - b[1]);
    for (const [formatCode, expectedIndex] of byIndex) {
        const numFmt = numFmts.appendChild(new OxmlElement("numFmt"));
        numFmt.setAttribute("numFmtId", String(nextFormatId));
        numFmt.setAttribute("formatCode", formatCode);

        const xf = decimalXf.cloneNode(false) as OxmlElement;
        xf.setAttribute("numFmtId", String(nextFormatId));
        xf.setAttribute("applyNumberFormat", "1");
        xfs.appendChild(xf);
        nextFormatId++;

        assertIndex(xfs, expectedIndex);
    }

    if (wrapTextStyle != undefined) {
        const xf = (xfs.childElements.filter(e => e instanceof OxmlElement)[cellBuilder.styleIndex(DefaultStyle.Multiline)] as OxmlElement).cloneNode(false) as OxmlElement;
        xf.setAttribute("applyAlignment", "1");
        const alignment = xf.appendChild(new OxmlElement("alignment"));
        alignment.setAttribute("wrapText", "1");
        alignment.setAttribute("vertical", "top");
        xfs.appendChild(xf);
        assertIndex(xfs, wrapTextStyle);
    }

    numFmts.setAttribute("count", String([...numFmts.elements("numFmt")].length));
    xfs.setAttribute("count", String([...xfs.elements("xf")].length));
}

/** The appended format has to occupy the index CellBuilder promised, or every cell using it is mis-styled. */
function assertIndex(xfs: OxmlElement, expectedIndex: number): void {
    const count = [...xfs.elements("xf")].length;
    if (count !== expectedIndex + 1)
        throw new Error(`Unexpected cellXfs count: appended format is at ${count - 1}, expected ${expectedIndex}`);
}

// ---- rows -----------------------------------------------------------------------------------------------

function rowOf(cells: OxmlElement[]): OxmlElement {
    const row = new OxmlElement("row");
    for (const c of cells)
        row.appendChild(c);
    return row;
}

/** Signum's ToSheetDataWithIndexes: stamp `r="3"` on each row and `r="B3"` on each of its cells. */
function stampReferences(rows: OxmlElement[]): void {
    rows.forEach((row, rowIndex) => {
        const r = String(rowIndex + 1);
        row.setAttribute("r", r);
        row.childElements.filter(e => e instanceof OxmlElement).forEach((cell, colIndex) => {
            (cell as OxmlElement).setAttribute("r", columnName(colIndex + 1) + r);
        });
    });
}

// ---- package lookups ------------------------------------------------------------------------------------

function worksheetOf(pkg: OxmlPackage) {
    const part = pkg.mainPart.partsOfType(RelationshipTypes.worksheet)[0];
    if (part == undefined)
        throw new Error("plainExcelTemplate.xlsx has no worksheet part");
    return part;
}

function worksheetRootOf(pkg: OxmlPackage): OxmlElement {
    const root = worksheetOf(pkg).rootElement;
    if (root == undefined)
        throw new Error("plainExcelTemplate.xlsx worksheet is not XML");
    return root;
}

function stylesRoot(pkg: OxmlPackage): OxmlElement {
    const part = pkg.mainPart.partsOfType(RelationshipTypes.styles)[0];
    const root = part?.rootElement;
    if (root == undefined)
        throw new Error("plainExcelTemplate.xlsx has no styles part");
    return root;
}

function cellFormats(pkg: OxmlPackage): OxmlElement {
    const xfs = stylesRoot(pkg).element("cellXfs");
    if (xfs == undefined)
        throw new Error("plainExcelTemplate.xlsx has no cellXfs");
    return xfs;
}

function textOf(value: unknown): string {
    if (value == null)
        return "";
    const lite = value as { toStr?: string | null; key?: () => string };
    if (typeof lite.key === "function")
        return lite.toStr ?? lite.key();
    return String(value);
}

// `OxmlText` is used by CellBuilder; re-exported so a caller that builds extra cells needs one import.
export { OxmlText };
