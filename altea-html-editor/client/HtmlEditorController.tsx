import * as React from "react";
import { $getRoot, type EditorState, type LexicalEditor } from "lexical";
import type { IBinding } from "@altea/altea/client/binding";
import type { HtmlEditorExtension } from "./Extensions/types";
import type { ITextConverter } from "./HtmlContentStateConverter";
import { Separator } from "./HtmlEditorButtons";
import { isEmpty } from "./Utils/editorState";
import { ImageExtension } from "./Extensions/ImageExtension";
import type { ImageHandlerBase } from "./Extensions/ImageExtension/ImageHandlerBase";

// Port of Signum.HtmlEditor's HtmlEditorController.tsx — the bridge between the entity BINDING (a string
// field) and the Lexical editor: it loads the binding's html in, and writes the html back on blur / Ctrl+S /
// unmount.
//
// altea divergences, documented inline:
//  - `IBinding` comes from altea's `client/binding` (Signum's is in Reflection). `binding.setValue` sets no
//    `modified` flag — altea diffs against a snapshot — so saving is just an assignment.
//  - `editorState` is now actually ASSIGNED (see the note on `forceUpdate` below). In Signum the field is
//    declared and read (every toolbar button's active state, and the `mandatory` empty check) but never
//    written, so those all silently evaluate against `undefined`: buttons never highlight and a mandatory
//    empty editor never shows its warning. The OnChangeExtension — one of the four defaults, so it is always
//    present — now writes it and asks the component to re-render.
export interface HtmlEditorControllerProps {
    binding: IBinding<string | null | undefined>;
    editableId: string;
    readOnly?: boolean;
    small?: boolean;
    converter: ITextConverter;
    extensions?: HtmlEditorExtension[];
    innerRef?: React.Ref<LexicalEditor>;
    initiallyFocused?: boolean | number;
}

export class HtmlEditorController {
    editor!: LexicalEditor;
    editableElement: HTMLDivElement | null = null;
    editorState?: EditorState;

    /**
     * Set by HtmlEditor so the OnChangeExtension can ask for a re-render after it refreshes `editorState`.
     * That is what makes a toolbar button light up when the caret enters bold text.
     */
    forceUpdate?: () => void;

    overrideToolbar!: React.ReactElement | undefined;
    setOverrideToolbar!: (newState: React.ReactElement | undefined) => void;

    converter!: ITextConverter;
    extensions!: HtmlEditorExtension[];
    binding!: IBinding<string | null | undefined>;
    readOnly?: boolean;
    small?: boolean;
    initialEditorContent?: string;
    imageHandler?: ImageHandlerBase;

    /** The value this controller last wrote, so the load effect can tell its own write from a real change. */
    lastSavedString?: { str: string | null };

    init(p: HtmlEditorControllerProps): void {
        this.binding = p.binding;
        this.readOnly = p.readOnly;
        this.small = p.small;
        this.converter = p.converter;
        this.extensions = p.extensions ?? [];

        [this.overrideToolbar, this.setOverrideToolbar] =
            React.useState<React.ReactElement | undefined>(undefined);

        this.imageHandler = p.extensions
            ?.map(a => a instanceof ImageExtension ? a.imageHandler : null)
            .filter((a): a is ImageHandlerBase => a != null)[0] ?? undefined;

        React.useEffect(() => {
            if (p.initiallyFocused) {
                window.setTimeout(
                    () => { if (this.editor) this.editor.focus(); },
                    p.initiallyFocused === true ? 0 : (p.initiallyFocused as number));
            }
        }, []);

        const newValue = this.binding.getValue();
        React.useEffect(() => {
            if (!this.editor)
                return;

            // Our own write coming back through the binding — do not reload (it would move the caret).
            if (this.lastSavedString && this.lastSavedString.str === newValue) {
                this.lastSavedString = undefined;
                return;
            }

            queueMicrotask(() => {
                const newState = this.converter.$convertFromText(this.editor, newValue || "");

                if (newState.isEmpty()) {
                    this.editor.update(() => { $getRoot().clear(); });
                } else {
                    this.editor.setEditorState(newState);
                }

                // Remember what the editor STARTED from, so saveHtml can skip a no-op write (Lexical's
                // round-trip is not byte-identical to arbitrary input html).
                this.initialEditorContent = this.converter.$convertToText(this.editor);
            });
        }, [newValue, this.editor]);

        // Save on unmount: a blur does not fire when the whole form goes away.
        React.useEffect(() => () => this.saveHtml(), []);

        this.setEditorRef = React.useCallback(
            (editor: LexicalEditor | null) => {
                this.editor = editor!;
                if (this.editor)
                    this.editor.imageHandler = this.imageHandler;

                if (p.innerRef) {
                    if (typeof p.innerRef === "function")
                        p.innerRef(editor);
                    else
                        (p.innerRef as React.RefObject<LexicalEditor | null>).current = editor;
                }
            },
            [p.innerRef]);

        this.setContentEditableRef = React.useCallback(
            (element: HTMLDivElement | null) => { this.editableElement = element!; },
            [p.innerRef]);
    }

    saveHtml(): void {
        if (this.readOnly)
            return;

        const newContentString = this.converter.$convertToText(this.editor);

        if (newContentString !== this.initialEditorContent) {
            const value = isEmpty(this.editorState) ? null : newContentString;
            this.lastSavedString = { str: value };
            this.binding.setValue(value);
        }
    }

    extraButtons(): React.ReactElement | null {
        const buttons = this.extensions
            .map(p => p.getToolbarButtons?.(this))
            .filter(b => b != undefined);

        if (buttons.length === 0)
            return null;

        return React.createElement(React.Fragment, undefined, <Separator />, ...buttons);
    }

    setEditorRef!: (editor: LexicalEditor | null) => void;
    setContentEditableRef!: (editor: HTMLDivElement | null) => void;
}
