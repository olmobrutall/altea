import { ChartScriptLogic } from "@altea/altea-chart/server/ChartScriptLogic.server";
import { isChartColumnType } from "@altea/altea-chart/data/ChartUtils";
import type { ChartColumnType } from "@altea/altea-chart/data/ChartScriptColumn";
import { SkillCode, Schema as S } from "../SkillCode";
import { CurrentServerContextSkill } from "./CurrentServerContextSkill";
import {
    encodeFilters, encodeOrders, parseToken, resolveQueryName, toQueryString,
    type FilterOption, type OrderOption,
} from "./FindOptions";

// Port of Signum.Agent's Skills/ChartSkill.cs — the same FindOptions ideas, aimed at a `/chart/...` URL.
//
// altea divergences:
//  - `ChartOptions` arrives as a typed argument object rather than Signum's JSON STRING that the tool then
//    deserializes by hand: altea's tool schemas are declared, so the shape can simply be declared too.
//  - the URL encoding matches altea's OWN `ChartClient.Encoder` (altea-chart/client/ChartClient.tsx), not
//    Signum's — the column format carries the same `orderByIndex + A|D + ~` prefix, but the tilde escape is
//    altea's `#|#`. A URL handed to the user has to be one THIS client can parse back.
//  - `ChartScriptLogic.Scripts` is keyed by the script symbol's key; the model uses the part AFTER the dot,
//    exactly as Signum does (`s.Key.Key.After(".")`).
//  - `McpException` has no counterpart; a validation failure is a plain Error, which the loop turns into a
//    tool-error message the model can correct from (see ChatbotLogic.formatToolError).
export class ChartSkill extends SkillCode {

    constructor() {
        super();

        this.shortDescription = "Expands the Search skill with charting capabilities";
        this.isAllowed = () => true;

        this.registerTool({
            name: "GetChartScripts",
            description: "Gets the available Chart Scripts",
            returnType: "Dictionary<string, SimpleChartScript>",
            parameters: S.args({}),
            invoke: async () => Object.fromEntries([...ChartScriptLogic.scripts.values()].map(s => {
                const key = shortKey(s.symbol.key);
                return [key, {
                    key,
                    columns: s.columns.map(c => ({
                        name: c.name,
                        displayName: c.displayName,
                        isOptional: c.isOptional,
                        columnType: c.columnType,
                    })),
                }];
            })),
        });

        this.registerTool({
            name: "GetChartUrl",
            description: "Convert ChartOptions to a url",
            returnType: "string",
            parameters: S.args({ chartOptions: chartOptionsSchema() }),
            invoke: async args => {
                const co = args["chartOptions"] as ChartOptions;
                const error = validateChartOptions(co);
                if (error != null)
                    throw new Error(error);
                return (CurrentServerContextSkill.urlLeft?.() ?? "") + chartOptionsPath(co);
            },
        });
    }
}

export interface ChartColumnOption {
    scriptColumnName: string;
    token?: string;
    orderByIndex?: number;
    orderByType?: "Ascending" | "Descending";
}

export interface ChartOptions {
    queryName: string;
    chartScript: string;
    filterOptions?: FilterOption[];
    orderOptions?: OrderOption[];
    chartColumnOptions: ChartColumnOption[];
}

/** `ColumnsChart` → the key the model uses; Signum takes everything after the first dot. */
function shortKey(symbolKey: string): string {
    const dot = symbolKey.indexOf(".");
    return dot < 0 ? symbolKey : symbolKey.slice(dot + 1);
}

