import * as React from "react";
import { MonacoComponent, type Fence, type MonacoMarker, type MonacoEditor } from "./MonacoComponent";
import type { Monaco } from "./monaco";

// The TypeScript flavour, and the direct replacement for altea-codemirror's `TypeScriptCodeMirror`
// wherever a stored SCRIPT is edited (@altea/altea-eval).
//
// Thin on purpose: Monaco's TypeScript language service is configured GLOBALLY (see monaco.ts), not per
// editor, so a language "wrapper" here is a default language and nothing else. What makes the editor
// useful — the declarations the script is checked against — is supplied by whoever owns the script.

export interface TypeScriptMonacoProps {
    code: string;
    onChange?: (code: string) => void;
    /** Shown above the editable region, banded and uneditable; a `hidden` part is in the model only. */
    header?: Fence;
    /** Shown below it, same. */
    footer?: Fence;
    isReadOnly?: boolean;
    height?: number | string;
    path?: string;
    markers?: readonly MonacoMarker[];
    /** False for a FRAGMENT with no declarations — see `MonacoProps.semanticDiagnostics`. */
    semanticDiagnostics?: boolean;
    /** Shown on hover over the uneditable region. */
    fenceHint?: string;
    /** Labels of the link revealing the hidden parts — see `MonacoProps.hiddenToggle`. */
    hiddenToggle?: { show: string; hide: string };
    /** Run once the editor exists — see `MonacoProps.onMount`. */
    onMount?: (editor: MonacoEditor, monaco: Monaco) => void;
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
            hiddenToggle={p.hiddenToggle}
            onMount={p.onMount}
            onChange={p.onChange} />
    );
}
