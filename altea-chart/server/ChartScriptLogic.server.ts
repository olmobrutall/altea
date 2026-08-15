import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { ChartScriptSymbol } from "../data/ChartScript";
import type { ChartScript } from "../data/ChartScript";
import { setGetChartScriptFunc } from "../data/ChartRequest";
import { BarsChartScript } from "./Scripts/Bars";
import { ColumnsChartScript } from "./Scripts/Columns";

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

    export function start(sb: SchemaBuilder): void {
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
    }

    function registerScript(chartScript: ChartScript): void {
        scripts.set(chartScript.symbol.key, chartScript);
    }

    // Signum's LoadIcon (embedded PNG resource). altea divergence: resource embedding is deferred — the
    // scripts keep their `loadIcon("bars.png")` call site (near-verbatim) but no icon is loaded yet.
    export function loadIcon(_fileName: string): string | null {
        return null;
    }
}
