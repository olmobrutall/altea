import * as React from "react";
import { Finder } from "@altea/altea/client/Finder";
import HtmlViewer from "./HtmlViewer";

// Port of Signum.HtmlEditor's HtmlEditorClient.tsx — verbatim: a query column whose FORMAT is "Html" renders
// through the viewer instead of showing raw markup. `@format("Html")` on the field is what opts a column in.
export namespace HtmlEditorClient {
    export function start(): void {
        Finder.formatRules.push({
            name: "Html",
            isApplicable: qt => qt.format === "Html",
            formatter: () => new Finder.CellFormatter(
                (val: string | null) => val ? <HtmlViewer text={val} /> : undefined,
                true),
        });
    }
}
