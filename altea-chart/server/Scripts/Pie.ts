import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType,
    EnumValueList, NumberInterval, SpecialParameter, SpecialParameterType,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/Pie.cs (see Bars.ts for the initializer note).
export class PieChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.Pie);
        this.icon = ChartScriptLogic.loadIcon("doughnut.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.Sections, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.Angle, ChartColumnType.AnyNumber),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Shape, [
                new ChartScriptParameter(ChartParameter.InnerRadious, ChartParameterType.Number, new NumberInterval({ defaultValue: 0 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Arrange, [
                new ChartScriptParameter(ChartParameter.Sort, ChartParameterType.Enum, EnumValueList.parse("No|Ascending|Descending")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory)),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ShowValue, [
                new ChartScriptParameter(ChartParameter.Value, ChartParameterType.Enum, EnumValueList.parse("No|OnLabel|OnArc")),
                new ChartScriptParameter(ChartParameter.Percent, ChartParameterType.Enum, EnumValueList.parse("No|OnLabel|OnArc")),
                new ChartScriptParameter(ChartParameter.Total, ChartParameterType.Enum, EnumValueList.parse("No|Yes")),
            ]),
        ];
    }
}
