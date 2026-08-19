// Port of Signum.Word's Spreedsheet/SpreadsheetUtils.cs — the xlsx-specific steps of the template pipeline.
//
//   PREP (before parsing):   deshareFormulas, inlineTokens, inlineNoteTokens
//   CLEANUP (after render):  finalize
//
// Row math is delegated to SpreadsheetBlockPlan; reference surgery to FormulaRewriter.
//
// altea note on element names: a worksheet / workbook / sharedStrings part binds the SpreadsheetML schema
// as its DEFAULT namespace, so its elements are UNPREFIXED (`c`, `f`, `v`, `is`, `row`, `sheetData`) —
// unlike WordprocessingML's `w:` and DrawingML's `a:`. That is why the spreadsheet node provider and this
// module match on bare names.

import { OxmlElement, OxmlText } from "../oxml/OxmlElement.server";
import { RelationshipTypes, type OxmlPackage, type OxmlPart } from "../oxml/OxmlPackage.server";
import { scanKeywords } from "@altea/altea-templating/server/TemplateUtils.server";
import {
    columnIndex, columnLetters, columnName, rewriteRefs, rowDigits,
} from "./FormulaRewriter.server";
import { SpreadsheetBlockPlan, rowIndexOf, type SpreadsheetForeachBlock } from "./SpreadsheetBlockPlan.server";

/** Every worksheet part of a workbook. */
function worksheetParts(package_: OxmlPackage): OxmlPart[] {
    return package_.mainPart.partsOfType(RelationshipTypes.worksheet);
}

function worksheetRoot(part: OxmlPart): OxmlElement | undefined {
    return part.isXml ? part.document.root : undefined;
}

// ================================================================= Prep

/**
 * Expand shared formulas (`<f t="shared" si="0" ref="B5:B9">`) into standalone ones.
 *
 * Excel stores a column of identical formulas ONCE — a "master" cell holds the text and the rest reference
 * it by index. Cloning a template row would duplicate that index and its range, which corrupts the
 * workbook, so every shared formula is materialised first: the master's text is re-based to each cell's
 * own position by offsetting the RELATIVE references (absolute ones stay put, which is the whole point of
 * the `$`).
 */
export function deshareFormulas(package_: OxmlPackage): void {
    for (const part of worksheetParts(package_)) {
        const root = worksheetRoot(part);
        if (root == null)
            continue;

        const cells = root.descendantsNamed("c")
            .filter(c => c.element("f")?.getAttribute("t") === "shared");

        if (cells.length === 0)
            continue;

        // The master of each shared group holds the actual formula text.
        const masters = new Map<string, { row: number; col: number; text: string }>();
        for (const c of cells) {
            const f = c.element("f")!;
            const si = f.getAttribute("si");
            const text = f.innerText;
            if (si != null && text !== "" && !masters.has(si))
                masters.set(si, { row: rowOfCell(c), col: columnOfCell(c), text });
        }

        for (const c of cells) {
            const f = c.element("f")!;
            const si = f.getAttribute("si");
            const master = si == null ? undefined : masters.get(si);

            if (f.innerText === "" && master != null) {
                const dRow = rowOfCell(c) - master.row;
                const dCol = columnOfCell(c) - master.col;
                setText(f, rewriteRefs(master.text, r => {
                    if (!r.rowAbs) r.row += dRow;
                    if (!r.colAbs) r.col = columnName(columnIndex(r.col) + dCol);
                    return r;
                }));
            }

            f.removeAttribute("t");
            f.removeAttribute("si");
            f.removeAttribute("ref");
        }
    }
}

/**
 * Convert every shared-string cell whose text carries a template keyword into an INLINE string holding a
 * private copy of the runs.
 *
 * A spreadsheet keeps cell text in a deduplicated pool (`sharedStrings.xml`), so one physical `<si>` can be
 * referenced by many cells — rendering a token in place would change every cell that happens to share the
 * text. Inlining also attaches the token to the cell, giving it the `cell -> row -> sheetData` ancestor
 * chain the parser needs to find the enclosing row.
 */
export function inlineTokens(package_: OxmlPackage): void {
    const sstPart = package_.mainPart.partsOfType(RelationshipTypes.sharedStrings)[0];
    const sst = sstPart == null ? undefined : worksheetRoot(sstPart);
    if (sst == null)
        return;

    const sharedItems = [...sst.elements("si")];

    for (const part of worksheetParts(package_)) {
        const root = worksheetRoot(part);
        if (root == null)
            continue;

        for (const cell of root.descendantsNamed("c")) {
            if (cell.getAttribute("t") !== "s")
                continue;

            const v = cell.element("v");
            if (v == null)
                continue;

            const idx = parseInt(v.innerText, 10);
            if (Number.isNaN(idx) || idx < 0 || idx >= sharedItems.length)
                continue;

            const si = sharedItems[idx];
            if (scanKeywords(si.innerText).length === 0)
                continue;

            const inline = new OxmlElement("is");
            for (const child of si.childElements)
                inline.appendChild(child.cloneNode(true));

            cell.removeAllChildren();      // also drops the <v> shared-string index
            cell.setAttribute("t", "inlineStr");
            cell.appendChild(inline);
        }
    }
}

