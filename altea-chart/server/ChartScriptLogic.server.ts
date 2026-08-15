import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { ChartScriptSymbol } from "../data/ChartScript";
import type { ChartScript } from "../data/ChartScript";
import { setGetChartScriptFunc } from "../data/ChartRequest";
import { BarsChartScript } from "./Scripts/Bars";
import { ColumnsChartScript } from "./Scripts/Columns";
import { LineChartScript } from "./Scripts/Line";
import { MultiBarsChartScript } from "./Scripts/MultiBars";
import { MultiColumnsChartScript } from "./Scripts/MultiColumns";
import { MultiLinesChartScript } from "./Scripts/MultiLines";
import { StackedBarsChartScript } from "./Scripts/StackedBars";
import { StackedColumnsChartScript } from "./Scripts/StackedColumns";
import { StackedLinesChartScript } from "./Scripts/StackedLines";
import { PieChartScript } from "./Scripts/Pie";
import { ScatterplotChartScript } from "./Scripts/Scatterplot";
import { BubbleplotChartScript } from "./Scripts/Bubbleplot";
import { BubblePackChartScript } from "./Scripts/BubblePack";
import { TreeMapChartScript } from "./Scripts/TreeMap";
import { PunchcardChartScript } from "./Scripts/Punchcard";
import { ParallelCoordinatesChartScript } from "./Scripts/ParallelCoordinates";
import { CalendarStreamChartScript } from "./Scripts/CalendarStream";
import { PivotTableScript } from "./Scripts/PivotTable";
import { SvgMapScript } from "./Scripts/SvgMap";

// Port of Signum.Chart/ChartScriptLogic.cs. The in-process registry of chart-type definitions + the
// ChartScriptSymbol table seeding.
//
// altea divergences:
//  - Signum keys `Scripts` by the ChartScriptSymbol instance; altea keys by `symbol.key` (a deserialized
//    symbol reference from the client is a different instance with the same key).
//  - Signum seeds the symbol table from `() => Scripts.Keys`; altea's SymbolLogic assigns ids eagerly in
//    start() (before any RegisterScript runs) and seeds from all DECLARED symbols — so
//    `SymbolLogic.start(sb, ChartScriptSymbol)` seeds every D3/Html/Svg/GoogleMaps script symbol regardless
//    of which renderers are registered (harmless extra system-string rows for not-yet-ported charts).
//  - Icon resource embedding is deferred (loadIcon returns null); the chart-type picker just shows no icon.

export namespace ChartScriptLogic {

    // Signum's `Dictionary<ChartScriptSymbol, ChartScript> Scripts`, keyed by symbol.key.
    export const scripts = new Map<string, ChartScript>();

    export function start(sb: SchemaBuilder, svgMapUrls?: string[]): void {
        if (sb.alreadyDefined(start))
            return;

        SymbolLogic.start(sb, ChartScriptSymbol);

        // Signum's `ChartRequestModel.GetChartScriptFunc = s => Scripts.GetOrThrow(s)`.
        setGetChartScriptFunc(s => {
            const cs = scripts.get(s.key);
            if (cs == null)
                throw new Error(`No ChartScript registered for '${s.key}'`);
            return cs;
        });

        // Signum's RegisterScript(...) block. Only the ported renderers are registered for now (the rest of
        // the 20 built-ins follow as their D3Scripts/*.tsx are ported).
        registerScript(new BarsChartScript());
        registerScript(new ColumnsChartScript());
        registerScript(new LineChartScript());
        registerScript(new MultiBarsChartScript());
        registerScript(new MultiColumnsChartScript());
        registerScript(new MultiLinesChartScript());
        registerScript(new StackedBarsChartScript());
        registerScript(new StackedColumnsChartScript());
        registerScript(new StackedLinesChartScript());
        registerScript(new PieChartScript());
        registerScript(new ScatterplotChartScript());
        registerScript(new BubbleplotChartScript());
        registerScript(new BubblePackChartScript());
        registerScript(new TreeMapChartScript());
        registerScript(new PunchcardChartScript());
        registerScript(new ParallelCoordinatesChartScript());
        registerScript(new CalendarStreamChartScript());
        registerScript(new PivotTableScript());

        // Signum's `if (svgMapUrls != null) RegisterScript(new SvgMapScript(svgMapUrls))`. altea: register the
        // opt-in SvgMap chart only when the app supplies a non-empty URL list (EnumValueList.parse throws on
        // an empty "" join, and an SVG picker with no maps is useless).
        if (svgMapUrls != null && svgMapUrls.length > 0)
            registerScript(new SvgMapScript(svgMapUrls));
    }

    function registerScript(chartScript: ChartScript): void {
        scripts.set(chartScript.symbol.key, chartScript);
    }

    // Signum's LoadIcon (embedded PNG resource → FileContent). altea divergence: reads the PNG from
    // server/Icons/<fileName> (resolved relative to this module) and returns a data-URI string (the client
    // ChartScript.icon), so the chart-type buttons show the real icon. Returns null if the file is missing.
    export function loadIcon(fileName: string): string | null {
        try {
            const path = fileURLToPath(new URL("../../server/Icons/" + fileName, import.meta.url));
            return "data:image/png;base64," + readFileSync(path).toString("base64");
        } catch {
            return null;
        }
    }
}
