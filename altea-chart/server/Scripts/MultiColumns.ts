import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType, SpecialParameterType,
    EnumValueList, Scala, NumberInterval, StringValue, SpecialParameter,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/MultiColumns.cs (see Bars.ts for the initializer note).
export class MultiColumnsChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.MultiColumns);
        this.icon = ChartScriptLogic.loadIcon("multicolumns.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.SplitColumns, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.Height, ChartColumnType.AnyNumberDateTime),
            new ChartScriptColumn(ChartColumnMessage.Height2, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Height3, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Height4, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Height5, ChartColumnType.AnyNumberDateTime, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.CompleteValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 0),
                new ChartScriptParameter(ChartParameter.Scale, ChartParameterType.Scala, new Scala({ minZeroMax: true }), 2),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margin, [
                new ChartScriptParameter(ChartParameter.UnitMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 40 })),
                new ChartScriptParameter(ChartParameter.HorizontalMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 2 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Number, [
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
                new ChartScriptParameter(ChartParameter.NumberColor, ChartParameterType.String, new StringValue("#fff")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory)),
            ]),
        ];
    }
}
