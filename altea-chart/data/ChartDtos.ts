import type { Lite } from "@altea/altea/data/lite";
import type { ChartColumnType } from "./ChartScriptColumn";
import type { ChartParameterType, SpecialParameterType } from "./ChartScriptParameter";
import type { ColorPaletteEntity } from "./ColorPalette";

// The module's WIRE DTOs — the shapes that cross /api/chart/* and /api/colorPalette/* but are not
// entities — declared once, for the routes and the client both.

export interface ChartScriptInfo {
    /** ChartScriptSymbol.key */
    symbol: string;
    /** A saved UserChart references the symbol, so the client must stamp the DB id onto its declared instance. */
    symbolId: number;
    icon: string | null;
    columns: ChartScriptColumnInfo[];
    parameterGroups: ChartScriptParameterGroupInfo[];
}

export interface ChartScriptColumnInfo {
    name: string;
    displayName: string;
    isOptional: boolean;
    columnType: ChartColumnType;
}

export interface ChartScriptParameterGroupInfo {
    name: string | null;
    parameters: ChartScriptParameterInfo[];
}

export interface ChartScriptParameterInfo {
    name: string;
    displayName: string;
    columnIndex: number | null;
    type: ChartParameterType;
    valueDefinition: NumberIntervalInfo | EnumValueListInfo | StringValueInfo | SpecialParameterInfo | ScalaInfo | null;
}

export interface NumberIntervalInfo {
    defaultValue: number | null;
    minValue: number | null;
    maxValue: number | null;
}

export interface SpecialParameterInfo {
    specialParameterType: SpecialParameterType;
}

export interface ScalaInfo {
    standardScalas: Record<string, ChartColumnType | null>;
    custom: boolean;
}

export interface EnumValueListInfo {
    values: string[];
}

export interface StringValueInfo {
    defaultValue: string;
}

export interface ColorPaletteInfo {
    lite: Lite<ColorPaletteEntity>;
    typeName: string;
    categoryName: string;
    seed: number;
    /** Keyed by the enum MEMBER NAME for an enum type, else by the entity id string. */
    specificColors: { [key: string]: string };
}
