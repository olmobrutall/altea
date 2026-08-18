import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { FileLine } from "@altea/altea-files/client/Components/FileLine";
import type { ImageAttachmentEntity } from "../../data/EmailTemplate";

// Port of Signum.Mailing's Templates/ImageAttachment.tsx — a fixed file attached to every message the
// template produces (typically an inline logo, as a LinkedResource referenced by `cid:`).
export default function ImageAttachment(p: { ctx: TypeContext<ImageAttachmentEntity> }): React.JSX.Element {
    const sc = p.ctx.subCtx({ formGroupStyle: "Basic" });

    return (
        <div className="row">
            <div className="col-sm-6">
                <AutoLine ctx={sc.subCtx(c => c.type)} />
                <AutoLine ctx={sc.subCtx(c => c.contentId)} />
            </div>
            <div className="col-sm-6">
                <FileLine ctx={sc.subCtx(c => c.file)} />
                <AutoLine ctx={sc.subCtx(c => c.fileName)} />
            </div>
        </div>
    );
}
