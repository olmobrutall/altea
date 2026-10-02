import * as React from "react";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { MonacoComponent } from "./MonacoComponent";

// The HTML flavour — the replacement for altea-codemirror's `HtmlCodeMirror`, and the one wrapper that
// binds a TypeContext rather than a raw string, because it edits an entity FIELD (an email template's
// body). Keeping that shape is what makes the migration a one-line swap at each call site.

export interface HtmlMonacoProps {
    ctx: TypeContext<string | null | undefined>;
    onChange?: (newValue: string) => void;
    height?: number | string;
}

export default function HtmlMonaco(p: HtmlMonacoProps): React.JSX.Element {
    const { ctx, onChange } = p;

    function handleChange(newValue: string): void {
        if (ctx.readOnly)
            return;
        ctx.value = newValue;
        onChange?.(newValue);
    }

    return (
        <MonacoComponent language="html"
            value={ctx.value ?? ""}
            readOnly={ctx.readOnly}
            height={p.height ?? "18em"}
            onChange={handleChange} />
    );
}
