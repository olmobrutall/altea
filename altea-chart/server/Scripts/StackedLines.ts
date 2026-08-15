import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType, SpecialParameterType,
    EnumValueList, Scala, NumberInterval, StringValue, SpecialParameter,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/StackedLines.cs (see Bars.ts for the initializer note).
// Faithful divergence: Signum names the color group `ChartParameter.ColorCategory` (a ChartParameter, not a
// ChartParameterGroupMessage) — mirrored verbatim; both are localizable messages so it resolves the same.
export class StackedLinesChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.StackedLines);
        this.icon = ChartScriptLogic.loadIcon("stackedareas.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis, ChartColumnType.AllTypes),
            new ChartScriptColumn(ChartColumnMessage.Areas, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.Height, ChartColumnType.AnyNumber),
            new ChartScriptColumn(ChartColumnMessage.Height2, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Height3, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Height4, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Height5, ChartColumnType.AnyNumber, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.CompleteValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 0),
                new ChartScriptParameter(ChartParameter.HorizontalScale, ChartParameterType.Scala, new Scala({ bands: true }), 0),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margin, [
                new ChartScriptParameter(ChartParameter.HorizontalMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 20 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Number, [
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
                new ChartScriptParameter(ChartParameter.NumberColor, ChartParameterType.String, new StringValue("#fff")),
            ]),
            new ChartScriptParameterGroup(ChartParameter.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory)),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Shape, [
                new ChartScriptParameter(ChartParameter.Order, ChartParameterType.Enum, EnumValueList.parse("none|ascending|descending|insideOut|reverse")),
                new ChartScriptParameter(ChartParameter.Stack, ChartParameterType.Enum, EnumValueList.parse("zero|expand|wiggle|silhouette")),
                new ChartScriptParameter(ChartParameter.Interpolate, ChartParameterType.Enum, EnumValueList.parse("linear|step-before|step-after|cardinal|monotone|basis")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ShowPercent, [
                new ChartScriptParameter(ChartParameter.ValueAsPercent, ChartParameterType.Enum, EnumValueList.parse("No|Yes")),
            ]),
        ];
    }
}
