import type * as React from "react";
import type { TypeContext } from "../TypeContext";

/**
 * The accessible name for a line's input when its LABEL is not visible (`formGroupStyle: "SrOnly"`).
 *
 * A `label` prop may be a React ELEMENT — an icon, a badge, a probability — and several altea views use
 * one (the predict view marks its two output boxes with a bullseye and a lightbulb). `String(element)`
 * on such a label yields the literal text "[object Object]", which reaches the DOM as the input's
 * accessible name and is worse than having none: a screen reader then announces "object Object" where it
 * would otherwise fall back to the surrounding structure.
 *
 * So a string label is used as-is, and anything else falls back to the property's own nice name — which
 * is what the label would have said had it been text.
 */
export function ariaLabelOf(label: React.ReactNode, ctx: TypeContext<unknown>): string | undefined {
    if (typeof label === "string")
        return label;
    if (typeof label === "number")
        return String(label);
    try {
        return ctx.niceName() || undefined;
    } catch {
        // A context built off a bare TypeReference has no property route to name (the FilterBuilder's
        // value editor, and the predict view's own value contexts).
        return undefined;
    }
}
