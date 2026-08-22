import * as React from "react";
import { ReadonlyBinding, type IBinding } from "@altea/altea/client/binding";
import { ErrorBoundary } from "@altea/altea/client/Components/ErrorBoundary";
import HtmlEditor from "@altea/altea-html-editor/client/HtmlEditor";
import { LinkExtension } from "@altea/altea-html-editor/client/Extensions/LinkExtension/index";
import "@altea/altea-html-editor/client/HtmlEditorLine.css";

// Port of Signum.Translation's Instances/TranslatedHtml.tsx — the rich rendering for a route marked
// `@translatable("Html")`. Both halves are thin wrappers over @altea/altea-html-editor.
//
// The LinkExtension is included deliberately: an html translation is usually a paragraph of marketing
// copy, and without it Lexical parses an existing `<a href>` back as bare text and the anchor is silently
// lost (the trap altea-html-editor's own header documents).

/** Read-only rich rendering of a translated html value. */
export function TranslatedHtmlViewer(p: { text: string | null | undefined }): React.JSX.Element {
    const binding = new ReadonlyBinding<string | null | undefined>(p.text ?? "", "");
    return (
        <div className="html-viewer">
            <ErrorBoundary>
                <HtmlEditor readOnly binding={binding} toolbarButtons={() => null} extensionsMemo={[new LinkExtension()]} />
            </ErrorBoundary>
        </div>
    );
}

/** Editable rich rendering of a translated html value. */
export function TranslatedHtmlEditor(p: { text: string | null | undefined; onChange: (newText: string) => void }): React.JSX.Element {
    // The binding is created ONCE (HtmlEditor reads getValue only on mount), so it reads the latest props
    // through a ref rather than closing over the first ones — Signum does the same.
    const propsRef = React.useRef(p);
    propsRef.current = p;

    const binding = React.useMemo<IBinding<string | null | undefined>>(() => ({
        getValue: () => propsRef.current.text,
        setValue: v => propsRef.current.onChange(v ?? ""),
        suffix: "",
        getIsReadonly: () => false,
        getIsHidden: () => false,
        getError: () => undefined,
        setError: () => { },
    }), []);

    return (
        <div className="html-editor-line" style={{ width: "90%" }}>
            <ErrorBoundary>
                <HtmlEditor binding={binding} extensionsMemo={[new LinkExtension()]} />
            </ErrorBoundary>
        </div>
    );
}
