import * as React from "react";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { ReadonlyBinding } from "@altea/altea/client/binding";
import HtmlEditor from "./HtmlEditor";
import { LinkExtension } from "./Extensions/LinkExtension";
import type { HtmlEditorExtension } from "./Extensions/types";
import "./HtmlViewer.css";

// Port of Signum.HtmlEditor's HtmlViewer.tsx — verbatim: the same editor, read-only and `small` (so no
// toolbar), over a ReadonlyBinding. Links stay clickable, which is why LinkExtension is the default.
const defaultExtensions: HtmlEditorExtension[] = [new LinkExtension()];

export default function HtmlViewer(p: {
    text: string | null;
    htmlAttributes?: React.HTMLAttributes<HTMLDivElement>;
    extensionsMemo?: HtmlEditorExtension[];
}): React.JSX.Element {
    const extensions = p.extensionsMemo ?? defaultExtensions;
    const binding = new ReadonlyBinding(p.text, "");

    return (
        <div className="html-viewer">
            <ErrorBoundary>
                <HtmlEditor readOnly binding={binding} htmlAttributes={p.htmlAttributes} small
                    extensionsMemo={extensions} />
            </ErrorBoundary>
        </div>
    );
}
