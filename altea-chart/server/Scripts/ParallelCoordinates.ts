import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType,
    EnumValueList, Scala, SpecialParameter, SpecialParameterType,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter, ChartParameterGroupMessage } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/ParallelCordiantes.cs (Signum misspelled the source file; the
// altea file/class are correctly spelled "ParallelCoordinates"). See Bars.ts for the initializer note.
export class ParallelCoordinatesChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.ParallelCoordinates);
        this.icon = ChartScriptLogic.loadIcon("parallelcoordinates.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.Line, ChartColumnType.AnyGroupKey),
            new ChartScriptColumn(ChartColumnMessage.Dimension1, ChartColumnType.AnyNumberDateTime),
            new ChartScriptColumn(ChartColumnMessage.Dimension2, ChartColumnType.AnyNumberDateTime),
            new ChartScriptColumn(ChartColumnMessage.Dimension3, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Dimension4, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Dimension5, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Dimension6, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Dimension7, ChartColumnType.AnyNumberDateTime, true),
            new ChartScriptColumn(ChartColumnMessage.Dimension8, ChartColumnType.AnyNumberDateTime, true),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.Scale1, ChartParameterType.Scala, new Scala(), 1),
                new ChartScriptParameter(ChartParameter.Scale2, ChartParameterType.Scala, new Scala(), 2),
                new ChartScriptParameter(ChartParameter.Scale3, ChartParameterType.Scala, new Scala(), 3),
                new ChartScriptParameter(ChartParameter.Scale4, ChartParameterType.Scala, new Scala(), 4),
                new ChartScriptParameter(ChartParameter.Scale5, ChartParameterType.Scala, new Scala(), 5),
                new ChartScriptParameter(ChartParameter.Scale6, ChartParameterType.Scala, new Scala(), 6),
                new ChartScriptParameter(ChartParameter.Scale7, ChartParameterType.Scala, new Scala(), 7),
                new ChartScriptParameter(ChartParameter.Scale8, ChartParameterType.Scala, new Scala(), 8),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Color, [
                new ChartScriptParameter(ChartParameter.ColorInterpolate, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorInterpolate)),
            ]),
            new ChartScriptParameterGroup(ChartParameterGroupMessage.Shape, [
                new ChartScriptParameter(ChartParameter.Interpolate, ChartParameterType.Enum, EnumValueList.parse("linear|step-before|step-after|cardinal|monotone|basis|bundle")),
            ]),
        ];
    }
}
