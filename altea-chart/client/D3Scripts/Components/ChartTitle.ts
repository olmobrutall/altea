import type { ChartColumn, ChartRow } from "../../ChartClient";

// ONE tooltip builder for every chart script. NOT in Signum, where each script spells its own <title> out
// inline — which is exactly how dimensions went missing on the way over: Scatterplot never named either of
// its colour columns, Bubbleplot neither, TreeMap named neither its parent nor its colours, and
// Scatterplot's own SVG and canvas renderers had drifted two lines apart from each other.
//
// A script now lists every dimension it CAN have, in the order its editor shows them, and the ones the user
// left empty are undefined and drop out on their own. Adding a column to a chart script is then one entry
// here away from being readable on the shape, instead of something to remember.

/** A column to name in a tooltip, with the two overrides the scripts actually need. */
export interface TitlePart {
  column?: ChartColumn<any> | null;
  /** Printed instead of the row's value — a formatted date, a percentage, a folder's rolled-up total. With
   *  no `column` it is a whole line of its own. */
  value?: string;
  /** Print the value with no "Title: " label. Every bare part joins the FIRST line, comma-separated: it is
   *  what the hovered shape IS, while the labelled lines below are what it measures. */
  bare?: boolean;
}

/** A plain column is the common case — `{ column }` with the defaults. */
export type TitleArg = ChartColumn<any> | null | undefined | TitlePart;

/**
 * The <title> of one charted shape: the bare parts joined into a first line, then one `Title: Value` line
 * per remaining part.
 *
 * The FIRST part is bare unless it says otherwise, because every chart's first dimension is the thing the
 * shape stands for. `row` may be null only when every part carries its own `value` (a TreeMap folder is not
 * a row).
 */
export function chartTitle(row: ChartRow | null, parts: TitleArg[]): string {

  const resolved = parts
    .map<TitlePart>(p => p == null ? {} : isColumn(p) ? { column: p } : p)
    .filter(p => p.column != null || p.value != null)
    .map((p, i) => ({ ...p, bare: p.bare ?? (i == 0) }));

  const text = (p: TitlePart): string => p.value ?? p.column!.getValueNiceName(row!);

  const head = resolved.filter(p => p.bare).map(text).join(", ");

  return resolved.filter(p => !p.bare)
    .reduce((acc, p) => acc + (acc == "" ? "" : "\n") + (p.column ? p.column.title + ": " : "") + text(p), head);
}

function isColumn(p: TitlePart | ChartColumn<any>): p is ChartColumn<any> {
  // A ChartColumn always has these; a TitlePart has neither.
  return typeof (p as ChartColumn<any>).getValueNiceName == "function";
}
