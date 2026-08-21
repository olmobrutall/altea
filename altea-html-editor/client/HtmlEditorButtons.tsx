import * as React from "react";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import {
    $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, type LexicalEditor, type RangeSelection,
    type TextFormatType,
} from "lexical";
import type { HtmlEditorController } from "./HtmlEditorController";

// Port of Signum.HtmlEditor's HtmlEditorButtons.tsx — verbatim. `onMouseDown` is prevented on the wrapper so
// clicking a button never steals the selection the command is about to act on.

export function Separator(): React.JSX.Element {
    return <div className="sf-html-separator" />;
}

export function HtmlEditorButton(p: {
    icon?: IconProp;
    content?: React.ReactNode;
    isActive?: boolean;
    title?: string;
    onClick: (e: React.MouseEvent) => void;
}): React.JSX.Element {
    return (
        <div className="sf-draft-button-wrapper" onMouseDown={e => e.preventDefault()}>
            <button className={classes("sf-draft-button", p.isActive && "sf-draft-active")}
                type="button" onClick={p.onClick} title={p.title}>
                {p.content ?? <FontAwesomeIcon aria-hidden icon={p.icon ?? "question"} />}
            </button>
        </div>
    );
}

export function InlineStyleButton(p: {
    controller: HtmlEditorController;
    style: TextFormatType;
    icon?: IconProp;
    content?: React.ReactNode;
    title?: string;
}): React.JSX.Element {
    const { editor, editorState } = p.controller;

    const isActive = React.useMemo(() => {
        let active = false;
        editorState?.read(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection))
                active = selection.hasFormat(p.style);
        });
        return active;
    }, [editorState, p.style]);

    const toggleStyle = (): void => {
        editor?.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection))
                return;
            editor.dispatchCommand(FORMAT_TEXT_COMMAND, p.style);
        });
    };

    return <HtmlEditorButton isActive={isActive} onClick={toggleStyle} icon={p.icon} content={p.content} title={p.title} />;
}

export function BlockStyleButton(p: {
    controller: HtmlEditorController;
    blockType: string;
    icon?: IconProp;
    content?: React.ReactNode;
    title?: string;
    isActiveFn: (selection: RangeSelection, blockType: string) => boolean;
    onClick: (editor: LexicalEditor) => void;
}): React.JSX.Element {
    const { editor, editorState } = p.controller;

    const isActive = React.useMemo(() => {
        let active = false;
        editorState?.read(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection))
                return;
            active = p.isActiveFn(selection, p.blockType);
        });
        return active;
    }, [editorState, p.blockType]);

    return (
        <HtmlEditorButton isActive={isActive} onClick={() => p.onClick(editor)}
            icon={p.icon} content={p.content} title={p.title} />
    );
}

/** Opens a nested toolbar (the headings group) that replaces the strip until the next window click. */
export function SubMenuButton(p: {
    controller: HtmlEditorController;
    icon?: IconProp;
    content?: React.ReactNode;
    title?: string;
    children: React.ReactNode;
}): React.JSX.Element {
    function handleOnClick(): void {
        p.controller.setOverrideToolbar(<SubMenu controller={p.controller}>{p.children}</SubMenu>);
    }

    return <HtmlEditorButton onClick={handleOnClick} icon={p.icon} content={p.content} title={p.title} />;
}

export function SubMenu(p: { controller: HtmlEditorController; children: React.ReactNode }): React.JSX.Element {
    React.useEffect(() => {
        function onWindowClick(): void {
            p.controller.setOverrideToolbar(undefined);
        }
        // Deferred a tick, or the very click that opened the submenu would close it again.
        window.setTimeout(() => window.addEventListener("click", onWindowClick));
        return () => window.removeEventListener("click", onWindowClick);
    }, []);

    return p.children as React.ReactElement;
}
