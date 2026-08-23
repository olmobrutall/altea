import * as React from "react";
import type { LexicalEditor } from "lexical";
import { ErrorBoundary } from "@altea/altea/client/Components/ErrorBoundary";
import { ReadonlyBinding, type IBinding } from "@altea/altea/client/binding";
import HtmlEditor from "@altea/altea-html-editor/client/HtmlEditor";
import { LinkExtension } from "@altea/altea-html-editor/client/Extensions/LinkExtension/index";
import { ImageExtension } from "@altea/altea-html-editor/client/Extensions/ImageExtension/index";
import type { HtmlEditorExtension } from "@altea/altea-html-editor/client/Extensions/types";
import { WhatsNewImageHandler } from "./WhatsNewImageHandler";

// Port of Signum.WhatsNew's Templates/WhatsNewHtmlEditor.tsx — the news description's editor and its
// read-only viewer, both over the same extension set (links + inline images).
//
// ALTEA: the extension list is a module-level const (@altea/altea-help does the same) — `extensionsMemo`
// takes the ARRAY, not a factory, so a fresh array per render would tear the editor down.
const whatsNewExtensions: HtmlEditorExtension[] = [new LinkExtension(), new ImageExtension(new WhatsNewImageHandler())];

export default function WhatsNewHtmlEditor(p: {
    binding: IBinding<string | undefined | null>;
    readonly?: boolean;
    innerRef?: React.Ref<LexicalEditor>;
}): React.JSX.Element {
    return (
        <ErrorBoundary>
            <HtmlEditor binding={p.binding} readOnly={p.readonly} innerRef={p.innerRef}
                extensionsMemo={whatsNewExtensions} />
        </ErrorBoundary>
    );
}

/** Signum's `HtmlViewer` — the same editor, read-only and small, for a teaser or a rendered article. */
export function HtmlViewer(p: { text: string }): React.JSX.Element {
    const binding = new ReadonlyBinding(p.text, "");

    return (
        <div className="html-viewer">
            <ErrorBoundary>
                <HtmlEditor readOnly binding={binding} small extensionsMemo={whatsNewExtensions} />
            </ErrorBoundary>
        </div>
    );
}
