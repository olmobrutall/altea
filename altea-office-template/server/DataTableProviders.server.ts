// Port of the IWordDataTableProvider implementations at the tail of Signum.Word's TableBinder.cs — the
// things a chart or table in a template can be bound to. Each is selected by the prefix an author writes
// into the shape's alternative text (see TableBinder's header).
//
// All THREE of Signum's providers are ported: Model, UserQuery and UserChart.
//
// The latter two were blocked for a while, because altea turns a stored user asset into a request
// CLIENT-side (the "QueryDescription is gone" divergence in the repo's CLAUDE.md) and the server had no
// converter. Both now exist, each in the package that owns the asset:
//   @altea/altea-user-queries -> server/UserQueryRequest.server.ts  (toQueryRequest)
//   @altea/altea-chart        -> server/ChartRequestLogic.server.ts (toChartRequest + executeChartAsync)

import { Entity } from "@altea/altea/data/entity";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { table as tableQuery } from "@altea/altea/server/table";
import type { ResultColumn, ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { toQueryRequest } from "@altea/altea-user-queries/server/UserQueryRequest.server";
import { UserChartEntity } from "@altea/altea-chart/data/UserChart";
import { executeUserChartAsync } from "@altea/altea-chart/server/ChartRequestLogic.server";
import { ColorPaletteLogic } from "@altea/altea-chart/server/ColorPaletteLogic.server";
import { Lite } from "@altea/altea/data/lite";
import type { OfficeTemplateEntity } from "../data/OfficeTemplate";
import { DataColumn, DataTable, type DataColumnKind } from "./DataTable.server";
import type { DataTableResult, IOfficeDataTableProvider, OfficeContext } from "./TableBinder.server";
import { OfficeModelLogic } from "./OfficeModelLogic.server";

/** The entity a provider resolves against (Signum's `WordContext.GetEntity()`). */
export function contextEntity(ctx: OfficeContext): Entity | null {
    return (ctx.entity as Entity | null) ?? (ctx.model?.untypedEntity ?? null);
}

/**
 * `Model:MethodName` — call a method on the template's MODEL and bind the DataTable it returns
 * (Signum's ModelDataTableProvider).
 */
export class ModelDataTableProvider implements IOfficeDataTableProvider {
    validate(suffix: string, template: OfficeTemplateEntity): string | undefined {
        if (template.model == null)
            return `No OfficeModel found in template '${template.name}' to call '${suffix.trim()}'`;

        const type = OfficeModelLogic.toType(template.model) as Function & { prototype?: Record<string, unknown> };
        if (typeof type.prototype?.[suffix.trim()] !== "function")
            return `No Method with name '${suffix.trim()}' found in type '${type.name}'`;

        return undefined;
    }

    async getDataTable(suffix: string, ctx: OfficeContext): Promise<DataTableResult> {
        const model = ctx.model as unknown as Record<string, unknown> | undefined;
        const name = suffix.trim();
        const method = model?.[name];

        if (typeof method !== "function")
            throw new Error(`No Method with name '${name}' found on the model of template '${ctx.template.name}'`);

        // Signum passes an `out Dictionary<string,string>? overridenColors` as the method's single argument;
        // TS has no out-parameters, so the method may instead RETURN `{ table, overridenColors }`.
        const result = await (method as (this: unknown) => unknown).call(model);

        if (result instanceof DataTable)
            return { table: result };

        if (result != null && typeof result === "object" && "table" in result)
            return result as DataTableResult;

        throw new Error(`Method '${name}' on the model did not return a DataTable`);
    }
}

/**
 * `UserQuery:<id>` — run a stored user query and bind its result (Signum's UserQueryDataTableProvider).
 *
 * Signum matches the asset by its `Guid Guid` column; altea's user assets use a uuid PRIMARY KEY as their
 * portable identity, so the suffix is matched against `id`.
 */
export class UserQueryDataTableProvider implements IOfficeDataTableProvider {
    validate(suffix: string, _template: OfficeTemplateEntity): string | undefined {
        // The row cannot be read synchronously (altea's retrieval is async), so parse-time validation is
        // limited to the id's SHAPE; a missing row surfaces at render time with a precise message.
        return isUuid(firstLine(suffix))
            ? undefined
            : `Impossible to convert '${firstLine(suffix)}' into an id for a UserQuery`;
    }

    async getDataTable(suffix: string, _ctx: OfficeContext): Promise<DataTableResult> {
        const id = firstLine(suffix);

        const userQuery = await ExecutionMode.global(() =>
            tableQuery(UserQueryEntity).filter(uq => uq.id == id).singleOrNull());

        if (userQuery == null)
            throw new Error(`No UserQuery with id=${id} found`);

        const result = await QueryLogic.queries.executeQueryAsync(toQueryRequest(userQuery, true));
        return { table: toDataTable(result) };
    }
}

/**
 * `UserChart:<id>` — run a stored user chart and bind its result, COLOURS included
 * (Signum's UserChartDataTableProvider).
 *
 * The colours are the reason this is not just "UserQuery with a different entity": a chart drawn in a
 * template has no chart script to run, so whatever the palette would have coloured a series or a slice
 * has to be resolved here and handed to TableBinder, which writes it into the shape's fill.
 */
export class UserChartDataTableProvider implements IOfficeDataTableProvider {
    validate(suffix: string, _template: OfficeTemplateEntity): string | undefined {
        return isUuid(firstLine(suffix))
            ? undefined
            : `Impossible to convert '${firstLine(suffix)}' into an id for a UserChart`;
    }

    async getDataTable(suffix: string, _ctx: OfficeContext): Promise<DataTableResult> {
        const id = firstLine(suffix);

        const userChart = await ExecutionMode.global(() =>
            tableQuery(UserChartEntity).filter(uc => uc.id == id).singleOrNull());

        if (userChart == null)
            throw new Error(`No UserChart with id=${id} found`);

        const result = await executeUserChartAsync(userChart);
        return { table: toDataTable(result), overridenColors: await overridenColorsOf(result) };
    }
}

/**
 * Signum's ColorFor sweep: any column whose values are entity LITES may have a configured palette colour,
 * and those become the chart's per-series / per-point overrides. Keyed by the value's rendered text, since
 * that is what TableBinder writes into the series name / category cell and therefore what it matches on.
 *
 * A type with no palette simply contributes nothing — the same as Signum's ColorFor returning null.
 */
async function overridenColorsOf(result: ResultTable): Promise<Map<string, string> | undefined> {
    const out = new Map<string, string>();

    for (const c of result.columns) {
        const seen = new Set<string>();
        for (const row of result.rows) {
            const value = row.getValue(c.token);
            if (!(value instanceof Lite))
                continue;

            const key = value.toString();
            if (seen.has(key))
                continue;
            seen.add(key);

            const color = await ColorPaletteLogic.colorFor(value);
            if (color != null && !out.has(key))
                out.set(key, color);
        }
    }

    return out.size === 0 ? undefined : out;
}

/** A ResultTable as a DataTable: one column per result column, rows in order (Signum's ToDataTable). */
function toDataTable(result: ResultTable): DataTable {
    const columns = result.columns.map(c => new DataColumn(columnName(c), columnKind(c), columnName(c)));
    const rows = result.rows.map(r => result.columns.map(c => r.getValue(c.token)));
    return new DataTable(columns, rows);
}

function columnName(c: ResultColumn): string {
    return c.token.niceName?.() ?? c.token.toString();
}

/** The three-way tag TableBinder needs ("can this column be a chart series?"), read off the token's type. */
function columnKind(c: ResultColumn): DataColumnKind {
    switch (c.token.type?.typeName) {
        case "Number":
        case "Decimal":
            return "number";
        case "PlainDate":
        case "PlainDateTime":
            return "date";
        default:
            return "other";
    }
}

/** The suffix may carry the pivot spec on a second line; only the first line is the id. */
function firstLine(suffix: string): string {
    return (suffix.split("\n")[0] ?? suffix).trim();
}

function isUuid(value: string): boolean {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}
