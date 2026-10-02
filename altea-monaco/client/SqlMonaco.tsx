import * as React from "react";
import { MonacoComponent } from "./MonacoComponent";

// The SQL flavour — the replacement for altea-codemirror's `SqlCodeMirror`, which edits a stored migration.
//
// Monaco's SQL support is a TOKENIZER, not a language service: there is no dialect to pick (the CodeMirror
// original asked for MSSQL) and nothing validates the statement. That is the honest position for a script
// that may run against either provider.

export interface SqlMonacoProps {
    script: string;
    onChange?: (script: string) => void;
    isReadOnly?: boolean;
    height?: number | string;
}

export default function SqlMonaco(p: SqlMonacoProps): React.JSX.Element {
    return (
        <MonacoComponent language="sql"
            value={p.script}
            readOnly={p.isReadOnly}
            height={p.height ?? "14em"}
            onChange={p.onChange} />
    );
}
