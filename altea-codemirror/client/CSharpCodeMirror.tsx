import * as React from "react";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// Port of Signum.CodeMirror's CSharpCodeMirror.tsx. Props are unchanged; see CodeMirrorComponent.tsx for
// the CM5 → CM6 divergence. C# is the ONE language with no first-party CM6 package, so it runs CM5's own
// `clike` mode through `StreamLanguage` (`@codemirror/legacy-modes`) — the same grammar Signum loaded as
// `codemirror/mode/clike/clike` with `mode: "text/x-csharp"`.
interface CSharpCodeMirrorProps {
    script: string;
    onChange?: (newScript: string) => void;
    isReadOnly?: boolean;
    errorLineNumber?: number;
    innerRef?: React.Ref<CodeMirrorComponentHandler>;
    onInit?: (view: EditorView) => void;
}

const extensions: Extension[] = [StreamLanguage.define(csharp), commonKeymap];

export default function CSharpCodeMirror(p: CSharpCodeMirrorProps): React.JSX.Element {
    return (
        <CodeMirrorComponent value={p.script} ref={p.innerRef}
            extensions={extensions}
            readOnly={p.isReadOnly}
            onChange={p.isReadOnly ? undefined : p.onChange}
            errorLineNumber={p.errorLineNumber}
            onInit={p.onInit}
        />
    );
}
