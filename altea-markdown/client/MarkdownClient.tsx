import { Finder } from "@altea/altea/client/Finder";
import Markdown from "react-markdown";

// Port of Signum.Markdown's MarkdownClient.tsx — verbatim: a query column whose FORMAT is "Markdown" renders
// as rendered markdown instead of showing the raw source. `@format("Markdown")` on the field is what opts a
// column in, the same shape @altea/altea-html-editor's "Html" rule uses.
export namespace MarkdownClient {
    export function start(): void {
        Finder.formatRules().push({
            name: "Markdown",
            isApplicable: qt => qt.format === "Markdown",
            formatter: () => new Finder.CellFormatter(
                (val: string | null) => val ? <div><Markdown>{val}</Markdown></div> : undefined,
                true),
        });
    }
}
