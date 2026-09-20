import * as React from "react";
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

/** A tooltip taken apart: the identity line, then one labelled measure per row. */
export interface ChartTitleParts {
  head: string;
  rows: { label: string, value: string }[];
}

/**
 * The tooltip of one charted shape, STRUCTURED: the bare parts joined into `head`, then one row per
 * remaining part.
 *
 * The FIRST part is bare unless it says otherwise, because every chart's first dimension is the thing the
 * shape stands for. `row` may be null only when every part carries its own `value` (a TreeMap folder is not
 * a row).
 */
export function chartTitleParts(row: ChartRow | null, parts: TitleArg[]): ChartTitleParts {

  const resolved = parts
    .map<TitlePart>(p => p == null ? {} : isColumn(p) ? { column: p } : p)
    .filter(p => p.column != null || p.value != null)
    .map((p, i) => ({ ...p, bare: p.bare ?? (i == 0) }));

  const text = (p: TitlePart): string => p.value ?? p.column!.getValueNiceName(row!);

  return {
    head: resolved.filter(p => p.bare).map(text).join(", "),
    rows: resolved.filter(p => !p.bare).map(p => ({ label: p.column?.title ?? "", value: text(p) })),
  };
}

/** The same tooltip as ONE string: `head`, then a `Label: Value` line per row. */
export function chartTitle(row: ChartRow | null, parts: TitleArg[]): string {
  return formatChartTitle(chartTitleParts(row, parts));
}

export function formatChartTitle(p: ChartTitleParts): string {
  return p.rows.reduce((acc, r) => acc + (acc == "" ? "" : "\n") + (r.label ? r.label + ": " : "") + r.value, p.head);
}

/**
 * `formatChartTitle` read back — the INVERSE, and the reason the two live in one file: ChartTooltip renders
 * the rows separately (a shadcn-style card), and the only thing it is handed by the DOM is the string. The
 * split is on the FIRST ": " of each line, so a value may contain one (a time, a ratio) and only a LABEL
 * containing one would confuse it — labels are token nice names, which do not.
 */
export function parseChartTitle(text: string): ChartTitleParts {
  const [head, ...lines] = text.split("\n");
  return {
    head: head ?? "",
    rows: lines.map(l => {
      const at = l.indexOf(": ");
      return at < 0 ? { label: "", value: l } : { label: l.slice(0, at), value: l.slice(at + 2) };
    }),
  };
}

/**
 * What a chart script puts inside a shape to give it a tooltip.
 *
 * A `<desc>`, deliberately NOT a `<title>`: a `<title>` child makes the BROWSER draw its own plain tooltip,
 * which would sit on top of ChartTooltip's card. `<desc>` renders nothing and is still the shape's
 * accessible description, and ChartTooltip finds the hovered shape by looking for exactly this child.
 */
export function ShapeTitle(p: { row: ChartRow | null, parts: TitleArg[] }): React.ReactElement {
  return <desc>{chartTitle(p.row, p.parts)}</desc>;
}

/** The same, for a shape whose text was built earlier — a pivot cell's `valueTitle`, a series name. */
export function ShapeTitleText(p: { text: string }): React.ReactElement {
  return <desc>{p.text}</desc>;
}

function isColumn(p: TitlePart | ChartColumn<any>): p is ChartColumn<any> {
  // A ChartColumn always has this; a TitlePart never does.
  return typeof (p as ChartColumn<any>).getValueNiceName == "function";
}
