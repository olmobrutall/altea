import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType, SpecialParameterType,
    EnumValueList, Scala, NumberInterval, SpecialParameter,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/Scatterplot.cs (see Bars.ts for the object-/collection-initializer note).
export class ScatterplotChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.Scatterplot);
        this.icon = ChartScriptLogic.loadIcon("points.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.Point, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis, ChartColumnType.AnyNumberDateTime),
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis, ChartColumnType.AnyNumberDateTime),
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis2, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis2, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.ColorScale, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.ColorCategory, ChartColumnType.AnyGroupKey, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.HorizontalScale, ChartParameterType.Scala, new Scala(), 1),
                new ChartScriptParameter(ChartParameter.VerticalScale, ChartParameterType.Scala, new Scala(), 2),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margin, [
                new ChartScriptParameter(ChartParameter.UnitMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 40 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Points, [
                new ChartScriptParameter(ChartParameter.PointSize, ChartParameterType.Number, new NumberInterval({ defaultValue: 4 })),
                new ChartScriptParameter(ChartParameter.DrawingMode, ChartParameterType.Enum, EnumValueList.parse("Svg|Canvas")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorScale, [
                new ChartScriptParameter(ChartParameter.ColorScale, ChartParameterType.Scala, new Scala(), 5),
                new ChartScriptParameter(ChartParameter.ColorInterpolate, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorInterpolate), 5),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory), 6),
            ]),
        ];
    }
}
