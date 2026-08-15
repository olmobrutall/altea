import { ChartScript, SvgMapsChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType,
    EnumValueList, Scala, NumberInterval, StringValue, SpecialParameter, SpecialParameterType,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/SvgMap.cs (see Bars.ts for the initializer note). An opt-in chart
// (SvgMapsChartScript.SvgMap): the app registers it with a list of SVG map URLs it serves statically
// (ChartLogic.start's svgMapUrls); the renderer fetches the chosen SVG and colors its <path id> regions.
export class SvgMapScript extends ChartScript {
    constructor(svgMaps: string[]) {
        super(SvgMapsChartScript.SvgMap);
        this.icon = ChartScriptLogic.loadIcon("svgmap.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.LocationCode, ChartColumnType.String),
            new ChartScriptColumn(ChartColumnMessage.Location, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.ColorScale, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.ColorCategory, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.Opacity, ChartColumnType.AnyNumber, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Url, [
                new ChartScriptParameter(ChartParameter.SvgUrl, ChartParameterType.Enum, EnumValueList.parse(svgMaps.join("|"))),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Location, [
                new ChartScriptParameter(ChartParameter.LocationSelector, ChartParameterType.String, new StringValue("path[id]"), 0),
                new ChartScriptParameter(ChartParameter.LocationAttribute, ChartParameterType.String, new StringValue("id"), 0),
                new ChartScriptParameter(ChartParameter.LocationMatch, ChartParameterType.Enum, EnumValueList.parse("Exact|Prefix"), 0),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Stroke, [
                new ChartScriptParameter(ChartParameter.StrokeColor, ChartParameterType.String, new StringValue("")),
                new ChartScriptParameter(ChartParameter.StrokeWidth, ChartParameterType.String, new StringValue("")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Fill, [
                new ChartScriptParameter(ChartParameter.NoDataColor, ChartParameterType.String, new StringValue("#aaa")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorScale, [
                new ChartScriptParameter(ChartParameter.ColorScale, ChartParameterType.Scala, new Scala(), 2),
                new ChartScriptParameter(ChartParameter.ColorInterpolate, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorInterpolate), 2),
                new ChartScriptParameter(ChartParameter.ColorScaleMaxValue, ChartParameterType.Number, new NumberInterval({ defaultValue: null }), 2),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory), 3),
            ]),
        ];
    }
}
