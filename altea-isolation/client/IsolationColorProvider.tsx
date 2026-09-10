import type { ClientColorProvider } from "@altea/altea-map/client/Schema/ClientColorProvider";

// The schema map's isolation colouring: pink for Isolated, indigo for Optional, cyan for None, and the
// page background for a table with no strategy (which can only happen for the exempt enum / symbol
// tables). Reads only the per-table `extra` bag the SERVER filled, so the factory needs no SchemaMapInfo.
export default function getIsolationProviders(): ClientColorProvider[] {
    return [{
        name: "isolation",
        getFill: t => t.extra["isolation"] == undefined ? "var(--bs-body-bg)" :
            t.extra["isolation"] == "Isolated" ? "var(--bs-pink)" :
                t.extra["isolation"] == "Optional" ? "var(--bs-indigo)" :
                    t.extra["isolation"] == "None" ? "var(--bs-cyan)" : "var(--bs-body-color)",
        getTooltip: t => (t.extra["isolation"] as string | undefined) ?? "",
    }];
}
