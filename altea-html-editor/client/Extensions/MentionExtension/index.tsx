import * as React from "react";
import * as ReactDOM from "react-dom";
import {
    LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
    $getSelection, $isNodeSelection, COMMAND_PRIORITY_LOW, KEY_BACKSPACE_COMMAND, KEY_DELETE_COMMAND,
    type TextNode,
} from "lexical";
import { useAPI } from "@altea/altea/client/Hooks";
import { HtmlEditorExtension, type LexicalConfigNode } from "../types";
import type { MentionHandlerBase, MentionItem } from "./MentionHandlerBase";
import { MentionNode, $createMentionNode, $isMentionNode } from "./MentionNode";

// Port of Signum.HtmlEditor's Extensions/MentionExtension/index.tsx — verbatim: an @-typeahead over items the
// app's handler supplies, inserted as a MentionNode chip. NOT one of the defaults; a host adds it with a
// handler.
class MentionOption extends MenuOption {
    constructor(public item: MentionItem) {
        super(item.key);
    }
}

export class MentionExtension extends HtmlEditorExtension {
    override name = "MentionExtension";

    constructor(public handler: MentionHandlerBase) {
        super();
    }

    override getNodes(): LexicalConfigNode {
        return [MentionNode];
    }

    override getBuiltPlugin(): React.ReactElement {
        return <MentionPlugin handler={this.handler} />;
    }
}

function MentionPlugin(p: { handler: MentionHandlerBase }): React.JSX.Element | null {
    const [editor] = useLexicalComposerContext();
    const [options, setOptions] = React.useState<MentionOption[]>([]);

    // Delete a chip with ONE Backspace/Delete when it is the node selection (i.e. the user clicked it).
    React.useEffect(() => {
        function removeSelectedMentions(event: KeyboardEvent): boolean {
            const selection = $getSelection();
            if (!$isNodeSelection(selection))
                return false;
            const mentions = selection.getNodes().filter($isMentionNode);
            if (mentions.length === 0)
                return false;
            event.preventDefault();
            mentions.forEach(n => n.remove());
            return true;
        }
        const unregisterBackspace = editor.registerCommand(KEY_BACKSPACE_COMMAND, removeSelectedMentions, COMMAND_PRIORITY_LOW);
        const unregisterDelete = editor.registerCommand(KEY_DELETE_COMMAND, removeSelectedMentions, COMMAND_PRIORITY_LOW);
        return () => { unregisterBackspace(); unregisterDelete(); };
    }, [editor]);

    const allItems = useAPI(() => p.handler.getItems(), [p.handler]);

    const triggerFn = useBasicTypeaheadTriggerMatch(p.handler.trigger, { minLength: 0, maxLength: 50, allowWhitespace: true });

    const onQueryChange = React.useCallback((query: string | null) => {
        if (query === null || !allItems) {
            setOptions([]);
            return;
        }
        const q = query.toLowerCase();
        setOptions(allItems
            .filter(item => item.text.toLowerCase().includes(q))
            .sort((a, b) => a.text.localeCompare(b.text))
            .map(item => new MentionOption(item)));
    }, [allItems]);

    const onSelectOption = React.useCallback((
        option: MentionOption,
        nodeToReplace: TextNode | null,
        closeMenu: () => void,
    ) => {
        editor.update(() => {
            const mentionNode = $createMentionNode(option.item.key, option.item.text, p.handler.trigger);
            if (nodeToReplace)
                nodeToReplace.replace(mentionNode);
            mentionNode.selectNext();
        });
        closeMenu();
    }, [editor, p.handler.trigger]);

    return (
        <LexicalTypeaheadMenuPlugin
            options={options}
            onQueryChange={onQueryChange}
            onSelectOption={onSelectOption}
            triggerFn={triggerFn}
            menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
                if (!anchorElementRef.current || options.length === 0)
                    return null;

                return ReactDOM.createPortal(
                    <ul className="mention-dropdown list-group">
                        {options.map((option, i) => (
                            <li key={option.key}
                                ref={option.setRefElement}
                                role="option"
                                aria-selected={i === selectedIndex}
                                className={`list-group-item list-group-item-action${i === selectedIndex ? " active" : ""}`}
                                onClick={() => selectOptionAndCleanUp(option)}
                                onMouseEnter={() => setHighlightedIndex(i)}>
                                {p.handler.renderOption
                                    ? p.handler.renderOption(option.item)
                                    : `${p.handler.trigger}${option.item.text}`}
                            </li>
                        ))}
                    </ul>,
                    anchorElementRef.current);
            }}
        />
    );
}

export type { MentionHandlerBase, MentionItem };
export { MentionNode, $createMentionNode, $isMentionNode };
