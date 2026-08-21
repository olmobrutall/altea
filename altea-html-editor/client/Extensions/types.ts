import type { InitialConfigType } from "@lexical/react/LexicalComposer";
import type { HtmlEditorController } from "../HtmlEditorController";

// Port of Signum.HtmlEditor's Extensions/types.ts — verbatim. An extension contributes any combination of
// toolbar buttons, Lexical NODES the composer must know about, a Lexical PLUGIN element, and imperative
// command registrations (whose return value unregisters them).
export abstract class HtmlEditorExtension {
    abstract name: string;
    getToolbarButtons?(controller: HtmlEditorController): React.ReactNode;
    registerExtension?(controller: HtmlEditorController): OptionalCallback;
    getNodes?(): LexicalConfigNode;
    getBuiltPlugin?(): React.ReactElement;
}

export type OptionalCallback = (() => void) | null | undefined;
export type LexicalConfigNode = InitialConfigType["nodes"];
