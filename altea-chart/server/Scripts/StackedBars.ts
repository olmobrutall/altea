import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType, SpecialParameterType,
    EnumValueList, NumberInterval, StringValue, SpecialParameter,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/StackedBars.cs (see Bars.ts for the initializer note).
export class StackedBarsChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.StackedBars);
        this.icon = ChartScriptLogic.loadIcon("stackedbars.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.SplitBars, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.Width, ChartColumnType.AnyNumber),
            new ChartScriptColumn(ChartColumnMessage.Width2, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Width3, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Width4, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Width5, ChartColumnType.AnyNumber, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Scale, [
                new ChartScriptParameter(ChartParameter.CompleteValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 0),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margin, [
                new ChartScriptParameter(ChartParameter.Labels, ChartParameterType.Enum, EnumValueList.parse("Margin|Inside|None")),
                new ChartScriptParameter(ChartParameter.LabelsMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 100 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Number, [
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
                new ChartScriptParameter(ChartParameter.NumberColor, ChartParameterType.String, new StringValue("#fff")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory)),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Shape, [
                new ChartScriptParameter(ChartParameter.Stack, ChartParameterType.Enum, EnumValueList.parse("zero|expand|wiggle|silhouette")),
                new ChartScriptParameter(ChartParameter.Order, ChartParameterType.Enum, EnumValueList.parse("none|ascending|descending|insideOut|reverse")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ShowPercent, [
                new ChartScriptParameter(ChartParameter.ValueAsPercent, ChartParameterType.Enum, EnumValueList.parse("No|Yes")),
            ]),
        ];
    }
}
