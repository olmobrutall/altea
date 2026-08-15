import type { LocalizableMessage } from "@altea/altea/data/utils/localization";

// Port of Signum's ChartColumnType (Signum.Chart/ChartScriptColumn.cs). A [Flags] enum classifying the
// query-token types a chart column slot accepts. Runtime-only (a ScriptColumn facet, never a DB column),
// so a plain numeric flags enum — combined bitwise via `flag()` in ChartUtils — matching Signum's
// InTypeScript-generated enum. The composite members (AnyGroupKey/AnyNumber/…) are OR-combinations.
export enum ChartColumnType {
    Number = 1,
    DecimalNumber = 2,
    Date = 4,
    DateTime = 8,
    String = 16, // Guid
    Entity = 32,
    Enum = 64, // Boolean
    RoundedNumber = 128,
    Time = 256,

    AnyGroupKey = RoundedNumber | Number | Date | String | Entity | Enum,
    AnyNumber = Number | DecimalNumber | RoundedNumber,
    AnyNumberDateTime = Number | DecimalNumber | RoundedNumber | Date | DateTime | Time,
    AllTypes = Number | DecimalNumber | RoundedNumber | Date | DateTime | Time | String | Entity | Enum,
}

// Port of Signum's ChartScriptColumn (Signum.Chart/ChartScriptColumn.cs). Describes ONE column slot of a
// chart type: its name (identity), display name, whether it may be left empty, and the accepted column
// type(s). A plain (non-reflected) definition object — registered per ChartScript on the server and
// shipped to the client as JSON — not persisted.
//
// altea divergence: Signum's `Enum displayName` ctor arg becomes a `LocalizableMessage` (altea's msg()):
// its `.member` is the `Name` identity (Signum's `displayName.ToString()`), and `.niceToString()` is the
// display name (Signum's `displayName.NiceToString`).
export class ChartScriptColumn {
    name: string;
    getDisplayName: () => string;
    isOptional: boolean;
    columnType: ChartColumnType;

    // Signum's `new ChartScriptColumn(Enum displayName, ChartColumnType)` (+ optional `{ IsOptional = true }`
    // object-initializer). altea has no object-initializers, so IsOptional is an optional 3rd argument.
    constructor(displayName: LocalizableMessage, columnType: ChartColumnType, isOptional: boolean = false) {
        this.name = displayName.member!;
        this.getDisplayName = () => displayName.niceToString();
        this.columnType = columnType;
        this.isOptional = isOptional;
    }

    get displayName(): string {
        return this.getDisplayName();
    }
}
