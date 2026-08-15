import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType,
    Scala, NumberInterval, StringValue, SpecialParameter, SpecialParameterType,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/TreeMap.cs (see Bars.ts for the initializer note).
export class TreeMapChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.Treemap);
        this.icon = ChartScriptLogic.loadIcon("treemap.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.Square, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.Size, ChartColumnType.AnyNumber),
            new ChartScriptColumn(ChartColumnMessage.Parent, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.ColorScale, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.ColorCategory, ChartColumnType.AnyGroupKey, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.Scale, ChartParameterType.Scala, new Scala(), 0),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Margin, [
                new ChartScriptParameter(ChartParameter.Padding, ChartParameterType.Number, new NumberInterval({ defaultValue: 4 })),
                new ChartScriptParameter(ChartParameter.Opacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.5 })),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Number, [
                new ChartScriptParameter(ChartParameter.NumberOpacity, ChartParameterType.Number, new NumberInterval({ defaultValue: 0.8 })),
                new ChartScriptParameter(ChartParameter.NumberColor, ChartParameterType.String, new StringValue("#fff")),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorScale, [
                new ChartScriptParameter(ChartParameter.ColorScale, ChartParameterType.Scala, new Scala(), 3),
                new ChartScriptParameter(ChartParameter.ColorInterpolate, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorInterpolate), 3),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.ColorCategory, [
                new ChartScriptParameter(ChartParameter.ColorCategory, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorCategory), 4),
            ]),
        ];
    }
}
