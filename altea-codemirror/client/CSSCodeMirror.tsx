import * as React from "react";
import type { Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// Port of Signum.CodeMirror's CSSCodeMirror.tsx. See CodeMirrorComponent.tsx for the CM5 → CM6 divergence.
interface CSSCodeMirrorProps {
    script: string;
    onChange?: (newScript: string) => void;
    isReadOnly?: boolean;
    innerRef?: React.Ref<CodeMirrorComponentHandler>;
}

const extensions: Extension[] = [css(), commonKeymap];

export default function CSSCodeMirror(p: CSSCodeMirrorProps): React.JSX.Element {
    return (
        <CodeMirrorComponent value={p.script} ref={p.innerRef}
            extensions={extensions}
            readOnly={p.isReadOnly}
            onChange={p.isReadOnly ? undefined : p.onChange} />
    );
}
