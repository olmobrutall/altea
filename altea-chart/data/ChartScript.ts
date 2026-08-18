import { reflect, init } from "@altea/altea/data/reflection";
import { entity } from "@altea/altea/data/decorators";
import { Symbol } from "@altea/altea/data/symbol";
import type { ChartScriptColumn } from "./ChartScriptColumn";
import type { ChartScriptParameter, ChartScriptParameterGroup } from "./ChartScriptParameter";

// Port of Signum.Chart/ChartScript.cs.

// Signum's `[EntityKind(SystemString, Master, IsLowPopulation = true)] class ChartScriptSymbol : Symbol`.
// The identity of a chart TYPE (Bars, Pie, …); its own SystemString symbol table (like OperationSymbol),
// seeded + read back by SymbolLogic. Instances are declared in the AutoInit groups below.
@reflect
@entity("SystemString", "Master")
export class ChartScriptSymbol extends Symbol {
}

// Signum's `[AutoInit] static class D3ChartScript`. The built-in D3 (SVG) chart types.
export namespace D3ChartScript {
    export const Bars: ChartScriptSymbol = init();
    export const Columns: ChartScriptSymbol = init();
    export const Line: ChartScriptSymbol = init();

    export const MultiBars: ChartScriptSymbol = init();
    export const MultiColumns: ChartScriptSymbol = init();
    export const MultiLines: ChartScriptSymbol = init();

    export const StackedBars: ChartScriptSymbol = init();
    export const StackedColumns: ChartScriptSymbol = init();
    export const StackedLines: ChartScriptSymbol = init();

    export const Pie: ChartScriptSymbol = init();
    export const BubblePack: ChartScriptSymbol = init();

    export const Scatterplot: ChartScriptSymbol = init();
    export const Bubbleplot: ChartScriptSymbol = init();

    export const ParallelCoordinates: ChartScriptSymbol = init();
    export const Punchcard: ChartScriptSymbol = init();
    export const CalendarStream: ChartScriptSymbol = init();
    export const Treemap: ChartScriptSymbol = init();
}

// Signum's `[AutoInit] static class HtmlChartScript`.
export namespace HtmlChartScript {
    export const PivotTable: ChartScriptSymbol = init();
}

// Signum's `[AutoInit] static class SvgMapsChartScript`.
export namespace SvgMapsChartScript {
    export const SvgMap: ChartScriptSymbol = init();
}

// Signum's `[AutoInit] static class GoogleMapsChartScript`.
export namespace GoogleMapsChartScript {
    export const Heatmap: ChartScriptSymbol = init();
    export const Markermap: ChartScriptSymbol = init();
}

// Signum's abstract ChartScript. A plain (non-reflected) DEFINITION object describing one chart type: its
// symbol, icon, column slots and parameter groups. Concrete subclasses live server-side (server/Scripts/*),
// are registered in ChartScriptLogic, and are shipped to the client as JSON via /api/chart/scripts.
//
// altea divergence: Signum's `FileContent Icon` (an embedded PNG resource) becomes a `string | null` icon
// (a data-URI / asset path) — the browser only needs a renderable src.
export abstract class ChartScript {
    symbol: ChartScriptSymbol;
    icon: string | null;
    columns: ChartScriptColumn[] = [];
    parameterGroups: ChartScriptParameterGroup[] = [];

    constructor(symbol: ChartScriptSymbol) {
        this.symbol = symbol;
    }

    allParameters(): ChartScriptParameter[] {
        return this.parameterGroups.flatMap(g => g.parameters);
    }
}