/**
 * Use cell NOTES (legacy comments) as token carriers: a note containing a template keyword becomes its
 * anchored cell's content, and the note is removed.
 *
 * This is how a token reaches a cell that cannot hold it directly — the motivating case is a cell with date
 * data-validation, which rejects `@[…]` as invalid input at authoring time. The author-name prefix Excel
 * prepends (everything up to the first line break) is dropped.
 */
export function inlineNoteTokens(package_: OxmlPackage): void {
    for (const part of worksheetParts(package_)) {
        const root = worksheetRoot(part);
        if (root == null)
            continue;

        const commentsPart = part.partsOfType(RelationshipTypes.comments)[0];
        const commentsRoot = commentsPart == null ? undefined : worksheetRoot(commentsPart);
        const commentList = commentsRoot?.element("commentList");
        if (commentList == null)
            continue;

        const cellsByRef = new Map<string, OxmlElement>();
        for (const c of root.descendantsNamed("c")) {
            const r = c.getAttribute("r");
            if (r != null && !cellsByRef.has(r))
                cellsByRef.set(r, c);
        }

        for (const comment of [...commentList.elements("comment")]) {
            if (scanKeywords(comment.innerText).length === 0)
                continue;

            const reference = comment.getAttribute("ref");
            const cell = reference == null ? undefined : cellsByRef.get(reference);
            if (cell == null)
                continue;

            cell.removeAllChildren();
            cell.setAttribute("t", "inlineStr");
            const inline = new OxmlElement("is");
            const t = new OxmlElement("t");
            t.space = "preserve";
            t.appendChild(new OxmlText(noteBody(comment.innerText)));
            inline.appendChild(t);
            cell.appendChild(inline);

            comment.remove();
        }

        // If every note was a token binding, drop the now-empty note infrastructure.
        if ([...commentList.elements("comment")].length === 0)
            removeNotes(package_, part, commentsPart!);
    }
}

/** Excel prepends "Author:\n" to a note; the meaningful body is what follows the first line break. */
function noteBody(commentText: string): string {
    const nl = commentText.indexOf("\n");
    return (nl >= 0 ? commentText.slice(nl + 1) : commentText).trim();
}

function removeNotes(package_: OxmlPackage, wsPart: OxmlPart, commentsPart: OxmlPart): void {
    package_.deletePart(wsPart, commentsPart);

    // Legacy notes also carry a VML drawing (the yellow box) referenced by a <legacyDrawing> element.
    worksheetRoot(wsPart)?.element("legacyDrawing")?.remove();
    for (const vml of wsPart.partsOfType(RelationshipTypes.vmlDrawing))
        package_.deletePart(wsPart, vml);
}

// ================================================================= Cleanup

/**
 * After the renderer cloned the body rows of each row-level `@foreach`, renumber every row and cell and
 * rewrite the formula references (see SpreadsheetBlockPlan for the mapping), then repair the sheet-level
 * bookkeeping: merges, data validations, the dimension, the calc chain and the recalc flag.
 */
export function finalize(package_: OxmlPackage, blocks: readonly SpreadsheetForeachBlock[]): void {
    for (const part of worksheetParts(package_)) {
        const root = worksheetRoot(part);
        const sheetData = root?.element("sheetData");
        if (root == null || sheetData == null)
            continue;

        const sheetBlocks = blocks.filter(b => b.worksheet === root);
        if (sheetBlocks.length > 0)
            finalizeSheet(root, sheetData, sheetBlocks);
    }

    removeCalcChain(package_);
    forceFullCalcOnLoad(package_);
}

function finalizeSheet(root: OxmlElement, sheetData: OxmlElement, blocks: SpreadsheetForeachBlock[]): void {
    const rows = [...sheetData.elements("row")];
    const plan = SpreadsheetBlockPlan.compute(rows, blocks);

    for (const row of rows) {
        const m = plan.rows.get(row);
        if (m != null)
            renumberRow(row, m.newRow, m.inBlock, plan);
    }

    remapMerges(root, plan);
    dropDataValidations(root);
    fixDimension(root, sheetData);
}

