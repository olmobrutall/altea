import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import HtmlEditor from "@altea/altea-html-editor/client/HtmlEditor";
import { ImageExtension } from "@altea/altea-html-editor/client/Extensions/ImageExtension/index";
import { LinkExtension } from "@altea/altea-html-editor/client/Extensions/LinkExtension/index";
import type { HtmlEditorExtension } from "@altea/altea-html-editor/client/Extensions/types";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { ReadonlyBinding, type IBinding } from "@altea/altea/client/binding";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { classes } from "@altea/altea/data/globals";
import { HelpMessage } from "../../data/Help";
import { HelpClient } from "../HelpClient";
import { HelpImageHandler } from "./HelpImageHandler";

// Port of Signum.Help's Editor/EditableHtml.tsx — the in-place rich-text editor every help description
// uses: a VIEWER until you press its pencil, then the full Lexical editor.
//
// The extension set is Signum's exactly: links (so `<a href>` survives a round trip — see CLAUDE.md on
// altea-html-editor, where a link-less extension set silently drops anchors) plus images through the
// module's own handler.
const helpHtmlExtensions: HtmlEditorExtension[] = [new LinkExtension(), new ImageExtension(new HelpImageHandler())];

export function EditableHtml({ ctx, onChange, defaultEditable }: {
    ctx: TypeContext<string | undefined | null>;
    onChange?: () => void;
    defaultEditable?: boolean;
}): React.JSX.Element {

    const [editable, setEditable] = React.useState(defaultEditable ?? false);
    const readOnly = ctx.readOnly || !editable;

    return (
        <div className={classes("sf-edit-container", readOnly && "html-viewer")}>
            {editable
                ? <HelpHtmlEditor binding={ctx.binding} onChange={onChange} />
                : <HtmlViewer text={ctx.value} />}

            {!ctx.readOnly &&
                <LinkButton title={(editable ? HelpMessage.Close : HelpMessage.Edit).niceToString()}
                    className={classes("sf-edit-button", editable && "active", ctx.value && "block")}
                    onClick={() => setEditable(!editable)}>
                    <FontAwesomeIcon icon={editable ? "xmark" : "pen-to-square"} className="ms-2" aria-hidden={true} />
                    {" "}{(editable ? HelpMessage.Close : HelpMessage.Edit).niceToString()}
                </LinkButton>}
        </div>
    );
}

export function HelpHtmlEditor(p: {
    binding: IBinding<string | null | undefined>;
    readOnly?: boolean;
    onChange?: () => void;
}): React.JSX.Element {
    return (
        <ErrorBoundary>
            <HtmlEditor
                binding={p.binding}
                readOnly={p.readOnly}
                onEditorBlur={() => p.onChange?.()}
                extensionsMemo={helpHtmlExtensions} />
        </ErrorBoundary>
    );
}

/**
 * The read-only face. It renders through the same editor (so an image node draws the same way), over a
 * ReadonlyBinding holding the text with its `[t:Order]` tokens already expanded into anchors.
 */
export function HtmlViewer(p: {
    text: string | null | undefined;
    htmlAttributes?: React.HTMLAttributes<HTMLDivElement>;
}): React.JSX.Element | null {

    const htmlText = React.useMemo(() => HelpClient.replaceHtmlLinks(p.text), [p.text]);

    if (!htmlText)
        return null;

    const binding = new ReadonlyBinding<string | null | undefined>(htmlText, "");

    return (
        <div className="html-viewer">
            <ErrorBoundary>
                <HtmlEditor readOnly
                    binding={binding}
                    htmlAttributes={p.htmlAttributes}
                    small
                    extensionsMemo={helpHtmlExtensions} />
            </ErrorBoundary>
        </div>
    );
}
