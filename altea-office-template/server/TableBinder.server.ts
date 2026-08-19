// Port of Signum.Word's TableBinder.cs — binding tabular data into a chart or a table that the template
// author drew in Word / PowerPoint.
//
// The addressing trick is worth spelling out, because it is not obvious from the code: there is no token
// syntax for "fill this chart". Instead the AUTHOR types a key into the shape's **alternative text** (the
// Title/Description of a `wp:docPr` in Word, or an `p:cNvPr` in PowerPoint):
//
//     UserChart:8f3c1e6a-…-b21          <- "<providerKey>:<suffix>"
//     Pivot(0,1,2)                      <- optional second line, reshapes the result
//
// `<providerKey>` selects a registered IOfficeDataTableProvider, `<suffix>` tells it which data to fetch.
// The shape's existing series / rows are then GROWN OR SHRUNK to match the data (`synchronizeNodes`), which
// is what preserves the author's formatting: the last series is cloned for extra columns, and surplus ones
// are deleted, so colours, fonts and number formats all survive.
//
// altea divergences:
//  - `System.Data.DataTable` → the small DataTable in DataTable.server.ts (see its header).
//  - The SDK's generated chart classes (`Charts.SeriesText`, `Charts.PointCount`, …) → qualified element
//    names in the `c:` namespace. The chart part always binds `c:` to the chart namespace, so the names are
//    stable; a chart authored with a different prefix would not be recognised, which is the same
//    assumption the rest of the port makes (see OxmlElement's header).
//  - Signum's providers are registered into a static dictionary at Start; altea keeps the identical
//    registry (`toDataTableProviders`) but the UserQuery/UserChart providers are registered by
//    OfficeTemplateLogic so this module stays free of query-engine dependencies.
//  - `ExcelExtensions.ToExcelDate` → `toExcelString` below (shared with OfficeTemplateNodes' cell typing).

import { Decimal } from "decimal.js";
import { Temporal } from "temporal-polyfill";
import { TemplateError } from "@altea/altea-templating/server/TemplateUtils.server";
import type { OfficeTemplateEntity } from "../data/OfficeTemplate";
import type { OfficeTemplateParameters } from "./OfficeTemplateParameters.server";
import { DataTable, parsePivot, toDataTablePivot } from "./DataTable.server";
import { OxmlElement, OxmlText } from "./oxml/OxmlElement.server";
import { RelationshipTypes, type OxmlPart } from "./oxml/OxmlPackage.server";
import type { IOfficeModel } from "./OfficeTemplateParameters.server";

/** Signum's WordContext — what a provider gets to resolve its data against. */
export interface OfficeContext {
    readonly template: OfficeTemplateEntity;
    readonly entity: object | null;
    readonly model: IOfficeModel | undefined;
}

/** A provider's result: the table, plus any per-series/point colour overrides it wants applied. */
export interface DataTableResult {
    readonly table: DataTable;
    /** Series/category name → "#rrggbb" (Signum's `out Dictionary<string,string>? overridenColors`). */
    readonly overridenColors?: Map<string, string>;
}

/** Signum's IWordDataTableProvider. */
export interface IOfficeDataTableProvider {
    /** Parse-time check; returns an error message, or undefined when the suffix is usable. */
    validate(suffix: string, template: OfficeTemplateEntity): string | undefined;
    getDataTable(suffix: string, context: OfficeContext): Promise<DataTableResult>;
}

/** Signum's `WordTemplateLogic.ToDataTableProviders`, keyed by the prefix before the colon. */
export const toDataTableProviders = new Map<string, IOfficeDataTableProvider>();

// ---- validate / process --------------------------------------------------------------------------------

/** Signum's ValidateTables — parse-time check of every shape's alternative text. */
export async function validateTables(part: OxmlPart, template: OfficeTemplateEntity, errors: TemplateError[]): Promise<void> {
    for (const title of shapeTitles(part))
        await validateTitle(template, errors, title.title);
}

