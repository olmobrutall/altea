import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType, SpecialParameterType,
    EnumValueList, Scala, NumberInterval, StringValue, SpecialParameter,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/Bars.cs. The only reshaping vs Signum: object-initializers
// (`{ ColumnIndex = 0, ValueDefinition = ... }`) fold into constructor args, and collection-initializers
// become array arguments.
export class BarsChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.Bars);
        this.icon = ChartScriptLogic.loadIcon("bars.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.Bars, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.Width, ChartColumnType.AnyNumberDateTime),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.CompleteValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 0),
                new ChartScriptParameter(ChartParameter.Scale, ChartParameterType.Scala, new Scala({ minZeroMax: true }), 1),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margins, [
                new ChartScriptParameter(ChartParameter.Labels, ChartParameterType.Enum, EnumValueList.parse("Inside|InsideAll|Margin|MarginAll|None")),
                new ChartScriptParameter(ChartParameter.LabelsMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 100 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Numbers, [
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
                new ChartScriptParameter(ChartParameter.NumberColor, ChartParameterType.String, new StringValue("#fff")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory)),
            ]),
        ];
    }
}
