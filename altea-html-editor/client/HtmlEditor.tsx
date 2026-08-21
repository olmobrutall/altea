import * as React from "react";
import { $isCodeNode } from "@lexical/code";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import type { LexicalEditor } from "lexical";
import { classes } from "@altea/altea/data/globals";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { IBinding } from "@altea/altea/client/binding";
import { HtmlEditorMessage } from "../data/HtmlEditor";
import type { HtmlEditorExtension } from "./Extensions/types";

import type { ITextConverter } from "./HtmlContentStateConverter";
import { BlockStyleButton, InlineStyleButton, Separator, SubMenuButton } from "./HtmlEditorButtons";
import { HtmlEditorController } from "./HtmlEditorController";
import LexicalTheme from "./LexicalTheme";
import { useController } from "./useController";
import { isEmpty } from "./Utils/editorState";
import { formatCode, formatHeading, formatList, formatQuote } from "./Utils/format";
import { $findMatchingParent, isHeadingActive, isListActive, isQuoteActive } from "./Utils/node";
import "./HtmlEditor.css";

// Port of Signum.HtmlEditor's HtmlEditor.tsx — the WYSIWYG surface: a LexicalComposer, a toolbar, and a
// controller that syncs the editor with an entity BINDING.
//
// Signum builds this on Lexical, and so does the port — same package, same version (0.45), so this is a
// near-verbatim port rather than a substrate rewrite. altea divergences:
//  - `IBinding` from altea's `client/binding`; `HtmlEditorMessage` from this package's data layer rather than
//    from core (see data/HtmlEditor.ts).
//  - `forceUpdate` is threaded into the controller so the OnChangeExtension can re-render the toolbar as the
//    selection moves. In Signum `controller.editorState` is never assigned, so every button's active state
//    and the `mandatory`-empty check evaluate against `undefined` — the buttons never highlight. See
//    HtmlEditorController's header.
//  - Signum's `imageHandler` computation had the `filter`/`singleOrNull` inverted (it produced a BOOLEAN and
//    passed it as the initialConfig's imageHandler); the controller already resolves the handler correctly,
//    so the editor just reads `controller.imageHandler`.
export interface HtmlEditorProps {
    ref?: React.Ref<HtmlEditorController>;
    binding: IBinding<string | null | undefined>;
    readOnly?: boolean;
    small?: boolean;
    mandatory?: boolean | "warning";
    converter?: ITextConverter;
    innerRef?: React.Ref<LexicalEditor>;
    extensionsMemo?: HtmlEditorExtension[];
    handleKeybindings?: (event: KeyboardEvent) => boolean;
    toolbarButtons?: (c: HtmlEditorController) => React.ReactNode;
    placeholder?: React.ReactNode;
    htmlAttributes?: React.HTMLAttributes<HTMLDivElement>;
    initiallyFocused?: boolean | number;
    onEditorFocus?: (e: React.FocusEvent, controller: HtmlEditorController) => void;
    onEditorBlur?: (e: React.FocusEvent, controller: HtmlEditorController) => void;
}

const createUid = (): string => Math.random().toString(36).substring(2, 9);

