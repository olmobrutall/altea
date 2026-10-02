import * as React from "react";
import { MonacoComponent, type MonacoMarker } from "./MonacoComponent";

// The TypeScript flavour, and the direct replacement for altea-codemirror's `TypeScriptCodeMirror`
// wherever a stored SCRIPT is edited (@altea/altea-eval).
//
// Thin on purpose: Monaco's TypeScript language service is configured GLOBALLY (see monaco.ts), not per
// editor, so a language "wrapper" here is a default language and nothing else. What makes the editor
// useful — the declarations the script is checked against — is supplied by whoever owns the script.

export interface TypeScriptMonacoProps {
    code: string;
    onChange?: (code: string) => void;
    /** Shown above the editable region, dimmed and uneditable: the generated imports and signature. */
    header?: string;
    /** Shown below it, same: the closing brace. */
    footer?: string;
    isReadOnly?: boolean;
    height?: number | string;
    path?: string;
    markers?: readonly MonacoMarker[];
    /** False for a FRAGMENT with no declarations — see `MonacoProps.semanticDiagnostics`. */
    semanticDiagnostics?: boolean;
    /** Shown on hover over the uneditable region. */
    fenceHint?: string;
}

export default function TypeScriptMonaco(p: TypeScriptMonacoProps): React.JSX.Element {
    return (
        <MonacoComponent language="typescript"
            value={p.code}
            header={p.header}
            footer={p.footer}
            readOnly={p.isReadOnly}
            height={p.height}
            path={p.path}
            markers={p.markers}
            semanticDiagnostics={p.semanticDiagnostics}
            fenceHint={p.fenceHint}
            onChange={p.onChange} />
    );
}
