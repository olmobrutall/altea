import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType, SpecialParameterType,
    EnumValueList, Scala, NumberInterval, StringValue, SpecialParameter,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/MultiBars.cs (see Bars.ts for the initializer note).
export class MultiBarsChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.MultiBars);
        this.icon = ChartScriptLogic.loadIcon("multibars.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.SplitBars, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.Width, ChartColumnType.AnyNumberDateTime),
            new ChartScriptColumn(ChartColumnMessage.Width2, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Width3, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Width4, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Width5, ChartColumnType.AnyNumberDateTime, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.CompleteValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 0),
                new ChartScriptParameter(ChartParameter.Scale, ChartParameterType.Scala, new Scala({ minZeroMax: true }), 2),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margin, [
                new ChartScriptParameter(ChartParameter.LabelMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 140 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Number, [
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
                new ChartScriptParameter(ChartParameter.NumberColor, ChartParameterType.String, new StringValue("#fff")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Color, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory)),
            ]),
        ];
    }
}