/** Signum's `ChartOptions.Validate(qd)` — every problem at once, in the same order. */
export function validateChartOptions(co: ChartOptions): string | null {
    const queryName = resolveQueryName(co.queryName);
    const problems: string[] = [];

    const script = [...ChartScriptLogic.scripts.values()].find(s => shortKey(s.symbol.key) === co.chartScript);
    if (script == undefined)
        problems.push(`chartScript: '${co.chartScript}' is not a valid ChartScript`);

    const checkToken = (path: string, token: string): ReturnType<typeof parseToken> | undefined => {
        try {
            return parseToken(queryName, token);
        } catch (e) {
            problems.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
        }
    };

    const validateFilter = (f: FilterOption, path: string): void => {
        if (f.token != undefined && f.token !== "")
            checkToken(`${path}.token`, f.token);
        for (const [i, sub] of (f.filters ?? []).entries())
            validateFilter(sub, `${path}.filters[${i}]`);
    };
    (co.filterOptions ?? []).forEach((f, i) => validateFilter(f, `filterOptions[${i}]`));

    if (script != undefined) {
        if (co.chartColumnOptions == undefined) {
            problems.push("chartColumnOptions: is required");
        } else {
            const maxCount = Math.max(co.chartColumnOptions.length, script.columns.length);
            for (let i = 0; i < maxCount; i++) {
                const cco = co.chartColumnOptions[i];
                const scriptColumn = script.columns[i];

                if (scriptColumn == undefined) {
                    problems.push(`chartColumnOptions[${i}]: chartScript '${co.chartScript}' only has ${script.columns.length} columns`);
                    continue;
                }

                if (cco == undefined) {
                    if (!scriptColumn.isOptional)
                        problems.push(`chartColumnOptions[${i}]: chartScript '${co.chartScript}' requires a token for '${scriptColumn.name}'`);
                    continue;
                }

                if (scriptColumn.name !== cco.scriptColumnName) {
                    problems.push(`chartColumnOptions[${i}].scriptColumnName: '${cco.scriptColumnName}' does not match the name '${scriptColumn.name}' of column ${i} in chartScript '${co.chartScript}'`);
                    continue;
                }

                if (cco.token == undefined || cco.token === "") {
                    if (!scriptColumn.isOptional)
                        problems.push(`chartColumnOptions[${i}].token (Column '${cco.scriptColumnName}'): is required`);
                    continue;
                }

                const token = checkToken(`chartColumnOptions[${i}].token (Column '${cco.scriptColumnName}')`, cco.token);
                if (token != undefined && !isChartColumnType(token, scriptColumn.columnType as ChartColumnType))
                    problems.push(`chartColumnOptions[${i}].token (Column '${cco.scriptColumnName}'): the type of the token '${token.fullKey()}' is '${token.type?.typeName ?? "?"}', but a '${scriptColumn.columnType}' was expected.`);

                if (cco.orderByIndex != undefined && cco.orderByIndex < 0)
                    problems.push(`chartColumnOptions[${i}].orderByIndex (Column '${cco.scriptColumnName}'): should be >= 0`);
            }
        }
    }

    return problems.length === 0 ? null : problems.join("\n");
}

/** Signum's `ChartOptionsEncoder.ChartOptionsPath(co)`, in altea's chart URL format. */
export function chartOptionsPath(co: ChartOptions): string {
    const query: Record<string, unknown> = { script: co.chartScript };

    encodeFilters(query, co.filterOptions);
    encodeOrders(query, co.orderOptions);
    encodeChartColumns(query, co.chartColumnOptions);

    const strQuery = toQueryString(query);
    return `/chart/${co.queryName}${strQuery === "" ? "" : `?${strQuery}`}`;
}

function encodeChartColumns(query: Record<string, unknown>, columns: ChartColumnOption[] | undefined): void {
    if (columns == undefined)
        return;

    columns.forEach((co, i) => {
        const orderPrefix = co.orderByIndex != undefined
            ? `${co.orderByIndex}${co.orderByType === "Ascending" ? "A" : "D"}~`
            : "";
        query[`column${i}`] = orderPrefix + (co.token ?? "");
    });
}

function chartOptionsSchema(): ReturnType<typeof S.object> {
    return S.object({
        queryName: S.string("The query key, e.g. \"Order\""),
        chartScript: S.string("The key of a ChartScript from GetChartScripts"),
        filterOptions: S.array(S.any(), "Same shape as the Search skill's filterOptions"),
        orderOptions: S.array(S.object({
            token: S.string(),
            orderType: S.string("Ascending or Descending"),
        }, ["token"])),
        chartColumnOptions: S.array(S.object({
            scriptColumnName: S.string("Must equal the ChartScript column's name at this index"),
            token: S.string(),
            orderByIndex: S.number("Sort priority, 0-based"),
            orderByType: S.string("Ascending or Descending"),
        }, ["scriptColumnName"])),
    }, ["queryName", "chartScript", "chartColumnOptions"]);
}
