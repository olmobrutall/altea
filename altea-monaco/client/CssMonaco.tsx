import * as React from "react";
import { MonacoComponent } from "./MonacoComponent";

// The CSS flavour — the replacement for altea-codemirror's `CSSCodeMirror`. Monaco's CSS service is a real
// one (its own worker), so unlike the CodeMirror original this also reports a malformed rule.

export interface CssMonacoProps {
    script: string;
    onChange?: (script: string) => void;
    isReadOnly?: boolean;
    height?: number | string;
}

export default function CssMonaco(p: CssMonacoProps): React.JSX.Element {
    return (
        <MonacoComponent language="css"
            value={p.script}
            readOnly={p.isReadOnly}
            height={p.height ?? "14em"}
            onChange={p.onChange} />
    );
}
