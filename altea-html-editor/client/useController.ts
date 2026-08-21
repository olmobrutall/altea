import * as React from "react";
import type { LexicalEditor } from "lexical";
import type { IBinding } from "@altea/altea/client/binding";
import { BasicCommandsExtensions } from "./Extensions/BasicCommandsExtension";
import { CodeBlockExtension } from "./Extensions/CodeBlockExtension";
import { ListExtension } from "./Extensions/ListExtension";
import { OnChangeExtension } from "./Extensions/OnChangeExtension";
import type { HtmlEditorExtension, LexicalConfigNode } from "./Extensions/types";
import { HtmlContentStateConverter, type ITextConverter } from "./HtmlContentStateConverter";
import type { HtmlEditorProps } from "./HtmlEditor";
import { HtmlEditorController } from "./HtmlEditorController";
import { useRegisterExtensions } from "./useRegisterExtensions";
import { useRegisterKeybindings } from "./useRegisterKeybindings";

// Port of Signum.HtmlEditor's useController.ts — verbatim: build the controller once, prepend the four
// DEFAULT extensions to whatever the host passed, and hand back the Lexical nodes + plugin elements they
// contribute.
type ControllerProps = {
    binding: IBinding<string | null | undefined>;
    editableId: string;
    readOnly?: boolean;
    small?: boolean;
    converter?: ITextConverter;
    innerRef?: React.Ref<LexicalEditor>;
    extensionsMemo?: HtmlEditorExtension[];
    initiallyFocused?: boolean | number;
    handleKeybindings?: HtmlEditorProps["handleKeybindings"];
    forceUpdate?: () => void;
};

type ControllerReturnType = {
    controller: HtmlEditorController;
    nodes: LexicalConfigNode;
    builtinPlugins: React.ReactElement[];
};

export const useController = ({
    binding, readOnly, small, converter, innerRef, extensionsMemo, initiallyFocused, handleKeybindings,
    editableId, forceUpdate,
}: ControllerProps): ControllerReturnType => {

    const controller = React.useMemo(() => new HtmlEditorController(), []);
    const textConverter = converter ?? new HtmlContentStateConverter();

    controller.forceUpdate = forceUpdate;

    const finalExtension: HtmlEditorExtension[] = React.useMemo(() => {
        const defaultExtensions = [
            new BasicCommandsExtensions(),
            new ListExtension(),
            new OnChangeExtension(),
            new CodeBlockExtension(),
        ];

        if (!extensionsMemo)
            return defaultExtensions;

        const result = [...defaultExtensions, ...extensionsMemo];

        // Signum calls `result.toObject(a => a.name)` purely to throw on a duplicate name; spelled out here.
        const names = new Set<string>();
        for (const e of result) {
            if (names.has(e.name))
                throw new Error(`Duplicated HtmlEditorExtension name '${e.name}'`);
            names.add(e.name);
        }

        return result;
    }, [extensionsMemo, controller]);

    React.useEffect(() => {
        if (!controller.editor)
            return;

        controller.editor.setEditable(!readOnly);
    }, [controller.editor, readOnly]);

    useRegisterExtensions(controller, finalExtension);
    useRegisterKeybindings(controller, handleKeybindings);

    controller.init({
        binding,
        readOnly,
        small,
        converter: textConverter,
        innerRef,
        initiallyFocused,
        extensions: finalExtension,
        editableId,
    });

    const nodes = React.useMemo(() => finalExtension.flatMap(e => e.getNodes?.() ?? []), [finalExtension]);

    const builtinPlugins = React.useMemo(
        () => finalExtension.map(e => e.getBuiltPlugin?.()).filter((a): a is React.ReactElement => a != undefined),
        [finalExtension]);

    return { controller, nodes, builtinPlugins };
};