function renumberRow(row: OxmlElement, newRow: number, inBlock: boolean, plan: SpreadsheetBlockPlan): void {
    const oldRow = rowIndexOf(row);
    const shift = oldRow == null ? 0 : newRow - oldRow;

    for (const cell of row.elements("c")) {
        fixCellFormula(cell, inBlock, shift, plan);
        fixCellReference(cell, newRow);
    }

    row.setAttribute("r", String(newRow));
}

function fixCellFormula(cell: OxmlElement, inBlock: boolean, shift: number, plan: SpreadsheetBlockPlan): void {
    const f = cell.element("f");
    if (f == null || f.innerText === "")
        return;

    // Inside a CLONED body row a relative reference follows the clone (it meant "this row"); everything
    // else — an absolute anchor, or any reference on a row outside the block — remaps by position.
    setText(f, rewriteRefs(f.innerText, r => {
        r.row = inBlock && !r.rowAbs ? r.row + shift : plan.mapRow(r.row);
        return r;
    }));

    cell.element("v")?.remove(); // a stale cached result; recalculated on load
}

function fixCellReference(cell: OxmlElement, newRow: number): void {
    const cr = cell.getAttribute("r");
    if (cr != null)
        cell.setAttribute("r", columnLetters(cr) + newRow);
}

function remapMerges(root: OxmlElement, plan: SpreadsheetBlockPlan): void {
    const merges = root.element("mergeCells");
    if (merges == null)
        return;

    for (const mc of [...merges.elements("mergeCell")]) {
        const reference = mc.getAttribute("ref");
        if (reference == null)
            continue;

        const parts = reference.split(":");
        if (parts.length !== 2)
            continue;

        const r1 = rowDigits(parts[0]);
        const r2 = rowDigits(parts[1]);

        // A merge on a removed @foreach / @endforeach marker row no longer has a home.
        if (plan.isMarkerRow(r1) || plan.isMarkerRow(r2)) {
            mc.remove();
            continue;
        }

        mc.setAttribute("ref",
            `${columnLetters(parts[0])}${plan.mapRow(r1)}:${columnLetters(parts[1])}${plan.mapRow(r2)}`);
    }

    const remaining = [...merges.elements("mergeCell")];
    if (remaining.length === 0)
        merges.remove();
    else
        merges.setAttribute("count", String(remaining.length));
}

/** A generated report is not a fill-in form, and validations anchored to template rows would be stale. */
function dropDataValidations(root: OxmlElement): void {
    for (const dv of [...root.elements("dataValidations")])
        dv.remove();
}

function fixDimension(root: OxmlElement, sheetData: OxmlElement): void {
    const dim = root.element("dimension");
    if (dim == null)
        return;

    const rowIdxs = [...sheetData.elements("row")]
        .map(r => rowIndexOf(r))
        .filter((n): n is number => n != null);
    if (rowIdxs.length === 0)
        return;

    const reference = dim.getAttribute("ref");
    const afterColon = reference != null && reference.includes(":") ? reference.slice(reference.indexOf(":") + 1) : undefined;
    const lastCol = afterColon != null ? columnLetters(afterColon) : "A";

    dim.setAttribute("ref", `A${Math.min(...rowIdxs)}:${lastCol}${Math.max(...rowIdxs)}`);
}

/** The calc chain caches Excel's evaluation ORDER; after rows move it is worse than useless. */
function removeCalcChain(package_: OxmlPackage): void {
    const calcChain = package_.parts.find(p => p.contentType.includes("calcChain"));
    if (calcChain != null)
        package_.deletePart(package_.mainPart, calcChain);
}

/** Every cached formula result was dropped, so tell Excel to recompute the whole workbook on open. */
function forceFullCalcOnLoad(package_: OxmlPackage): void {
    const workbook = worksheetRoot(package_.mainPart);
    if (workbook == null)
        return;

    let calcPr = workbook.element("calcPr");
    if (calcPr == null) {
        calcPr = new OxmlElement("calcPr");
        const sheets = workbook.element("sheets");
        if (sheets != null)
            workbook.insertAfter(calcPr, sheets);
        else
            workbook.appendChild(calcPr);
    }
    calcPr.setAttribute("fullCalcOnLoad", "1");
}

// ---- helpers -------------------------------------------------------------------------------------------

function setText(element: OxmlElement, text: string): void {
    element.removeAllChildren();
    element.appendChild(new OxmlText(text));
}

function rowOfCell(cell: OxmlElement): number {
    return rowDigits(cell.getAttribute("r") ?? "1");
}

function columnOfCell(cell: OxmlElement): number {
    return columnIndex(columnLetters(cell.getAttribute("r") ?? "A"));
}

/** The three prep passes, in the order the parser needs them (Signum's ParseDocument prologue). */
export function prepareSpreadsheet(package_: OxmlPackage): void {
    deshareFormulas(package_);
    inlineTokens(package_);
    inlineNoteTokens(package_);
}