async function validateTitle(template: OfficeTemplateEntity, errors: TemplateError[], title: string): Promise<void> {
    const titleFirstLine = title.split("\n")[0];
    const prefix = tryBefore(titleFirstLine, ":");
    if (prefix == null)
        return;

    const provider = toDataTableProviders.get(prefix);
    if (provider == null)
        return;

    const error = provider.validate(after(titleFirstLine, ":"), template);
    if (error != null)
        errors.push(new TemplateError(false, error));

    const pivotStr = tryAfter(title, "\n")?.trim();
    if (pivotStr != null && pivotStr !== "" && parsePivot(pivotStr) == null)
        errors.push(new TemplateError(false,
            `Unexpected Alternative Text '${title}'\nDid you wanted to use 'Pivot(colX, colY, colValue)'?`));
}

/** Signum's ProcessTables — render-time binding of every shape whose alternative text names a provider. */
export async function processTables(part: OxmlPart, parameters: OfficeTemplateParameters): Promise<void> {
    for (const { container, title } of shapeTitles(part)) {
        const result = await getDataTable(parameters, title);
        if (result != null)
            replaceChartOrTable(part, container, result.table, title, result.overridenColors);
    }
}

/**
 * Every shape in the part that carries alternative text, with that text.
 *
 * Signum walks `Presentation.GraphicFrame` (PowerPoint) and `Wordprocessing.Drawing` (Word) separately and
 * reads Description ?? Title off the non-visual properties inside each. The two element names differ but
 * the lookup is identical, so this yields both.
 */
function* shapeTitles(part: OxmlPart): Generator<{ container: OxmlElement; title: string }> {
    if (!part.isXml)
        return;

    for (const container of part.document.root.descendants()) {
        if (container.qualifiedName !== "p:graphicFrame" && container.qualifiedName !== "w:drawing")
            continue;

        // `p:cNvPr` (PowerPoint non-visual drawing properties) / `wp:docPr` (Word doc properties).
        const props = [...container.descendants()]
            .find(d => d.qualifiedName === "p:cNvPr" || d.qualifiedName === "wp:docPr");
        if (props == null)
            continue;

        const title = props.getAttribute("descr") ?? props.getAttribute("title");
        if (title != null && title !== "")
            yield { container, title };
    }
}

function replaceChartOrTable(
    part: OxmlPart, container: OxmlElement, dataTable: DataTable,
    titleForError: string, overridenColors: Map<string, string> | undefined,
): void {
    // A chart lives in its own part, reached through the `c:chart` reference's relationship id.
    const chartRef = single(container.descendants(), d => d.qualifiedName === "c:chart");
    if (chartRef != null) {
        const id = chartRef.getAttribute("r:id");
        const chartPart = id == null ? undefined : part.getPartById(id);
        if (chartPart == null)
            throw new Error(`The chart reference '${id}' does not resolve to a part of the package`);
        const chart = single(chartPart.document.root.descendants(), d => d.qualifiedName === "c:chart");
        if (chart == null)
            throw new Error(`No <c:chart> found in '${chartPart.uri}'`);
        replaceChart(chart, dataTable, titleForError, overridenColors);
        return;
    }

    // Otherwise it is a DrawingML table drawn inline.
    const table = single(container.descendants(), d => d.qualifiedName === "a:tbl");
    if (table != null)
        replaceTable(table, dataTable);
}

// ---- node synchronization ------------------------------------------------------------------------------

/**
 * Grow or shrink `nodes` so there is exactly one per entry of `data`, applying `apply` to each pair.
 *
 * This is Signum's SynchronizeNodes and it is the heart of "keep the author's formatting": extra entries
 * CLONE the last existing node (inheriting its styling) rather than building one from scratch, and surplus
 * nodes are removed. `isCloned` lets the caller strip theme-derived colours from a clone so the new series
 * does not repeat the last one's colour.
 */
