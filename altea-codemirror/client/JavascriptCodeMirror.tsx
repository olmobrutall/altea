import * as React from "react";
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// Port of Signum.CodeMirror's JavascriptCodeMirror.tsx. See CodeMirrorComponent.tsx for the CM5 → CM6
// divergence. Signum's `viewportMargin: Infinity` (render the whole document, so the editor grows with
// its content) has no CM6 option — CM6 always measures its own height — so it is dropped.
interface JavascriptCodeMirrorProps {
    code: string;
    onChange?: (code: string) => void;
    innerRef?: React.Ref<CodeMirrorComponentHandler>;
}

const extensions: Extension[] = [javascript(), commonKeymap];

export default function JavascriptCodeMirror(p: JavascriptCodeMirrorProps): React.JSX.Element {
    return (
        <div className="small-codemirror">
            <CodeMirrorComponent value={p.code} ref={p.innerRef}
                extensions={extensions}
                onChange={p.onChange} />
        </div>
    );
}
