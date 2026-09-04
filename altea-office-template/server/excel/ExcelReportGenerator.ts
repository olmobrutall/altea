import type { QueryRequest, Column } from "@altea/altea/server/dynamicQuery/requests";
import type { ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { OxmlPackage, RelationshipTypes, type OxmlPart } from "../oxml/OxmlPackage";
import { OxmlElement } from "../oxml/OxmlElement";
import { columnLetters, columnName } from "../spreadsheet/FormulaRewriter";
import { forceFullCalcOnLoad, removeCalcChain } from "../spreadsheet/SpreadsheetUtils";
import { ExcelMessage } from "../../data/Excel";
import { DefaultStyle, enumText } from "./CellBuilder";
import { cellText, readSharedStrings } from "./ExcelReader";
import { readCellBuilder } from "./PlainExcelGenerator";

// Port of Signum.Excel's ExcelGenerator.cs — refill a stored .xlsx TEMPLATE's "Data" sheet from a query.
//
// The template is a workbook someone built in Excel: a "Data" sheet holding a header row and one sample
// data row, plus whatever else they wanted — pivot tables, charts, sheets whose formulas read the data.
// Running the report REPLACES the Data sheet's contents with the query's rows, keeping each column's
// formatting from the sample row, and repoints every pivot cache at the new range. Nothing else in the
// workbook is touched; Excel recalculates it on open.
//
// Two things make it work, and both are the template author's contract rather than anything stored:
//  - a column is matched by its **display name** — the header cell's text against the query column's
//    caption — so the template says which columns it wants and in which order;
//  - the **sample row** below the header supplies each column's style, which is how a template can format
//    a date column, colour a total and set a number format without any of that being described in code.
//
// altea divergences, documented inline:
//  - `SpreadsheetDocument` / the OpenXML SDK's typed graph → the package's own OOXML substrate (../oxml),
//    the same swap PlainExcelGenerator documents.
//  - the "Data" sheet is looked up more forgivingly (see {@link dataWorksheet}).
//  - the output column ORDER is built explicitly (template columns in template order, then any query
//    column the template does not mention). Signum gets the same order from a `HashSet<K>` it unions the
//    two key sets into — true of .NET's HashSet in practice, but not a documented guarantee, and the file's
//    column order is not something to leave to one.
//  - Signum's `GetColumnWidth` is dead code there (nothing calls it) and is not ported: an ExcelReport
//    takes its widths from the template, which is the point of having one.

export namespace ExcelReportGenerator {

    /** Signum's `WriteDataInExcelFile(results, request, template)`. */
    export function writeDataInExcelFile(
        results: ResultTable | null, request: QueryRequest, template: Uint8Array,
    ): Uint8Array {
        if (results == null)
            throw new Error(ExcelMessage.ThereAreNoResultsToWrite.niceToString());

        const pkg = OxmlPackage.load(template);
        const worksheetPart = dataWorksheet(pkg);
        const worksheet = worksheetPart.rootElement;
        if (worksheet == undefined)
            throw new Error("The Excel template's data worksheet is not XML");

        const sheetData = worksheet.element("sheetData");
        if (sheetData == undefined)
            throw new Error("The Excel template's data worksheet has no sheetData");

        const sharedStrings = readSharedStrings(pkg);
        const columns = columnEquivalences(sheetData, request, sharedStrings);

        // Signum reads the header style off cell A1 — the template's own header formatting, applied to
        // whichever columns the report ends up writing.
        const headerStyleIndex = styleOfCell(sheetData, "A1") ?? 0;

        const cellBuilder = readCellBuilder();

        const rows: OxmlElement[] = [];
        rows.push(rowOf(columns.map(cd =>
            cellBuilder.cell(cd.column.displayName ?? cd.column.token.niceName(), 0, headerStyleIndex, false))));

        for (const row of results.rows) {
            rows.push(rowOf(columns.map(cd => {
                const defaultStyle = cellBuilder.getDefaultStyle(cd.column.token);
                const raw = row.getValue(cd.column.token);
                // An enum reaches the sheet as its localized text, exactly as a plain export writes it.
                const value = defaultStyle === DefaultStyle.Enum ? enumText(raw, cd.column.token, false) : raw;
                // The STYLE index is the template's (the sample row's), never the default one — that is
                // what carries the author's formatting. The default style still decides how the VALUE is
                // written (a date as a serial number, a decimal as a number, everything else as text).
                return cellBuilder.cell(value, defaultStyle, cd.styleIndex, false);
            })));
        }

        stampReferences(rows);

        // Signum's `sheetData.InnerXml = ""` — the template's sample rows go, the report's rows replace
        // them. The rest of the worksheet (its <cols> widths, merges, conditional formats) stays.
        sheetData.removeAllChildren();
        for (const r of rows)
            sheetData.appendChild(r);

        fixDimension(worksheet, rows.length, columns.length);
        refreshPivotCaches(pkg, columns.filter(c => !c.isNew).length, results.rows.length);

        // The calculation chain describes the TEMPLATE's cells and is stale the moment the rows are
        // replaced, so it goes and the workbook recalculates on open. Signum keeps the chain and only sets
        // the two flags; a chain naming deleted cells is what makes Excel offer to "repair" the file.
        removeCalcChain(pkg);
        forceFullCalcOnLoad(pkg);

        return pkg.save();
    }

    // ---- the columns ---------------------------------------------------------------------------------

    /** Signum's `ColumnData` — a query column, the template style its values take, and whether the
     *  template mentioned it at all. */
    interface ColumnData {
        column: Column;
        /** The style index the sample row gives this column; 0 for a column the template does not have. */
        styleIndex: number;
        /** True when the query has the column but the template does not — it is APPENDED to the sheet. */
        isNew: boolean;
    }

    /**
     * Signum's `GetColumnsEquivalences` — match the template's header cells to the request's columns by
     * DISPLAY NAME, and take each column's style from the sample row.
     *
     * A template column with no matching query column is an ERROR, not something to skip: the workbook's
     * pivots and formulas are written against that column, so producing the file without it would hand
     * back something quietly broken.
     */
    function columnEquivalences(
        sheetData: OxmlElement, request: QueryRequest, sharedStrings: string[],
    ): ColumnData[] {
        const resultColumns = new Map<string, Column>();
        for (const c of request.columns)
            if (!c.token.isEntity()) // the row-identity column the engine prepends; never exported
                resultColumns.set(c.displayName ?? c.token.niceName(), c);

        const dataRows = [...sheetData.elements("row")];
        const headerRow = dataRows[0];
        if (headerRow == undefined)
            throw new Error("The Excel template's data worksheet is empty — it needs a header row");

        const headerCells = [...headerRow.elements("c")];
        const sampleCells = sampleRowCells(dataRows, headerCells);

        const result: ColumnData[] = [];
        const matched = new Set<string>();

        headerCells.forEach((cell, i) => {
            const name = cellText(cell, sharedStrings) ?? "";
            const column = resultColumns.get(name);
            if (column == undefined)
                throw new Error(ExcelMessage.TheExcelTemplateHasAColumn0NotPresentInTheFindWindow
                    .niceToString(name));

            matched.add(name);
            result.push({
                column,
                styleIndex: sampleCells[i] == undefined ? 0 : parseInt(sampleCells[i]!.getAttribute("s") ?? "0", 10),
                isNew: false,
            });
        });

        // A query column the template does not mention still goes in, unstyled and after the rest —
        // Signum's `isNew: true` branch. It is what lets someone add a column to the search and still run
        // an old report; the pivots keep their own range (see refreshPivotCaches).
        for (const [name, column] of resultColumns)
            if (!matched.has(name))
                result.push({ column, styleIndex: 0, isNew: true });

        return result;
    }

    /**
     * Signum's `IsValidRowDataTemplate` — the first row below the header that can serve as the style
     * sample: it must have at least as many cells as the header, and its Nth cell must sit in the same
     * COLUMN as the header's Nth (so a row with merged or shifted cells is skipped).
     */
    function sampleRowCells(rows: OxmlElement[], headerCells: OxmlElement[]): OxmlElement[] {
        for (const row of rows) {
            const rowIndex = parseInt(row.getAttribute("r") ?? "0", 10);
            if (rowIndex <= 1) // row 1 is the header
                continue;

            const cells = [...row.elements("c")];
            if (cells.length < headerCells.length)
                continue;

            const last = headerCells.length - 1;
            const headerRef = headerCells[last]?.getAttribute("r");
            const dataRef = cells[last]?.getAttribute("r");
            if (headerRef == undefined || dataRef == undefined)
                continue;

            // Signum compares the two references character by character and accepts when the first
            // difference is a DIGIT — i.e. they differ only in the row number, so they are the same column.
            if (columnLetters(headerRef) === columnLetters(dataRef))
                return cells;
        }

        return [];
    }

    // ---- the workbook --------------------------------------------------------------------------------

    /**
     * The worksheet the report writes into — Signum's `GetWorksheetPartBySheetName(ExcelMessage.Data)`.
     *
     * The sheet is named by the LOCALIZED "Data", which makes a template authored in one culture
     * unreadable in another. altea looks for the localized name first (so a Signum template keeps working
     * exactly as it did), then the invariant "Data", and finally accepts a workbook that has only ONE
     * worksheet — the case where there is nothing to disambiguate. Only a multi-sheet workbook with no
     * recognisable data sheet fails, and then the message says what was looked for.
     */
    function dataWorksheet(pkg: OxmlPackage): OxmlPart {
        const workbook = pkg.mainPart.rootElement;
        const sheets = workbook?.element("sheets");

        const localized = ExcelMessage.Data.niceToString();
        for (const wanted of [localized, "Data"]) {
            const sheet = sheets == undefined ? undefined
                : [...sheets.elements("sheet")].find(s => s.getAttribute("name") === wanted);
            const id = sheet?.getAttribute("r:id") ?? sheet?.getAttribute("id");
            const part = id == undefined ? undefined : pkg.mainPart.getPartById(id);
            if (part != undefined)
                return part;
        }

        const worksheets = pkg.mainPart.partsOfType(RelationshipTypes.worksheet);
        if (worksheets.length === 1)
            return worksheets[0]!;

        throw new Error(`The Excel template has no worksheet named '${localized}'`
            + (localized === "Data" ? "" : " or 'Data'"));
    }

    /** The `s=` of a cell addressed by reference, e.g. "A1". */
    function styleOfCell(sheetData: OxmlElement, reference: string): number | undefined {
        for (const row of sheetData.elements("row"))
            for (const cell of row.elements("c"))
                if (cell.getAttribute("r") === reference) {
                    const s = cell.getAttribute("s");
                    return s == undefined ? undefined : parseInt(s, 10);
                }
        return undefined;
    }

    /**
     * Signum's pivot-cache pass: every pivot table whose source is the Data sheet gets its range widened
     * (or narrowed) to what was just written, and is told to refresh when the file opens.
     *
     * `saveData = false` drops the cached records with it — they describe the template's sample rows, and
     * leaving them would show the old numbers until someone refreshed by hand.
     *
     * The range covers only the columns the TEMPLATE had: a column the query added is appended to the
     * right, and a pivot built before it existed does not know what to do with it (Signum's same
     * `Count(ce => !ce.IsNew)`).
     */
    function refreshPivotCaches(pkg: OxmlPackage, templateColumnCount: number, rowCount: number): void {
        const sheetName = ExcelMessage.Data.niceToString();

        // A pivot cache definition has no RelationshipTypes constant here, so it is found by CONTENT TYPE
        // — the idiom SpreadsheetUtils.removeCalcChain already uses for the calculation chain.
        for (const part of pkg.parts.filter(p => p.contentType.includes("pivotCacheDefinition"))) {
            const definition = part.rootElement;
            if (definition == undefined)
                continue;

            const source = definition.descendantsNamed("worksheetSource")[0];
            if (source == undefined)
                continue;

            const sheet = source.getAttribute("sheet");
            if (sheet !== sheetName && sheet !== "Data")
                continue;

            source.setAttribute("ref", `A1:${columnName(Math.max(templateColumnCount, 1))}${rowCount + 1}`);
            definition.setAttribute("refreshOnLoad", "1");
            definition.setAttribute("saveData", "0");
        }
    }

    /** `<dimension ref="A1:E42">` — Excel repairs a file whose dimension does not cover its cells. */
    function fixDimension(worksheet: OxmlElement, rowCount: number, columnCount: number): void {
        const dimension = worksheet.element("dimension");
        if (dimension != undefined)
            dimension.setAttribute("ref", `A1:${columnName(Math.max(columnCount, 1))}${Math.max(rowCount, 1)}`);
    }
}

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
