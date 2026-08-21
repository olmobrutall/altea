import * as React from "react";
import type { Extension } from "@codemirror/state";
import { xml } from "@codemirror/lang-xml";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// Port of Signum.CodeMirror's XmlCodeMirror.tsx. See CodeMirrorComponent.tsx for the CM5 → CM6 divergence.
interface XmlCodeMirrorProps {
    script: string;
    onChange?: (newScript: string) => void;
    isReadOnly?: boolean;
    innerRef?: React.Ref<CodeMirrorComponentHandler>;
}

const extensions: Extension[] = [xml(), commonKeymap];

export default function XmlCodeMirror(p: XmlCodeMirrorProps): React.JSX.Element {
    return (
        <CodeMirrorComponent value={p.script} ref={p.innerRef}
            extensions={extensions}
            readOnly={p.isReadOnly}
            onChange={p.isReadOnly ? undefined : p.onChange} />
    );
}