function synchronizeNodes<N extends OxmlElement, T>(
    nodes: N[], data: T[], apply: (node: N, item: T, index: number, isCloned: boolean) => void,
): void {
    if (nodes.length === 0)
        return;

    let last = nodes[nodes.length - 1];
    for (let i = 0; i < data.length; i++) {
        if (i < nodes.length) {
            apply(nodes[i], data[i], i, false);
        } else {
            const clone = last.cloneNode(true) as N;
            last.parent!.insertAfter(clone, last);
            apply(clone, data[i], i, true);
            last = clone;
        }
    }

    for (let i = data.length; i < nodes.length; i++)
        nodes[i].remove();
}

// ---- DrawingML table -----------------------------------------------------------------------------------

/** Signum's ReplaceTable — bind the data into an `a:tbl`'s grid, header row and body rows. */
function replaceTable(table: OxmlElement, dataTable: DataTable): void {
    const tableGrid = single(table.descendants(), d => d.qualifiedName === "a:tblGrid");
    if (tableGrid != null) {
        synchronizeNodes(
            [...tableGrid.descendants()].filter(d => d.qualifiedName === "a:gridCol"),
            dataTable.columns,
            () => { /* the column exists; its width is the author's */ });
    }

    const rows = [...table.descendants()].filter(d => d.qualifiedName === "a:tr");
    if (rows.length === 0)
        return;

    // Header row: one cell per column, carrying the column's caption.
    synchronizeNodes(
        [...rows[0].descendants()].filter(d => d.qualifiedName === "a:tc"),
        dataTable.columns,
        (tc, dc) => {
            const text = single(tc.descendants(), d => d.qualifiedName === "a:t");
            if (text != null)
                setText(text, dc.displayName);
        });

    // Body rows: one per data row, one cell per column.
    synchronizeNodes(
        rows.slice(1),
        dataTable.rows,
        (tr, dr) => {
            synchronizeNodes(
                [...tr.descendants()].filter(d => d.qualifiedName === "a:tc"),
                dataTable.columns.map((_dc, i) => dr[i]),
                (tc, val) => {
                    const text = single(tc.descendants(), d => d.qualifiedName === "a:t");
                    if (text != null)
                        setText(text, toExcelString(val) ?? "");
                });
        });
}

// ---- chart ---------------------------------------------------------------------------------------------

/**
 * Signum's ReplaceChart — bind the data into a chart's series.
 *
 * Column 0 is the CATEGORY axis; every remaining column becomes one series. A non-numeric, non-date column
 * cannot be a series, and the error says so with the `Pivot(...)` fix, because that is the mistake authors
 * actually make (a flat three-column result where they wanted a matrix).
 */
export function replaceChart(
    chart: OxmlElement, table: DataTable, titleForError: string, overridenColors: Map<string, string> | undefined,
): void {
    const plotArea = single(chart.descendants(), d => d.qualifiedName === "c:plotArea");
    if (plotArea == null)
        throw new Error("No <c:plotArea> found in the chart");

    const series = [...plotArea.descendants()].filter(d => d.localName === "ser");
    const rows = table.rows;

    synchronizeNodes(series, table.columns.slice(1), (ser, col, i, isCloned) => {
        if (!col.canBeChartSeries)
            throw new Error(
                `Unable to bind the chart serie with the column '${col.columnName}' of kind '${col.kind}'. ` +
                `Consider using 'Pivot(colY, colX, colValue)' in the Alternative Text of your chart like this:\n` +
                `${titleForError.split("\n")[0]}\nPivot(0,1,2)`);

        // A cloned series would otherwise repeat the theme colour of the one it was cloned from.
        if (isCloned)
            for (const f of [...ser.descendants()].filter(d => d.qualifiedName === "a:schemeClr"))
                f.remove();

        bindSerie(ser, rows, table, col, i, overridenColors);
    });
}

