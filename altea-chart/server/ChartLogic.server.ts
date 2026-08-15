import type { SchemaBuilder } from "@altea/altea/server/schema/schemaBuilder";
import { ChartScriptLogic } from "./ChartScriptLogic.server";
import { ChartServer } from "./ChartServer.server";
import "../data/ChartPermissions"; // evaluate the module so ChartPermission.ViewCharting registers (auto-seeded)

// Port of Signum.Chart/ChartLogic.cs (Start). Registers the ChartScript catalog + symbol table and, when a
// web host is present, the HTTP surface.
//
// altea divergences (MVP):
//  - Signum calls `QueryLogic.Start(sb)` + `PermissionLogic.RegisterTypes(typeof(ChartPermission))`. altea
//    starts QueryLogic from the app starter, and a declared PermissionSymbol (ChartPermission.ViewCharting)
//    is auto-seeded by AuthLogic's PermissionSymbol SymbolLogic once its module is evaluated (the import
//    above), so neither call is needed here.
//  - ColorPaletteLogic, UserChartLogic, and the two Omnibox generators are deferred (later tasks).
//  - Signum's ExecuteChart / ToQueryRequest are not ported here: chart execution is client-side (the client
//    builds the QueryRequest and calls the generic query API).

export namespace ChartLogic {
    // Signum's ChartLogic.Start(sb, googleMapsChartScripts, svgMapUrls?). altea skips googleMaps; svgMapUrls
    // (when provided and non-empty) registers the opt-in SvgMap chart with that list of served SVG map URLs.
    export function start(sb: SchemaBuilder, svgMapUrls?: string[]): void {
        if (sb.alreadyDefined(start))
            return;

        ChartScriptLogic.start(sb, svgMapUrls);

        if (sb.webBuilder)
            ChartServer.start(sb.webBuilder);
    }
}
