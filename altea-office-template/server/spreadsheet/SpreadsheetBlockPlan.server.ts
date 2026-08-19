// Port of Signum.Word's Spreedsheet/SpreadsheetForeachBlock.cs — where every row MOVES once a row-level
// `@foreach` has been expanded.
//
// The problem this solves: a worksheet template looks like
//
//     row 4   @foreach[Entity.Details.Element] as $e     <- marker row, disappears
//     row 5   @[$e.Product]  @[$e.Quantity]              <- body row, cloned once per element
//     row 6   @endforeach                                <- marker row, disappears
//     row 7   =SUM(B5:B5)                                <- must become =SUM(B5:B<last>)
//
// After the generic renderer clones row 5 N times, the sheet has N body rows where 3 rows used to be.
// Every `r` attribute, every cell reference and every formula that mentioned rows 4-7 is now wrong. This
// class works out the whole mapping ONCE, so the finalizer can apply it without re-deriving it per cell.
//
// The two mappings it produces are different on purpose:
//   • rows()      — the NEW number of each rendered row element (clones get consecutive numbers)
//   • mapRow()    — where an ORIGINAL row number lands when it appears inside a formula. The marker rows
//                   are the interesting case: `@foreach`'s row maps to the FIRST data row and
//                   `@endforeach`'s to the LAST, which is exactly what makes `=SUM(B5:B5)` on the template
//                   grow into `=SUM(B5:B12)` over the expanded block.

import type { OxmlElement } from "../oxml/OxmlElement.server";

/**
 * A row-level `@foreach` captured while PARSING a spreadsheet, tied to the worksheet it lives in.
 * Recorded before the generic engine collapses the block (see OfficeTemplateParser).
 */
export interface SpreadsheetForeachBlock {
    readonly worksheet: OxmlElement;
    /** The original row number of the `@foreach` marker. */
    readonly firstRow: number;
    /** The original row number of the `@endforeach` marker. */
    readonly lastRow: number;
}

interface Plan {
    /** Original `@foreach` marker row. */
    rf: number;
    /** Original `@endforeach` marker row. */
    re: number;
    /** First rendered data row. */
    f: number;
    /** Last rendered data row. */
    l: number;
    /** Net row-count change this block introduces below itself. */
    contribution: number;
}

export class SpreadsheetBlockPlan {
    private constructor(
        private readonly plans: Plan[],
        /** New number + in-block flag for each rendered row element. */
        readonly rows: Map<OxmlElement, { newRow: number; inBlock: boolean }>,
    ) { }

    /**
     * @param rows   every `<row>` element of the sheet, in document order, AFTER rendering
     * @param blocks the `@foreach` blocks captured for this sheet during parsing
     */
    static compute(rows: OxmlElement[], blocks: SpreadsheetForeachBlock[]): SpreadsheetBlockPlan {
        const plans: Plan[] = [];
        let cumulative = 0;

        for (const b of [...blocks].sort((x, y) => x.firstRow - y.firstRow)) {
            // How many rows the block actually produced: every rendered row strictly between the markers.
            const produced = rows.filter(r => {
                const ri = rowIndexOf(r);
                return ri != null && b.firstRow < ri && ri < b.lastRow;
            }).length;

            const f = b.firstRow + cumulative;
            const plan: Plan = {
                rf: b.firstRow,
                re: b.lastRow,
                f,
                l: f + produced - 1,
                // The block occupied (lastRow - firstRow + 1) rows in the template, including both markers.
                contribution: produced - (b.lastRow - b.firstRow + 1),
            };
            cumulative += plan.contribution;
            plans.push(plan);
        }

        const map = new Map<OxmlElement, { newRow: number; inBlock: boolean }>();
        // The next data-row number to hand out, per block — this is what gives clones consecutive numbers.
        const counters = new Map<Plan, number>(plans.map(p => [p, p.f]));

        for (const row of rows) {
            const r0 = rowIndexOf(row);
            if (r0 == null)
                continue;

            const block = plans.find(p => p.rf < r0 && r0 < p.re);

            let newRow: number;
            if (block != null) {
                newRow = counters.get(block)!;      // C#'s `counters[block]++` — take, then advance
                counters.set(block, newRow + 1);
            } else {
                newRow = mapRowCore(plans, r0);
            }

            map.set(row, { newRow, inBlock: block != null });
        }

        return new SpreadsheetBlockPlan(plans, map);
    }

    /** Where an ORIGINAL row number lands after every block expansion (used for formula references). */
    mapRow(originalRow: number): number {
        return mapRowCore(this.plans, originalRow);
    }

    /** True for a `@foreach` / `@endforeach` marker row — those rows no longer exist. */
    isMarkerRow(row: number): boolean {
        return this.plans.some(p => p.rf === row || p.re === row);
    }
}

function mapRowCore(plans: Plan[], rho: number): number {
    for (const b of plans) {
        if (rho === b.rf) return b.f;              // the @foreach anchor -> the FIRST data row
        if (rho === b.re) return b.l;              // the @endforeach anchor -> the LAST data row
        if (b.rf < rho && rho < b.re) return b.f;  // an interior body row
    }

    // Below every block it passed: shift by the net change each contributed.
    let d = 0;
    for (const b of plans)
        if (b.re < rho)
            d += b.contribution;
    return rho + d;
}

/** The `r` attribute of a `<row>`, as a number. */
export function rowIndexOf(row: OxmlElement): number | undefined {
    const r = row.getAttribute("r");
    if (r == null)
        return undefined;
    const n = parseInt(r, 10);
    return Number.isNaN(n) ? undefined : n;
}