function bindSerie(
    serie: OxmlElement, rows: unknown[][], table: DataTable,
    dataColumn: { columnName: string }, index: number, overridenColors: Map<string, string> | undefined,
): void {
    // Formula references point at the chart's embedded workbook, which the renderer strips; drop them or
    // Excel/Word would try to re-read stale cached values.
    for (const f of [...serie.descendants()].filter(d => d.qualifiedName === "c:f"))
        f.remove();

    setVal(serie.element("c:idx"), index);
    setVal(serie.element("c:order"), index);

    const setTxt = single(serie.descendants(), d => d.qualifiedName === "c:tx");
    if (setTxt != null) {
        const v = single(setTxt.descendants(), d => d.qualifiedName === "c:v");
        if (v != null)
            setText(v, dataColumn.columnName);
    }

    const colorSerie = overridenColors?.get(dataColumn.columnName);
    if (colorSerie != null)
        applySolidFill(single(serie.descendants(), d => d.qualifiedName === "c:spPr"), colorSerie);

    // Categories: column 0 of every row, as string or numeric points depending on how the author drew it.
    const cat = single(serie.descendants(), d => d.qualifiedName === "c:cat");
    if (cat != null) {
        setVal(single(cat.descendants(), d => d.qualifiedName === "c:ptCount"), rows.length);

        const strPoints = [...cat.descendants()].filter(d => d.qualifiedName === "c:pt" && isUnder(d, "c:strCache"));
        const numPoints = [...cat.descendants()].filter(d => d.qualifiedName === "c:pt" && isUnder(d, "c:numCache"));
        const points = strPoints.length > 0 ? strPoints : numPoints;

        if (points.length === 0)
            throw new Error("Neither a string nor a numeric cache found in <c:cat>");

        synchronizeNodes(points, rows, (sp, row, i) => {
            sp.setAttribute("idx", String(i));
            const v = single(sp.descendants(), d => d.qualifiedName === "c:v");
            if (v != null)
                setText(v, toExcelString(row[0]) ?? "");
        });
    }

    // Per-point colours (a pie chart coloured by category).
    if (overridenColors != null) {
        const dataPoints = [...serie.descendants()].filter(d => d.qualifiedName === "c:dPt");
        if (dataPoints.length > 0) {
            synchronizeNodes(dataPoints, rows, (sp, row, i) => {
                const idx = sp.element("c:idx");
                if (idx != null)
                    setVal(idx, i);
                const key = row[0];
                const color = key == null ? undefined : overridenColors.get(String(key));
                if (color != null)
                    applySolidFill(single(sp.descendants(), d => d.qualifiedName === "c:spPr"), color);
            });
        }
    }

    // Values: this series' column, one point per row.
    const vals = single(serie.descendants(), d => d.qualifiedName === "c:val");
    if (vals != null) {
        setVal(single(vals.descendants(), d => d.qualifiedName === "c:ptCount"), rows.length);
        const columnIndex = table.columns.findIndex(c => c.columnName === dataColumn.columnName);
        const valuePoints = [...vals.descendants()].filter(d => d.qualifiedName === "c:pt");
        synchronizeNodes(valuePoints, rows, (sp, row, i) => {
            sp.setAttribute("idx", String(i));
            const v = single(sp.descendants(), d => d.qualifiedName === "c:v");
            if (v != null)
                setText(v, toExcelString(row[columnIndex]) ?? "");
        });
    }
}

/** Replace a shape-properties element's fill with a solid RGB one (Signum's SolidFill insertion at 0). */
function applySolidFill(spPr: OxmlElement | undefined, color: string): void {
    if (spPr == null)
        return;

    for (const f of [...spPr.elements()].filter(e => e.qualifiedName === "a:solidFill"))
        f.remove();

    const solidFill = new OxmlElement("a:solidFill");
    const srgb = new OxmlElement("a:srgbClr");
    srgb.setAttribute("val", after(color, "#"));
    solidFill.appendChild(srgb);
    spPr.insertAt(solidFill, 0);
}

