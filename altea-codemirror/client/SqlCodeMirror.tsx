import * as React from "react";
import type { Extension } from "@codemirror/state";
import { MSSQL, sql } from "@codemirror/lang-sql";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// Port of Signum.CodeMirror's SqlCodeMirror.tsx. See CodeMirrorComponent.tsx for the CM5 → CM6
// divergence. Signum's `mode: "text/x-mssql"` becomes the `MSSQL` dialect.
interface SqlCodeMirrorProps {
    script: string;
    onChange?: (newScript: string) => void;
    isReadOnly?: boolean;
    innerRef?: React.Ref<CodeMirrorComponentHandler>;
}

const extensions: Extension[] = [sql({ dialect: MSSQL }), commonKeymap];

export default function SqlCodeMirror(p: SqlCodeMirrorProps): React.JSX.Element {
    return (
        <CodeMirrorComponent value={p.script} ref={p.innerRef}
            extensions={extensions}
            readOnly={p.isReadOnly}
            onChange={p.isReadOnly ? undefined : p.onChange} />
    );
}
