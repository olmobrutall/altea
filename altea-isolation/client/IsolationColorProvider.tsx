import type { ClientColorProvider } from "@altea/altea-map/client/Schema/ClientColorProvider";

// The schema map's isolation colouring: pink for Isolated, indigo for Optional, cyan for None, and the
// page background for a table with no strategy (which can only happen for the exempt enum / symbol
// tables). Reads only the per-table `extra` bag the SERVER filled, so the factory needs no SchemaMapInfo.
export default function getIsolationProviders(): ClientColorProvider[] {
    return [{
        name: "isolation",
        getFill: t => t.extra["isolation"] == undefined ? "var(--background)" :
            t.extra["isolation"] == "Isolated" ? "#d63384" :
                t.extra["isolation"] == "Optional" ? "#6610f2" :
                    t.extra["isolation"] == "None" ? "#0dcaf0" : "var(--foreground)",
        getTooltip: t => (t.extra["isolation"] as string | undefined) ?? "",
    }];
}
