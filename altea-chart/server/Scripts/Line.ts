import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType,
    EnumValueList, Scala, NumberInterval, StringValue,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/Line.cs (see Bars.ts for the object-/collection-initializer note).
export class LineChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.Line);
        this.icon = ChartScriptLogic.loadIcon("lines.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis, ChartColumnType.AllTypes),
            new ChartScriptColumn(ChartColumnMessage.Height, ChartColumnType.AnyNumberDateTime),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.CompleteValues, ChartParameterType.Enum, EnumValueList.parse("Auto|Yes|No|FromFilters"), 0),
                new ChartScriptParameter(ChartParameter.HorizontalScale, ChartParameterType.Scala, new Scala({ bands: true }), 0),
                new ChartScriptParameter(ChartParameter.VerticalScale, ChartParameterType.Scala, new Scala(), 1),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margins, [
                new ChartScriptParameter(ChartParameter.UnitMargin, ChartParameterType.Number, new NumberInterval({ defaultValue: 40 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Number, [
                new ChartScriptParameter(ChartParameter.NumberMinWidth, ChartParameterType.Number, new NumberInterval({ defaultValue: 20 })),
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Circle, [
                new ChartScriptParameter(ChartParameter.CircleAutoReduce, ChartParameterType.Enum, EnumValueList.parse("Yes|No")),
                new ChartScriptParameter(ChartParameter.CircleRadius, ChartParameterType.Number, new NumberInterval({ defaultValue: 5 })),
                new ChartScriptParameter(ChartParameter.CircleStroke, ChartParameterType.Number, new NumberInterval({ defaultValue: 2 })),
                new ChartScriptParameter(ChartParameter.CircleRadiusHover, ChartParameterType.Number, new NumberInterval({ defaultValue: 15 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Color, [
                new ChartScriptParameter(ChartParameter.Color, ChartParameterType.String, new StringValue("steelblue")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Shape, [
                new ChartScriptParameter(ChartParameter.Interpolate, ChartParameterType.Enum, EnumValueList.parse("linear|step-before|step-after|cardinal|monotone|basis|bundle|catmull-rom")),
            ]),
        ];
    }
}