// ---- data-table lookup ---------------------------------------------------------------------------------

/** Signum's GetDataTable — resolve the shape's alternative text to a provider and run it. */
async function getDataTable(parameters: OfficeTemplateParameters, title: string): Promise<DataTableResult | undefined> {
    const titleFirstLine = title.split("\n")[0];
    const key = tryBefore(titleFirstLine, ":");
    if (key == null)
        return undefined;

    const provider = toDataTableProviders.get(key);
    if (provider == null)
        return undefined;

    const ctx: OfficeContext = {
        template: parameters.template,
        entity: parameters.entity,
        model: parameters.model,
    };

    const result = await provider.getDataTable(after(titleFirstLine, ":"), ctx);

    const pivotStr = tryAfter(title, "\n")?.trim();
    if (pivotStr != null && pivotStr !== "") {
        const pivot = parsePivot(pivotStr);
        if (pivot != null)
            return { table: toDataTablePivot(result.table, pivot.colY, pivot.colX, pivot.colValue), overridenColors: result.overridenColors };
    }

    return result;
}

// ---- helpers -------------------------------------------------------------------------------------------

/**
 * The invariant text of a value as a chart/table cell holds it (Signum's ToExcelString). Dates become
 * Excel SERIAL numbers, so a chart's date axis scales correctly instead of treating them as labels.
 */
export function toExcelString(val: unknown): string | undefined {
    if (val == null)
        return undefined;

    if (val instanceof Temporal.PlainDate)
        return String(excelEpoch.until(val).total({ unit: "days" }));

    if (val instanceof Temporal.PlainDateTime) {
        const days = excelEpoch.until(val.toPlainDate()).total({ unit: "days" });
        const seconds = val.toPlainTime().since(Temporal.PlainTime.from("00:00")).total({ unit: "seconds" });
        return String(days + seconds / 86400);
    }

    if (val instanceof Decimal)
        return val.toString();

    if (typeof val === "number" || typeof val === "bigint" || typeof val === "boolean")
        return String(val);

    return String(val);
}

/** 1899-12-30: the Excel serial-date epoch, offset to absorb Excel's 1900 leap-year bug. */
const excelEpoch = Temporal.PlainDate.from("1899-12-30");

/** Set an element's `val` attribute (the SDK's `UInt32Value` properties). */
function setVal(element: OxmlElement | undefined, value: number): void {
    element?.setAttribute("val", String(value));
}

/** Replace an element's text content. */
function setText(element: OxmlElement, text: string): void {
    element.removeAllChildren();
    element.appendChild(new OxmlText(text));
}

/** True when `element` has an ancestor with this qualified name. */
function isUnder(element: OxmlElement, ancestorName: string): boolean {
    for (const a of element.ancestors())
        if (a.qualifiedName === ancestorName)
            return true;
    return false;
}

/** The single match, or undefined (Signum's SingleOrDefaultEx — more than one is a bug, so it throws). */
function single(source: Iterable<OxmlElement>, predicate: (e: OxmlElement) => boolean): OxmlElement | undefined {
    let found: OxmlElement | undefined;
    for (const e of source) {
        if (!predicate(e))
            continue;
        if (found != null)
            throw new Error("More than one matching element found where at most one was expected");
        found = e;
    }
    return found;
}

function tryBefore(text: string, separator: string): string | undefined {
    const i = text.indexOf(separator);
    return i < 0 ? undefined : text.slice(0, i);
}

function tryAfter(text: string, separator: string): string | undefined {
    const i = text.indexOf(separator);
    return i < 0 ? undefined : text.slice(i + separator.length);
}

function after(text: string, separator: string): string {
    const i = text.indexOf(separator);
    return i < 0 ? text : text.slice(i + separator.length);
}

export { RelationshipTypes };