function HtmlEditor({
    ref, readOnly, small, binding, converter, innerRef, toolbarButtons, extensionsMemo, htmlAttributes,
    mandatory, initiallyFocused, handleKeybindings, placeholder, ...props
}: HtmlEditorProps): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const id = React.useMemo(() => createUid(), []);
    const editableId = "editable_" + id;

    const { controller, nodes, builtinPlugins } = useController({
        binding, readOnly, small, converter, innerRef, initiallyFocused, extensionsMemo, handleKeybindings,
        editableId, forceUpdate,
    });

    React.useImperativeHandle(ref, () => controller, [controller]);

    const error = binding.getError();

    return (
        <div
            title={error}
            onClick={() => controller.editor?.focus()}
            {...htmlAttributes}
            className={classes(
                "sf-html-editor",
                controller.readOnly && "read-only",
                mandatory && isEmpty(controller.editorState)
                    ? (mandatory === "warning" ? "sf-mandatory-warning" : "sf-mandatory")
                    : undefined,
                error && "has-error",
                controller.small ? "small-mode" : "",
                htmlAttributes?.className)}
        >
            <LexicalComposer
                initialConfig={{
                    namespace: "HtmlEditor_" + id,
                    nodes: [HeadingNode, QuoteNode, ...(nodes ?? [])],
                    theme: LexicalTheme,
                    onError: error => console.error(error),
                    editable: !readOnly,
                }}
            >
                {controller.overrideToolbar
                    ? <div className="sf-draft-toolbar">{controller.overrideToolbar}</div>
                    : toolbarButtons
                        ? toolbarButtons(controller)
                        : controller.readOnly || controller.small
                            ? null
                            : defaultToolbarButtons(controller)}

                <RichTextPlugin
                    contentEditable={
                        <ContentEditable
                            ref={controller.setContentEditableRef}
                            id={editableId}
                            className="public-DraftEditor-content"
                            onFocus={(event: React.FocusEvent) => props.onEditorFocus?.(event, controller)}
                            onBlur={(event: React.FocusEvent) => {
                                props.onEditorBlur?.(event, controller);
                                controller.saveHtml();
                            }}
                        />
                    }
                    placeholder={placeholder ? <div className="sf-html-editor-placeholder">{placeholder}</div> : undefined}
                    ErrorBoundary={LexicalErrorBoundary}
                />
                <EditorRefPlugin editorRef={comp => { controller.setEditorRef(comp); if (comp) forceUpdate(); }} />
                <HistoryPlugin />
                {builtinPlugins.map((a, i) => React.cloneElement(a, { key: i }))}
            </LexicalComposer>
        </div>
    );
}

export default HtmlEditor;

const defaultToolbarButtons = (c: HtmlEditorController): React.JSX.Element => (
    <div className="sf-draft-toolbar">
        <InlineStyleButton controller={c} style="bold" icon="bold" title={HtmlEditorMessage.Bold.niceToString()} />
        <InlineStyleButton controller={c} style="italic" icon="italic" title={HtmlEditorMessage.Italic.niceToString()} />
        <InlineStyleButton controller={c} style="underline" icon="underline" title={HtmlEditorMessage.Underline.niceToString()} />
        <InlineStyleButton controller={c} style="code" icon="code" title={HtmlEditorMessage.Code.niceToString()} />
        <Separator />
        <SubMenuButton controller={c} title={HtmlEditorMessage.Headings.niceToString()} icon="heading">
            <BlockStyleButton controller={c} blockType="h1" content="H1" isActiveFn={isHeadingActive} onClick={editor => formatHeading(editor, "h1")} />
            <BlockStyleButton controller={c} blockType="h2" content="H2" isActiveFn={isHeadingActive} onClick={editor => formatHeading(editor, "h2")} />
            <BlockStyleButton controller={c} blockType="h3" content="H3" isActiveFn={isHeadingActive} onClick={editor => formatHeading(editor, "h3")} />
        </SubMenuButton>
        <BlockStyleButton controller={c} blockType="ul" icon="list-ul" title={HtmlEditorMessage.UnorderedList.niceToString()}
            isActiveFn={isListActive} onClick={editor => formatList(editor, "ul")} />
        <BlockStyleButton controller={c} blockType="ol" icon="list-ol" title={HtmlEditorMessage.OrderedList.niceToString()}
            isActiveFn={isListActive} onClick={editor => formatList(editor, "ol")} />
        <BlockStyleButton controller={c} blockType="blockquote" icon="quote-right" title={HtmlEditorMessage.Quote.niceToString()}
            isActiveFn={isQuoteActive} onClick={formatQuote} />
        <BlockStyleButton controller={c} blockType="code-block" icon="file-code" title={HtmlEditorMessage.CodeBlock.niceToString()}
            isActiveFn={selection => !!$findMatchingParent(selection.anchor.getNode(), node => $isCodeNode(node))}
            onClick={formatCode} />
        {c.extraButtons()}
    </div>
);

