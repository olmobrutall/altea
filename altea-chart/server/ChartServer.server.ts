import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { ChartPermission } from "../data/ChartPermissions";
import type { ChartScript } from "../data/ChartScript";
import type { ChartScriptColumn } from "../data/ChartScriptColumn";
import type { ChartScriptParameter, IChartParameterValueDefinition } from "../data/ChartScriptParameter";
import {
    NumberInterval, EnumValueList, StringValue, SpecialParameter, Scala,
} from "../data/ChartScriptParameter";
import { ChartScriptLogic } from "./ChartScriptLogic.server";

// Port of the web surface of Signum.Chart/ChartServer.cs + ChartController.cs. The single endpoint the
// client needs at boot: GET /api/chart/scripts → the whole chart-script catalog as JSON.
//
// altea divergences (MVP):
//  - Chart execution is CLIENT-side (the client builds a QueryRequest from the ChartRequestModel and calls
//    the generic query API), so there is no chart-execute endpoint and no ChartRequestModel
//    AfterDeserialization hook (the server never deserializes a ChartRequestModel).
//  - Signum's CustomizeChartRequest (queryName↔queryKey, filters↔FilterTS JSON converters) is unneeded:
//    altea's ChartRequestModel carries `queryKey` as a plain isomorphic field and its filters live in the
//    client's FindOptions, not on the model.
//  - UserChart / EntityPack `userCharts` extension is deferred with UserChart (task #5).

// ---- Wire DTOs (the shape shipped to the client; ChartClient mirrors these) -----------------------------

export interface ChartScriptColumnTS {
    name: string;
    displayName: string;
    isOptional: boolean;
    columnType: number; // ChartColumnType flags value
}

export interface ChartScriptParameterTS {
    name: string;
    displayName: string;
    columnIndex: number | null;
    type: string; // ChartParameterType
    valueDefinition: unknown;
}

export interface ChartScriptParameterGroupTS {
    name: string | null;
    parameters: ChartScriptParameterTS[];
}

export interface ChartScriptTS {
    symbol: string; // ChartScriptSymbol.key
    symbolId: number; // ChartScriptSymbol.id — see chartScriptTS below (a saved UserChart references it)
    icon: string | null;
    columns: ChartScriptColumnTS[];
    parameterGroups: ChartScriptParameterGroupTS[];
}

function valueDefinitionTS(vd: IChartParameterValueDefinition): unknown {
    if (vd instanceof NumberInterval) return { defaultValue: vd.defaultValue, minValue: vd.minValue, maxValue: vd.maxValue };
    if (vd instanceof EnumValueList) return { values: vd.values };
    if (vd instanceof StringValue) return { defaultValue: vd.defaultValue };
    if (vd instanceof SpecialParameter) return { specialParameterType: vd.specialParameterType };
    // standardScalas as a { name → ChartColumnType|null } map (the client's Scala.standardScalas shape;
    // the ChartColumnType requirement per scala drives isValidParameterValue / defaultParameterValue).
    if (vd instanceof Scala) return { standardScalas: Object.fromEntries(vd.standardScalas), custom: vd.custom };
    return null;
}

function columnTS(c: ChartScriptColumn): ChartScriptColumnTS {
    return { name: c.name, displayName: c.getDisplayName(), isOptional: c.isOptional, columnType: c.columnType };
}

function parameterTS(p: ChartScriptParameter): ChartScriptParameterTS {
    return {
        name: p.name,
        displayName: p.getDisplayName(),
        columnIndex: p.columnIndex,
        type: p.type,
        valueDefinition: valueDefinitionTS(p.valueDefinition),
    };
}

function chartScriptTS(cs: ChartScript): ChartScriptTS {
    return {
        symbol: cs.symbol.key,
        // The symbol's DB id travels with it: the client resolves the wire key back to its declared
        // ChartScriptSymbol instance, and that instance is what a saved UserChart REFERENCES. Without the id
        // the reference looks new and the save tries to INSERT the symbol row again (duplicate key on
        // `key`). Mirrors what SymbolLogic does server-side — stamp the id onto the shared init() instance.
        symbolId: cs.symbol.id as number,
        icon: cs.icon,
        columns: cs.columns.map(columnTS),
        parameterGroups: cs.parameterGroups.map(g => ({
            name: g.getDisplayName?.() ?? null,
            parameters: g.parameters.map(parameterTS),
        })),
    };
}

export namespace ChartServer {
    export function start(ws: WebBuilder): void {
        // Signum's ChartController.ChartScripts — the whole catalog. Assert ViewCharting (charting is gated).
        ws.get("/api/chart/scripts",
            { res: CustomType<ChartScriptTS[]>() },
            async (_req, res) => {
                if (!(await PermissionAuthLogic.isAuthorized(ChartPermission.ViewCharting)))
                    throw new UnauthorizedAccessException(`Not authorized for '${ChartPermission.ViewCharting.key}'`);

                res.json([...ChartScriptLogic.scripts.values()].map(chartScriptTS));
            });
    }
}
