import type { LocalizableMessage } from "@altea/altea/data/utils/localization";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { ChartColumnType } from "./ChartScriptColumn";
import * as ChartUtils from "./ChartUtils";
import type { IChartBase } from "./ChartRequest";

// Port of Signum.Chart/ChartScriptParameter.cs. These are plain (non-reflected) DEFINITION objects: they
// describe what a chart type's tunable parameters are (name, kind, value constraints). The server builds
// them per ChartScript (server/Scripts/*) and ships them to the client as JSON via /api/chart/scripts, so
// the client sees them as plain objects — it discriminates the value-definitions STRUCTURALLY (as Signum's
// client does, by data-field shape), never by `instanceof`, and re-implements default/validate logic in
// the client layer (Signum's ChartClient defaultParameterValue / isValidParameterValue).
//
// altea divergence: Signum's interface method is `string DefaultValue(QueryToken?)`, but `NumberInterval`
// also has a `decimal? DefaultValue` FIELD (C# explicit interface impl disambiguates). TS can't share the
// name between a field and a method, so the interface method is renamed `getDefaultValue(token)`; the DATA
// field keeps the name `defaultValue` (the shape the client reads).

// Signum's ChartParameterType (InTypeScript enum). altea divergence: the wire value is the member NAME
// string. Exported as a merged const+type so the ported scripts keep writing `ChartParameterType.Enum`
// (→ "Enum") near-verbatim, while a field typed `ChartParameterType` still narrows to the string union.
export const ChartParameterType = {
    Enum: "Enum", Number: "Number", String: "String", Special: "Special", Scala: "Scala",
} as const;
export type ChartParameterType = typeof ChartParameterType[keyof typeof ChartParameterType];

// Signum's SpecialParameterType (InTypeScript enum).
export const SpecialParameterType = {
    ColorCategory: "ColorCategory", ColorInterpolate: "ColorInterpolate",
} as const;
export type SpecialParameterType = typeof SpecialParameterType[keyof typeof SpecialParameterType];

// Signum's IChartParameterValueDefinition — a parameter's value contract (its default + validation).
export interface IChartParameterValueDefinition {
    getDefaultValue(token: QueryToken | null): string;
    validate(parameter: string | null, token: QueryToken | null): string | null;
}

// Signum's NumberInterval (a decimal default within an optional [min, max]).
export class NumberInterval implements IChartParameterValueDefinition {
    defaultValue: number | null;
    minValue: number | null;
    maxValue: number | null;

    constructor(init?: Partial<Pick<NumberInterval, "defaultValue" | "minValue" | "maxValue">>) {
        Object.assign(this, init);
    }

    getDefaultValue(_token: QueryToken | null): string {
        return this.defaultValue?.toString() ?? "";
    }

    validate(parameter: string | null, _token: QueryToken | null): string | null {
        if (!parameter && this.defaultValue == null)
            return null;

        const value = Number(parameter);
        if (parameter == null || parameter.trim() === "" || Number.isNaN(value))
            return `${parameter} is not a valid number`;

        if (this.minValue != null && value < this.minValue)
            return `${value} is lesser than the minimum ${this.minValue}`;

        if (this.maxValue != null && this.maxValue < value)
            return `${value} is grater than the maximum ${this.maxValue}`;

        return null;
    }
}

// Signum's SpecialParameter (a ColorCategory / ColorInterpolate special editor).
export class SpecialParameter implements IChartParameterValueDefinition {
    constructor(readonly specialParameterType: SpecialParameterType) { }

    getDefaultValue(_token: QueryToken | null): string {
        return "";
    }
    validate(_parameter: string | null, _token: QueryToken | null): string | null {
        return null;
    }
}

// Signum's Scala (a set of standard scalas — Bands / ZeroMax / MinMax / … — plus optional custom min...max).
export class Scala implements IChartParameterValueDefinition {
    // Ordered map: scala name → the ChartColumnType it requires (null = no requirement).
    standardScalas: Map<string, ChartColumnType | null> = new Map();
    custom: boolean;

    constructor(opts?: {
        bands?: boolean; zeroMax?: boolean; minMax?: boolean; minZeroMax?: boolean;
        log?: boolean; sqrt?: boolean; custom?: boolean;
    }) {
        const { bands = false, zeroMax = true, minMax = true, minZeroMax = false, log = true, sqrt = true, custom = true } = opts ?? {};
        if (bands) this.standardScalas.set("Bands", ChartColumnType.AnyGroupKey);
        if (zeroMax) this.standardScalas.set("ZeroMax", ChartColumnType.AnyNumber);
        if (minMax) this.standardScalas.set("MinMax", null);
        if (minZeroMax) this.standardScalas.set("MinZeroMax", ChartColumnType.AnyNumber);
        if (log) this.standardScalas.set("Log", ChartColumnType.AnyNumber);
        if (sqrt) this.standardScalas.set("Sqrt", ChartColumnType.AnyNumber);
        this.custom = custom;
    }

    getDefaultValue(token: QueryToken | null): string {
        for (const [key, type] of this.standardScalas)
            if (type == null || token == null || ChartUtils.isChartColumnType(token, type))
                return key;
        return "";
    }

