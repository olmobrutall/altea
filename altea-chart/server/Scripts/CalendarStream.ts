import { ChartScript, D3ChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType,
    EnumValueList, Scala, SpecialParameter, SpecialParameterType,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/CalendarStream.cs (see Bars.ts for the initializer note).
export class CalendarStreamChartScript extends ChartScript {
    constructor() {
        super(D3ChartScript.CalendarStream);
        this.icon = ChartScriptLogic.loadIcon("calendar.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.Date, ChartColumnType.Date),
            new ChartScriptColumn(ChartColumnMessage.ColorScale, ChartColumnType.AnyNumber),
        ];
        this.parameterGroups = [
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.StartDate, ChartParameterType.Enum, EnumValueList.parse("Monday|Sunday"), 0),
                new ChartScriptParameter(ChartParameter.ColorScale, ChartParameterType.Scala, new Scala(), 1),
                new ChartScriptParameter(ChartParameter.ColorInterpolate, ChartParameterType.Special, new SpecialParameter(SpecialParameterType.ColorInterpolate), 1),
            ]),
        ];
    }
}
