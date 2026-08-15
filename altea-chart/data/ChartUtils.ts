import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { ChartColumnType } from "./ChartScriptColumn";
import { ChartColumnEmbedded } from "./ChartColumn";
import { ChartParameterEmbedded } from "./ChartParameter";
import type { ChartScript } from "./ChartScript";
import type { IChartBase } from "./ChartRequest";

// Port of Signum.Chart/ChartUtils.cs (the static logic; the message enums live in ChartMessage.ts). Shared
// isomorphic logic: it maps query-token types to ChartColumnType and keeps a chart's columns/parameters in
// sync with its ChartScript. altea divergences from Signum are noted inline; the entity plumbing Signum
// leans on (ModifiedState.Sealed guard, IntegrityCheck, PostRetrievingContext, Debugger.Break) is dropped.

// Signum's ChartUtils.IsChartColumnType.
export function isChartColumnType(token: QueryToken | null, ct: ChartColumnType): boolean {
    if (token == null)
        return false;

    const type = getChartColumnType(token);
    if (type == null)
        return false;

    return flag(ct, type);
}

// Signum's `QueryToken.GetChartColumnType()` extension — the ChartColumnType a token maps to (via its
// FilterType + groupability), or null if it is not chartable.
export function getChartColumnType(token: QueryToken): ChartColumnType | null {
    switch (token.filterType) {
        case "Lite": return ChartColumnType.Entity;
        case "Boolean":
        case "Enum": return ChartColumnType.Enum;
        case "String":
        case "Guid": return ChartColumnType.String;
        case "Integer": return ChartColumnType.Number;
        case "Decimal": return token.isGroupable ? ChartColumnType.RoundedNumber : ChartColumnType.DecimalNumber;
        case "DateTime": return token.isGroupable ? ChartColumnType.Date : ChartColumnType.DateTime;
        case "Time": return ChartColumnType.Time;
    }

    return null;
}

// Signum's ChartUtils.Flag — bitwise flag test on the [Flags] ChartColumnType.
export function flag(ct: ChartColumnType, f: ChartColumnType): boolean {
    return (ct & f) === f;
}

// Signum's `ChartScript.SynchronizeColumns(chart, ctx)`. Reconciles a chart's columns + parameters with its
// ChartScript definition: pads/trims the column slots and binds each to its ScriptColumn, then reconciles
// parameters by name (rebinding when the name-set matches; otherwise rebuilding — carrying matching values
// across and defaulting the rest). Returns true if the chart's columns changed. Mutates `chart`.
//
// altea divergence: Signum guards the parameter reconcile on `chart.Parameters.Modified != Sealed` and uses
// IntegrityCheck to detect column drift; altea has neither, so the name-set fast path (rebind only) covers
// the "loaded, already-correct" case without clobbering user values, and the rebuild path runs otherwise.
export function synchronizeColumns(chartScript: ChartScript, chart: IChartBase): boolean {
    let result = false;

    for (let i = 0; i < chartScript.columns.length; i++) {
        if (chart.columns.length <= i) {
            chart.columns.push(new ChartColumnEmbedded());
            result = true;
        }

        chart.columns[i].parentChart = chart;
        chart.columns[i].scriptColumn = chartScript.columns[i];
    }

    if (chart.columns.length > chartScript.columns.length) {
        chart.columns.splice(chartScript.columns.length, chart.columns.length - chartScript.columns.length);
        result = true;
    }

    const chartScriptParameters = chartScript.allParameters();

    const sameNames =
        chart.parameters.map(a => a.name).sort().join("|") ===
        chartScriptParameters.map(a => a.name).sort().join("|");

    if (sameNames) {
        for (const cp of chart.parameters) {
            const sp = chartScriptParameters.find(a => a.name === cp.name)!;
            cp.parentChart = chart;
            cp.scriptParameter = sp;
        }
    } else {
        const normalize = (n: string): string => n.replace(/[ ()\-]/g, "").toLowerCase();
        const byName = new Map(chart.parameters.map(a => [normalize(a.name), a]));
        chart.parameters.length = 0;

        for (const sp of chartScriptParameters) {
            const cp = byName.get(normalize(sp.name));

            if (cp != null) {
                byName.delete(normalize(sp.name));
                cp.name = sp.name;
                cp.parentChart = chart;
                cp.scriptParameter = sp;
                chart.parameters.push(cp);
            } else {
                const created = new ChartParameterEmbedded();
                created.name = sp.name;
                created.parentChart = chart;
                created.scriptParameter = sp;
                created.value = sp.valueDefinition.getDefaultValue(sp.getToken(chart));
                chart.parameters.push(created);
            }
        }
    }

    return result;
}

// Signum's ChartUtils.FixParameters — when a column's token changes, reset any parameter bound to that
// column (ScriptParameter.ColumnIndex) whose current value no longer validates, back to its default.
export function fixParameters(chart: IChartBase, chartColumn: ChartColumnEmbedded): void {
    const index = chart.columns.indexOf(chartColumn);
    const token = chartColumn.token?.token ?? null;

    for (const p of chart.parameters) {
        if (p.scriptParameter?.columnIndex === index &&
            p.scriptParameter.validate(p.value ?? null, token) != null) {
            p.value = p.scriptParameter.defaultValueFor(token);
        }
    }
}
