import * as React from "react";
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// NEW in altea, with no Signum counterpart — and the direct replacement for `CSharpCodeMirror` wherever a
// stored SCRIPT is edited (@altea/altea-eval). Signum's evals are C#; altea's are TypeScript, so the editor
// that matters is this one. `@codemirror/lang-javascript` parses TypeScript with one flag, which is why this
// is five lines rather than the legacy-mode dance CSharpCodeMirror needs.
interface TypeScriptCodeMirrorProps {
    code: string;
    onChange?: (code: string) => void;
    isReadOnly?: boolean;
    errorLineNumber?: number;
    innerRef?: React.Ref<CodeMirrorComponentHandler>;
}

const extensions: Extension[] = [javascript({ typescript: true }), commonKeymap];

export default function TypeScriptCodeMirror(p: TypeScriptCodeMirrorProps): React.JSX.Element {
    return (
        <div className="small-codemirror">
            <CodeMirrorComponent value={p.code} ref={p.innerRef}
                extensions={extensions}
                readOnly={p.isReadOnly}
                errorLineNumber={p.errorLineNumber}
                onChange={p.onChange} />
        </div>
    );
}
