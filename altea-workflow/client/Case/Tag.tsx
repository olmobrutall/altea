import * as React from "react";
import { Color } from "@altea/altea/client/Basics/Color";
import type { CaseTagTypeEntity } from "../../data/Case";
import "./Tag.css";

// Port of Signum.Workflow's Case/Tag.tsx — one colored case tag, its text and border derived from the stored
// color. Verbatim; `Color` now lives in altea core (it moved there from @altea/altea-chart for this port).

export default function Tag(p: { tag: CaseTagTypeEntity }): React.JSX.Element {
    const tag = p.tag;
    const color = Color.tryParse(tag.color) ?? Color.Black;

    return (
        <span className="case-tag" style={{
            color: color.opositePole().toString(),
            borderColor: color.lerp(0.5, Color.Black).toString(),
            backgroundColor: color.toString(),
        }} title={tag.name ?? ""}>{tag.name}</span>
    );
}
