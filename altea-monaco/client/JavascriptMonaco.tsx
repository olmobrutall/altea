import * as React from "react";
import { MonacoComponent } from "./MonacoComponent";

// The JavaScript flavour — the replacement for altea-codemirror's `JavascriptCodeMirror`, and what
// altea-dynamic's view code is written in.
//
// A FRAGMENT: a view's expression, a `locals` block, the body of something the editor has never been
// handed declarations for. So the language service's semantic findings are dropped (see
// `MonacoProps.semanticDiagnostics`) — syntax, highlighting and completion remain.

export interface JavascriptMonacoProps {
    code: string;
    onChange?: (code: string) => void;
    isReadOnly?: boolean;
    height?: number | string;
}

export default function JavascriptMonaco(p: JavascriptMonacoProps): React.JSX.Element {
    return (
        <MonacoComponent language="javascript"
            value={p.code}
            readOnly={p.isReadOnly}
            height={p.height ?? "10em"}
            semanticDiagnostics={false}
            onChange={p.onChange} />
    );
}
