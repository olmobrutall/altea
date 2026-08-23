import type { ClientColorProvider } from "@altea/altea-map/client/Schema/ClientColorProvider";

// Port of Signum.Isolation's IsolationColorProvider.tsx — verbatim, including the palette: pink for
// Isolated, indigo for Optional, cyan for None, and the page background for a table with no strategy (which
// can only happen for the exempt enum / symbol tables).
//
// ALTEA: the factory takes no SchemaMapInfo — altea's registry passes it, but this provider reads only the
// per-table `extra` bag the SERVER filled, exactly as Signum's does.
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