    validate(parameter: string | null, token: QueryToken | null): string | null {
        if (parameter == null)
            return null;

        if (this.standardScalas.has(parameter)) {
            const type = this.standardScalas.get(parameter)!;
            if (type == null || token == null || ChartUtils.isChartColumnType(token, type))
                return null;
            return `${parameter} is not compatible with ${token?.niceName()}`;
        }

        if (this.custom && parameter.includes("...")) {
            const minValue = parameter.substring(0, parameter.indexOf("..."));
            const maxValue = parameter.substring(parameter.indexOf("...") + 3);
            if (Number.isNaN(Number(minValue)))
                return `${minValue} is not a valid number`;
            if (Number.isNaN(Number(maxValue)))
                return `${maxValue} is not a valid number`;
            return null;
        }

        return this.custom
            ? `${parameter} is not in the list and is not a custom scala (min...max)`
            : `${parameter} is not in the list`;
    }
}

// Signum's EnumValueList (a `|`-separated list of allowed values). altea divergence: Signum's
// `class EnumValueList : List<string>` becomes a class holding `values: string[]`.
export class EnumValueList implements IChartParameterValueDefinition {
    values: string[];

    constructor(values: string[]) {
        this.values = values;
    }

    static parse(valueDefinition: string): EnumValueList {
        const values = valueDefinition.split("|").map(s => s.trim()).filter(s => s.length > 0);
        if (values.length === 0)
            throw new Error("No parameter values set");
        return new EnumValueList(values);
    }

    validate(parameter: string | null, token: QueryToken | null): string | null {
        if (token == null)
            return null; // ?
        return this.values.some(a => a === parameter) ? null : `${parameter} is not in the list`;
    }

    getDefaultValue(_token: QueryToken | null): string {
        if (this.values.length === 0)
            throw new Error("No default parameter value found");
        return this.values[0];
    }
}

// Signum's StringValue (a free string with a fixed default).
export class StringValue implements IChartParameterValueDefinition {
    constructor(readonly defaultValue: string) { }

    getDefaultValue(_token: QueryToken | null): string {
        return this.defaultValue;
    }
    validate(_parameter: string | null, _token: QueryToken | null): string | null {
        return null;
    }
}

// Signum's ChartScriptParameter — one tunable parameter of a chart type.
export class ChartScriptParameter {
    name: string;
    getDisplayName: () => string;
    columnIndex: number | null;
    type: ChartParameterType;
    valueDefinition: IChartParameterValueDefinition;

    // Signum's `ChartScriptParameter(Enum displayName, ChartParameterType type)` + object-initializer
    // `{ ColumnIndex, ValueDefinition }`. altea has no object-initializers, so ValueDefinition and the
    // optional ColumnIndex move into the constructor (the only reshaping the ported scripts need):
    //   Signum:  new ChartScriptParameter(ChartParameter.Scale, ChartParameterType.Scala) { ColumnIndex = 1, ValueDefinition = new Scala(...) }
    //   altea:   new ChartScriptParameter(ChartParameter.Scale, ChartParameterType.Scala, new Scala(...), 1)
    constructor(
        displayName: LocalizableMessage,
        type: ChartParameterType,
        valueDefinition: IChartParameterValueDefinition,
        columnIndex?: number | null,
    ) {
        this.name = displayName.member!;
        this.getDisplayName = () => displayName.niceToString();
        this.type = type;
        this.valueDefinition = valueDefinition;
        this.columnIndex = columnIndex ?? null;
    }

    get displayName(): string {
        return this.getDisplayName();
    }

    // Signum's GetToken — the query token the parameter is bound to (via ColumnIndex), if any.
    getToken(chartBase: IChartBase): QueryToken | null {
        if (this.columnIndex == null)
            return null;
        return chartBase.columns[this.columnIndex].token?.token ?? null;
    }

    validate(value: string | null, token: QueryToken | null): string | null {
        return this.valueDefinition.validate(value, token);
    }

    defaultValueFor(token: QueryToken | null): string {
        return this.valueDefinition.getDefaultValue(token);
    }
}

// Signum's ChartScriptParameterGroup — a display-named group of parameters. Serialized as {name, parameters}.
// Signum uses a collection-initializer (`new ChartScriptParameterGroup(msg) { p1, p2 }`); altea has none, so
// the parameters pass as a second constructor argument:
//   Signum:  new ChartScriptParameterGroup(ChartParameterGroupMessage.Margins) { new ChartScriptParameter(...), ... }
//   altea:   new ChartScriptParameterGroup(ChartParameterGroupMessage.Margins, [ new ChartScriptParameter(...), ... ])
// The no-name group `new ChartScriptParameterGroup()` becomes `new ChartScriptParameterGroup(null, [ ... ])`.
export class ChartScriptParameterGroup {
    getDisplayName: (() => string) | null;
    parameters: ChartScriptParameter[] = [];

    constructor(displayName?: LocalizableMessage | null, parameters?: ChartScriptParameter[]) {
        this.getDisplayName = displayName == null ? null : () => displayName.niceToString();
        if (parameters != null)
            this.parameters = parameters;
    }

    get displayName(): string | null {
        return this.getDisplayName?.() ?? null;
    }

    add(p: ChartScriptParameter): void {
        this.parameters.push(p);
    }

    // Signum's `IEnumerable<ChartScriptParameter>` — the group iterates its parameters (ChartScript.AllParameters).
    [Symbol.iterator](): Iterator<ChartScriptParameter> {
        return this.parameters[Symbol.iterator]();
    }
}
