import type * as React from 'react'
import * as d3 from 'd3'
import type { ChartTable, ChartRow } from '../ChartClient';
import type { Rule } from './Components/Rule';
import type { MemoRepository } from './Components/ReactChart';

// Partial port of Signum.Chart/D3Scripts/Line.tsx. For now this file holds only the shared
// ChartScriptHorizontalProps interface (Signum declares it here) that the horizontal-axis renderers
// (Columns / Bars / Stacked*) share. The Line renderer body (paintLine + default export) ports with the
// Line chart itself.
export interface ChartScriptHorizontalProps {
  xRule: Rule<"content">;
  yRule: Rule<"content" | "labels">;
  hasHorizontalScale: boolean;
  x: d3.ScaleBand<string> | d3.ScaleContinuousNumeric<number, number>;
  y: d3.ScaleContinuousNumeric<number, number>;
  keyValues: unknown[];
  data: ChartTable;
  parameters: { [name: string]: string },
  onDrillDown: (row: ChartRow, e: React.MouseEvent<any> | MouseEvent) => void;
  initialLoad: boolean;
  memo: MemoRepository;
  detector?: (row: ChartRow) => boolean;
}
