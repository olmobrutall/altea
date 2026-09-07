import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { declaredSymbolsForType } from "@altea/altea/data/reflection";
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
//  - the symbol table is seeded from the REGISTERED scripts, as Signum does (`() => Scripts.Keys`): a
//    chart script IS its renderer, and a symbol with none is not a chart this application offers. The
//    thunk is evaluated LATE (when the table is seeded), so it sees every `registerScript` below whatever
//    the order — which is what SymbolLogic's declared-symbol default was reaching for. Seeding from
//    DECLARED symbols instead gave rows to the two GoogleMaps scripts nothing renders, which a Southwind
//    database (started `googleMapsChartScripts: false`) does not have.
//  - Icon resource embedding is deferred (loadIcon returns null); the chart-type picker just shows no icon.

export namespace ChartScriptLogic {

    // Signum's `Dictionary<ChartScriptSymbol, ChartScript> Scripts`, keyed by symbol.key.
    export const scripts = new Map<string, ChartScript>();

    export function start(sb: SchemaBuilder, svgMapUrls?: string[]): void {
        if (sb.alreadyDefined(start))
            return;

        SymbolLogic.start(sb, ChartScriptSymbol,
            () => (declaredSymbolsForType(ChartScriptSymbol) as ChartScriptSymbol[]).filter(s => scripts.has(s.key)));

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
