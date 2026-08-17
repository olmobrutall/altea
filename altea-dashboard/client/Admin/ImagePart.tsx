import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { ImagePartEntity } from "../../data/Parts";
import type { PartEditorProps } from "./PartEditor";

// Port of Signum's Signum.Dashboard/Admin/ImagePart.tsx.

export default function ImagePart(p: PartEditorProps<ImagePartEntity>): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formGroupStyle: "SrOnly", placeholderLabels: true });

    return (
        <div className="form-inline">
            <AutoLine ctx={ctx.subCtx(c => c.imageSrcContent)} />
            <AutoLine ctx={ctx.subCtx(c => c.clickActionURL)} />
            <AutoLine ctx={ctx.subCtx(c => c.altText)} />
        </div>
    );
}
