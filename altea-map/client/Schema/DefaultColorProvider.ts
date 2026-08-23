import * as d3 from "d3";
import { bytesToSize } from "@altea/altea/data/globals/helpers";
import { toNumberFormat } from "@altea/altea/client/numberFormat";
import { MapMessage, type SchemaMapInfo } from "../../data/Map";
import { colorScaleLog } from "../Utils";
import type { ClientColorProvider } from "./ClientColorProvider";

// Port of Signum.Map's Schema/DefaultColorProvider.ts — the six built-in colourings (+ the two history
// ones when the schema has a versioned table), each the client half of a `MapColorProvider` the server
// announced. Code-split: MapClient imports it lazily.
//
// altea divergences:
//  - Signum's `.max()!` array extension does not exist here → `Math.max(...)`.
//  - The `entityKind` palette gains no entries: altea's EntityKind has the same members as Signum's, and
//    "SharedPart" is already there.
//  - The "no history table" tooltip is a MESSAGE rather than the English literal Signum hard-codes.
export default function getDefaultProviders(info: SchemaMapInfo): ClientColorProvider[] {

    const namespaceColor = d3.scaleOrdinal(d3.schemePaired);
    const namespace: ClientColorProvider = {
        name: "namespace",
        getFill: t => namespaceColor(t.namespace),
        getTooltip: t => t.namespace,
    };

    const entityKindColors: { [ek: string]: string } = {
        SystemString: "#8c564b",
        System: "#7f7f7f",
        Relational: "#17becf",
        String: "#e377c2",
        Shared: "#2ca02c",
        Main: "#d62728",
        Part: "#ff7f0e",
        SharedPart: "#bcbd22",
    };

    const entityKind: ClientColorProvider = {
        name: "entityKind",
        getFill: t => entityKindColors[t.entityKind ?? ""] ?? "var(--bs-body-color)",
        getTooltip: t => t.entityKind ?? "",
    };

    const entityData: ClientColorProvider = {
        name: "entityData",
        getFill: t => t.entityData == "Master" ? "#2ca02c" :
            t.entityData == "Transactional" ? "#d62728" : "var(--bs-body-color)",
        getTooltip: t => t.entityData ?? "",
    };

    const columnsColor = colorScaleLog(maxOf(info, a => a.columns));
    const columns: ClientColorProvider = {
        name: "columns",
        getFill: t => columnsColor(t.columns) as unknown as string,
        getTooltip: t => t.columns + " " + MapMessage.Columns.niceToString(),
    };

    const rowsColor = colorScaleLog(maxOf(info, a => a.rows));
    const rows: ClientColorProvider = {
        name: "rows",
        getFill: t => t.rows == null ? "gray" : rowsColor(t.rows) as unknown as string,
        getTooltip: t => (t.rows == null ? "" : roundValue(t.rows, scientificUnits)) + " " + MapMessage.Rows.niceToString(),
    };

    const tableSizeColor = colorScaleLog(maxOf(info, a => a.total_size_kb));
    const tableSize: ClientColorProvider = {
        name: "tableSize",
        getFill: t => t.total_size_kb == null ? "gray" : tableSizeColor(t.total_size_kb) as unknown as string,
        getTooltip: t => bytesToSize((t.total_size_kb ?? 0) * 1024),
    };

    const result = [namespace, entityKind, entityData, columns, rows, tableSize];

    if (info.providers.some(a => a.name == "rows_history")) {
        const rowsHistoryColor = colorScaleLog(maxOf(info, a => a.rows_history));
        result.push({
            name: "rows_history",
            getFill: t => t.rows_history == null ? "gray" : rowsHistoryColor(t.rows_history) as unknown as string,
            getTooltip: t => t.rows_history == null ? MapMessage.NoHistoryTable.niceToString()
                : roundValue(t.rows_history, scientificUnits) + " " + MapMessage.Rows.niceToString(),
        });
    }

    if (info.providers.some(a => a.name == "tableSize_history")) {
        const tableSizeHistoryColor = colorScaleLog(maxOf(info, a => a.total_size_kb_history));
        result.push({
            name: "tableSize_history",
            getFill: t => t.total_size_kb_history == null ? "gray" : tableSizeHistoryColor(t.total_size_kb_history) as unknown as string,
            // NOTE: Signum tests `rows_history` here (not `total_size_kb_history`) — the same table has
            // either both or neither, so the two are equivalent; kept as the field this scale is about.
            getTooltip: t => t.total_size_kb_history == null ? MapMessage.NoHistoryTable.niceToString()
                : bytesToSize(t.total_size_kb_history * 1024),
        });
    }

    return result;
}

/** Signum's `info.tables.filter(…).map(…).max()!` — the domain top for one of the log scales. */
function maxOf(info: SchemaMapInfo, selector: (t: SchemaMapInfo["tables"][number]) => number | null): number {
    const values = info.tables.map(selector).filter((v): v is number => v != null);
    return values.length === 0 ? 1 : Math.max(...values);
}

const scientificUnits = ["", "k", "m", "b", "t"];

/** Signum's `roundValue`: 1 234 567 rows → "1.23 m". */
export function roundValue(value: number, units: string[]): string {

    let scaled = value;
    let i;

    const base = units == scientificUnits ? 1000 : 1024;

    for (i = 0; i < units.length && scaled >= base; i++)
        scaled /= base;

    return toNumberFormat("N2").format(scaled) + " " + units[i];
}
