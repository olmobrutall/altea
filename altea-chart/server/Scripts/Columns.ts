import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType, SpecialParameterType,
    EnumValueList, Scala, NumberInterval, StringValue, SpecialParameter,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/Columns.cs (see Bars.ts for the object-/collection-initializer note).
export class ColumnsChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.Columns);
        this.icon = ChartScriptLogic.loadIcon("columns.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.Columns, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.Height, ChartColumnType.AnyNumberDateTime),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.CompleteValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 0),
                new ChartScriptParameter(ChartParameter.Scale, ChartParameterType.Scala, new Scala({ minZeroMax: true }), 1),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margins, [
                new ChartScriptParameter(ChartParameter.UnitMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 40 })),
                new ChartScriptParameter(ChartParameter.Labels, ChartParameterType.Enum, EnumValueList.parse("Inside|InsideAll|Margin|MarginAll|None")),
                new ChartScriptParameter(ChartParameter.LabelsMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 100 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Number, [
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
                new ChartScriptParameter(ChartParameter.NumberColor, ChartParameterType.String, new StringValue("#fff")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Color, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory)),
                new ChartScriptParameter(ChartParameter.ForceColor, ChartParameterType.String, new StringValue("")),
            ]),
        ];
    }
}
