import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType,
    EnumValueList, Scala, NumberInterval, StringValue, SpecialParameter, SpecialParameterType,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/Punchcard.cs (see Bars.ts for the initializer note).
export class PunchcardChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.Punchcard);
        this.icon = ChartScriptLogic.loadIcon("punchcard.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.Size, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Color, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Opacity, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.InnerSize, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Order, ChartColumnType.AnyNumber, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.CompleteHorizontalValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 0),
                new ChartScriptParameter(ChartParameter.CompleteVerticalValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 1),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Size, [
                new ChartScriptParameter(ChartParameter.SizeScale, ChartParameterType.Scala, new Scala()),
                new ChartScriptParameter(ChartParameter.Shape, ChartParameterType.Enum, EnumValueList.parse("Circle|Rectangle|ProgressBar")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margin, [
                new ChartScriptParameter(ChartParameter.XMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 110 })),
                new ChartScriptParameter(ChartParameter.HorizontalLineColor, ChartParameterType.String, new StringValue("LightGray")),
                new ChartScriptParameter(ChartParameter.VerticalLineColor, ChartParameterType.String, new StringValue("LightGray")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Number, [
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
                new ChartScriptParameter(ChartParameter.NumberColor, ChartParameterType.String, new StringValue("white")),
            ]),
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.XSort, ChartParameterType.Enum, EnumValueList.parse("Ascending|AscendingKey|AscendingToStr|AscendingSumOrder|Descending|DescendingKey|DescendingToStr|DescendingSumOrder|None"), 0),
                new ChartScriptParameter(ChartParameter.YSort, ChartParameterType.Enum, EnumValueList.parse("Ascending|AscendingKey|AscendingToStr|AscendingSumOrder|Descending|DescendingKey|DescendingToStr|DescendingSumOrder|None"), 1),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Opacity, [
                new ChartScriptParameter(ChartParameter.FillOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.4 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.FillColor, [
                new ChartScriptParameter(ChartParameter.ColorScale, ChartParameterType.Scala, new Scala(), 3),
                new ChartScriptParameter(ChartParameter.ColorInterpolate, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorInterpolate), 3),
                new ChartScriptParameter(ChartParameter.FillColor, ChartParameterType.String, new StringValue("gray")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Stroke, [
                new ChartScriptParameter(ChartParameter.StrokeColor, ChartParameterType.String, new StringValue("gray")),
                new ChartScriptParameter(ChartParameter.StrokeWidth, ChartParameterType.Number, new NumberInterval({ defaultValue: 2 })),
            ]),
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.OpacityScale, ChartParameterType.Scala, new Scala(), 4),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.InnerSize, [
                new ChartScriptParameter(ChartParameter.InnerSizeType, ChartParameterType.Enum, EnumValueList.parse("Absolute|Relative|Independent"), 5),
                new ChartScriptParameter(ChartParameter.InnerFillColor, ChartParameterType.String, new StringValue("red"), 5),
            ]),
        ];
    }
}
