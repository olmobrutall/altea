import * as React from "react";

// altea stand-in for Signum.HtmlEditor's `HtmlViewer` (that extension is not ported). Renders stored HTML
// authored by a dashboard admin — a TextPart of type HTML, or a part's tooltip.
//
// The content is TRUSTED the same way Signum trusted it: only a user who can edit a Dashboard (a Main
// entity behind the normal type-auth rules) can write it, and Signum's HtmlViewer likewise renders it
// verbatim. There is no sanitizer in altea; if a deployment lets untrusted users author dashboards, it must
// add one here.
export default function HtmlViewer(p: { text: string; className?: string }): React.JSX.Element {
    return <div className={p.className} dangerouslySetInnerHTML={{ __html: p.text }} />;
}
