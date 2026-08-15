import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType, SpecialParameterType,
    EnumValueList, Scala, NumberInterval, StringValue, SpecialParameter,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/Bubbleplot.cs (see Bars.ts for the object-/collection-initializer note).
export class BubbleplotChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.Bubbleplot);
        this.icon = ChartScriptLogic.loadIcon("bubbles.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.Bubble, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis, ChartColumnType.AnyNumberDateTime),
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis, ChartColumnType.AnyNumberDateTime),
            new ChartScriptColumn(ChartColumnMessage.Size, ChartColumnType.AnyNumber),
            new ChartScriptColumn(ChartColumnMessage.ColorScale, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.ColorCategory, ChartColumnType.AnyGroupKey, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.HorizontalScale, ChartParameterType.Scala, new Scala(), 1),
                new ChartScriptParameter(ChartParameter.VerticalScale, ChartParameterType.Scala, new Scala(), 2),
                new ChartScriptParameter(ChartParameter.SizeScale, ChartParameterType.Scala, new Scala(), 3),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margin, [
                new ChartScriptParameter(ChartParameter.UnitMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 40 })),
                new ChartScriptParameter(ChartParameter.TopMargin, ChartParameterType.String, new StringValue("0.15*")),
                new ChartScriptParameter(ChartParameter.RightMargin, ChartParameterType.String, new StringValue("0.15*")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Label, [
                new ChartScriptParameter(ChartParameter.ShowLabel, ChartParameterType.Enum, EnumValueList.parse("Yes|No")),
                new ChartScriptParameter(ChartParameter.LabelColor, ChartParameterType.String, new StringValue("#fff")),
                new ChartScriptParameter(ChartParameter.FillOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.4 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorScale, [
                new ChartScriptParameter(ChartParameter.ColorScale, ChartParameterType.Scala, new Scala(), 4),
                new ChartScriptParameter(ChartParameter.ColorInterpolate, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorInterpolate), 4),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory), 5),
            ]),
        ];
    }
}
