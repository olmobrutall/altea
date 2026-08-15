import type { LocalizableMessage } from "@altea/altea/data/utils/localization";
import { ChartScript, HtmlChartScript } from "../../data/ChartScript";
import { ChartScriptColumn, ChartColumnType } from "../../data/ChartScriptColumn";
import {
    ChartScriptParameter, ChartScriptParameterGroup, ChartParameterType,
    EnumValueList, Scala, NumberInterval, StringValue,
    type IChartParameterValueDefinition,
} from "../../data/ChartScriptParameter";
import { ChartColumnMessage, ChartParameter } from "../../data/ChartMessage";
import { ChartScriptLogic } from "../ChartScriptLogic.server";

// Copy-and-fix of Signum.Chart/Scripts/PivotTable.cs (see Bars.ts for the initializer note). This is the
// first Html renderer (HtmlChartScript.PivotTable) — the client component lives in client/HtmlScripts.
//
// altea divergence: Signum's `new ChartScriptParameter(prefix, suffix, type)` overload — which sets
// Name = prefix+suffix and DisplayName = "prefix suffix" — does NOT exist on altea's ChartScriptParameter
// (its ctor takes ONE message and derives name = message.member). The `named()` helper below reproduces
// that compound naming locally: it builds the param from the suffix (column) message, then overrides
// `.name` to `<prefix><suffix>` and `.getDisplayName` to `"prefix suffix"`. This matches the parameter
// keys the client renderer reads (parameters["Complete" + "HorizontalAxis"], ["SubTotal" + "HorizontalAxis2"], …).
export class PivotTableScript extends ChartScript {
    constructor() {
        super(HtmlChartScript.PivotTable);
        this.icon = ChartScriptLogic.loadIcon("pivottable.png");
        this.columns = [
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis2, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis3, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.HorizontalAxis4, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis2, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis3, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.VerticalAxis4, ChartColumnType.AnyGroupKey, true),
            new ChartScriptColumn(ChartColumnMessage.Value, ChartColumnType.AnyNumber),
            new ChartScriptColumn(ChartColumnMessage.Value2, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Value3, ChartColumnType.AnyNumber, true),
            new ChartScriptColumn(ChartColumnMessage.Value4, ChartColumnType.AnyNumber, true),
        ];
        this.parameterGroups = [
            createBlock(ChartParameter.Complete, ChartParameterType.Enum, EnumValueList.parse("No|Yes|Consistent|FromFilters"), false),
            createBlock(ChartParameter.Order, ChartParameterType.Enum, EnumValueList.parse("None|Ascending|AscendingKey|AscendingToStr|AscendingSumValues|Descending|DescendingKey|DescendingToStr|DescendingSumValues"), false),
            createBlock(ChartParameter.Gradient, ChartParameterType.Enum, EnumValueList.parse("None|EntityPalette|YlGn|YlGnBu|GnBu|BuGn|PuBuGn|PuBu|BuPu|RdPu|PuRd|OrRd|YlOrRd|YlOrBr|Purples|Blues|Greens|Oranges|Reds|Greys|PuOr|BrBG|PRGn|PiYG|RdBu|RdGy|RdYlBu|Spectral|RdYlGn"), true),
            createBlock(ChartParameter.Scale, ChartParameterType.Scala, new Scala(), true),
            createBlock(ChartParameter.CSSStyle, ChartParameterType.String, new StringValue(""), true),
            createBlock(ChartParameter.CSSStyleDiv, ChartParameterType.String, new StringValue(""), true),
            createBlock(ChartParameter.MaxTextLength, ChartParameterType.Number, new NumberInterval({ defaultValue: 50 }), false),
            createBlock(ChartParameter.ShowCreateButton, ChartParameterType.Enum, EnumValueList.parse("No|Yes"), true),
            createBlock(ChartParameter.ShowAggregateValues, ChartParameterType.Enum, EnumValueList.parse("Yes|No"), true),
            new ChartScriptParameterGroup(null, [
                named(ChartParameter.SubTotal, ChartColumnMessage.HorizontalAxis2, ChartParameterType.Enum, EnumValueList.parse("no|yes"), 1),
                named(ChartParameter.SubTotal, ChartColumnMessage.HorizontalAxis3, ChartParameterType.Enum, EnumValueList.parse("no|yes"), 2),
                named(ChartParameter.SubTotal, ChartColumnMessage.HorizontalAxis4, ChartParameterType.Enum, EnumValueList.parse("no|yes"), 3),
                named(ChartParameter.Placeholder, ChartColumnMessage.VerticalAxis, ChartParameterType.Enum, EnumValueList.parse("no|empty|filled"), 4),
                named(ChartParameter.Placeholder, ChartColumnMessage.VerticalAxis2, ChartParameterType.Enum, EnumValueList.parse("no|empty|filled"), 5),
                named(ChartParameter.Placeholder, ChartColumnMessage.VerticalAxis3, ChartParameterType.Enum, EnumValueList.parse("no|empty|filled"), 6),
            ]),
            new ChartScriptParameterGroup(null, [
                new ChartScriptParameter(ChartParameter.MultiValueFormat, ChartParameterType.String, new StringValue(""), 8),
            ]),
        ];
    }
}

// Signum's static CreateBlock(prefix, type, valueDefinition, includeValues): one parameter per dimension
// slot (HorizontalAxis…VerticalAxis4, plus optionally Value), all sharing one value-definition instance.
const BLOCK_COLUMNS: [LocalizableMessage, number][] = [
    [ChartColumnMessage.HorizontalAxis, 0],
    [ChartColumnMessage.HorizontalAxis2, 1],
    [ChartColumnMessage.HorizontalAxis3, 2],
    [ChartColumnMessage.HorizontalAxis4, 3],
    [ChartColumnMessage.VerticalAxis, 4],
    [ChartColumnMessage.VerticalAxis2, 5],
    [ChartColumnMessage.VerticalAxis3, 6],
    [ChartColumnMessage.VerticalAxis4, 7],
];

function createBlock(prefix: LocalizableMessage, type: ChartParameterType, valueDefinition: IChartParameterValueDefinition, includeValues: boolean): ChartScriptParameterGroup {
    const params = BLOCK_COLUMNS.map(([suffix, index]) => named(prefix, suffix, type, valueDefinition, index));
    if (includeValues)
        params.push(named(prefix, ChartColumnMessage.Value, type, valueDefinition, 8));
    return new ChartScriptParameterGroup(null, params);
}

// Signum's `ChartScriptParameter(Enum prefix, Enum suffix, type)`: Name = prefix+suffix,
// DisplayName = "prefix suffix". altea has no such ctor, so build from the suffix and override.
function named(prefix: LocalizableMessage, suffix: LocalizableMessage, type: ChartParameterType, valueDefinition: IChartParameterValueDefinition, columnIndex: number): ChartScriptParameter {
    const p = new ChartScriptParameter(suffix, type, valueDefinition, columnIndex);
    p.name = (prefix.member ?? "") + (suffix.member ?? "");
    p.getDisplayName = () => prefix.niceToString() + " " + suffix.niceToString();
    return p;
}
