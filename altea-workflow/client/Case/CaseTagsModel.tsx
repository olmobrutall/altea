import * as React from "react";
import { EntityStrip } from "@altea/altea/client/Lines/EntityStrip";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { CaseTagsModel, CaseTagTypeEntity } from "../../data/Case";
import Tag from "./Tag";

// Port of Signum.Workflow's Case/CaseTagsModel.tsx — the "set tags" dialog: a strip of tags, each rendered as
// its own colored chip. Verbatim.

export default function CaseTagsModelComponent(p: { ctx: TypeContext<CaseTagsModel> }): React.JSX.Element {
    return (
        <EntityStrip ctx={p.ctx.subCtx(a => a.caseTags)}
            onItemHtmlAttributes={() => ({ style: { textDecoration: "none" } })}
            onRenderItem={tag => <Tag tag={tag as CaseTagTypeEntity} />} />
    );
}
